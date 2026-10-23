package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io/fs"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
)

// packFrom 从目录收集清单声明的文件，与自身合成单文件产物。
// entry 为空时自动识别目录内唯一的 .js。
func packFrom(self, dir string, mf Manifest, out string) error {
	if mf.Entry == "" {
		mf.Entry = inferEntry(dir)
	}
	if mf.Entry == "" {
		return fmt.Errorf("无法确定入口：目录中需有唯一的 .js，或用 -entry 指定")
	}
	mf.defaults()

	// 入口保持原相对路径：改会破坏 bun build 生成的相对引用
	srcEntry := mf.Entry
	payload, err := buildPayload(mf, srcEntry, dir)
	if err != nil {
		return err
	}

	selfData, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	selfData = stripPayload(selfData)

	// 分两步写：先落纯净启动器并重签名，再追加 payload。
	//
	// Go 的 linker-signed 签名（flags 0x20002）在 macOS 上会被 AMFI 判为
	// "Unrecoverable CT signature issue"；一旦命中安全策略就被 SIGKILL。
	// 重新做 ad-hoc 签名（flags 0x2）即可修正，但 codesign 无法处理已经
	// 追加过数据的文件（main executable failed strict validation），
	// 而签名之后再追加字节不影响签名覆盖范围，所以顺序不能反。
	if err := os.WriteFile(out, selfData, 0o755); err != nil {
		return err
	}
	if err := resign(out); err != nil {
		return err
	}

	f, err := os.OpenFile(out, os.O_WRONLY|os.O_APPEND, 0o755)
	if err != nil {
		return err
	}
	_, err = f.Write(marker)
	if err == nil {
		_, err = f.Write(payload)
	}
	if closeErr := f.Close(); err != nil || closeErr != nil {
		if err != nil {
			return err
		}
		return closeErr
	}
	return os.Chmod(out, 0o755)
}

// resign 对未追加 payload 的启动器重新做 ad-hoc 签名，把 linker-signed
// （flags 0x20002）换成 adhoc（flags 0x2），避免 AMFI 判为签名损坏。
// 非 macOS 或缺 codesign 时跳过。
func resign(path string) error {
	if runtime.GOOS != "darwin" {
		return nil
	}
	codesign, err := exec.LookPath("codesign")
	if err != nil {
		return nil
	}
	cmd := exec.Command(codesign, "--force", "--sign", "-", path)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// stripPayload 截掉自身已有的 payload，保证可重复打包。
// marker 也出现在打包器代码的字符串常量里，因此必须校验其后紧跟 gzip 魔数。
func stripPayload(data []byte) []byte {
	for start := len(data); start > 0; {
		idx := bytes.LastIndex(data[:start], marker)
		if idx < 0 {
			return data
		}
		off := idx + len(marker)
		if off+2 <= len(data) && data[off] == 0x1f && data[off+1] == 0x8b {
			return data[:idx]
		}
		start = idx
	}
	return data
}

// buildPayload 按清单收集文件并打成 tar.gz。
func buildPayload(mf Manifest, srcEntry, dir string) ([]byte, error) {
	files, err := collectFiles(dir, mf, srcEntry)
	if err != nil {
		return nil, err
	}

	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)

	manifestJSON, err := json.MarshalIndent(mf, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := writeTarEntry(tw, manifestName, manifestJSON); err != nil {
		return nil, err
	}

	// 按相对路径写入，保持目录结构：解包后入口与资源仍处于原来的相对位置，
	// 因此 bun build 生成的 `import.meta.dir + "./xxx"` 引用无需改动即可命中。
	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		if err := writeTarEntry(tw, rel, data); err != nil {
			return nil, err
		}
	}

	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// collectFiles 递归收集需要打进 payload 的文件，返回相对构建目录的斜杠路径。
func collectFiles(dir string, mf Manifest, srcEntry string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == srcEntry || allowed(filepath.Base(rel), mf, "") {
			files = append(files, rel)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	return files, nil
}

// allowed 判断文件是否属于清单声明的资源类型（入口单独判断）。
func allowed(name string, mf Manifest, _ string) bool {
	ext := filepath.Ext(name)
	for _, e := range mf.Inline {
		if ext == e {
			return true
		}
	}
	for _, e := range mf.Native {
		if ext == e {
			return true
		}
	}
	return false
}

func writeTarEntry(tw *tar.Writer, name string, data []byte) error {
	hdr := &tar.Header{
		Name:     name,
		Mode:     0o644,
		Size:     int64(len(data)),
		Typeflag: tar.TypeReg,
	}
	if err := tw.WriteHeader(hdr); err != nil {
		return err
	}
	_, err := tw.Write(data)
	return err
}

// runBunBuild 调用 bun build 输出到 stage 目录。
//
// externals 中的包走 --external 不参与打包：多平台 napi 包会把各平台 .node
// 全部内联，体积膨胀数倍，因此由本工具按平台挑一个再放入 stage。
func runBunBuild(bun, target, entry, stage string, externals []string) error {
	args := []string{"build", entry, "--minify", "--target=" + target, "--outdir=" + stage}
	for _, pkg := range externals {
		args = append(args, "--external", pkg)
	}
	cmd := exec.Command(bun, args...)
	cmd.Stdout = os.Stderr
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// readPayload 把 payload 全量解到内存：name → 内容。
func readPayload(exe string, off int64) (map[string][]byte, error) {
	f, err := os.Open(exe)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return nil, err
	}
	gz, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	defer gz.Close()

	out := make(map[string][]byte)
	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		data, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		// 保留相对路径：入口与资源需维持原有相对位置
		out[filepath.ToSlash(filepath.Clean(hdr.Name))] = data
	}
}

// inferEntry 选出目录中唯一的 .js；有多个候选时返回空。
func inferEntry(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	var found string
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".js" {
			continue
		}
		if found != "" {
			return ""
		}
		found = e.Name()
	}
	return found
}
