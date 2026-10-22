package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
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

	// 入口在 payload 内统一以 main.js 存放，清单随之固定；
	// 只在打包时改名，不改动源目录
	srcEntry := mf.Entry
	mf.Entry = entryName
	payload, err := buildPayload(mf, srcEntry, dir)
	if err != nil {
		return err
	}

	selfData, err := os.ReadFile(self)
	if err != nil {
		return err
	}
	selfData = stripPayload(selfData)

	outData := append(selfData, marker...)
	outData = append(outData, payload...)

	if err := os.WriteFile(out, outData, 0o755); err != nil {
		return err
	}
	return os.Chmod(out, 0o755)
}

// entryName 是产物内固定的入口文件名。
const entryName = "main.js"

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
	entries, err := os.ReadDir(dir)
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

	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !allowed(e.Name(), mf, srcEntry) {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)

	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			return nil, err
		}
		// 入口在产物内固定为 main.js，源文件名不必改变
		entry := name
		if name == srcEntry {
			entry = entryName
		}
		if err := writeTarEntry(tw, entry, data); err != nil {
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

// allowed 判断文件是否属于声明的入口或资源类型。
func allowed(name string, mf Manifest, srcEntry string) bool {
	if name == srcEntry {
		return true
	}
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
		out[filepath.Base(hdr.Name)] = data
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
