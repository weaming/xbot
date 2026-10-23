package main

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
)

// runApp 按清单把资源分派给子进程，然后执行入口 JS。
func runApp(m *Manifest, entries map[string][]byte) {
	entry, ok := entries[m.Entry]
	if !ok {
		die("payload 缺少入口 "+m.Entry, nil)
	}

	// 本次运行的所有临时文件放在独立子目录里：
	// 正常情况下退出即整目录删除；即便被 SIGKILL 漏掉，
	// 残留也只是临时目录下的一个 bunpack-* 子目录，便于整体识别与清理，
	// 不会和系统临时文件混在一起。
	stage, err := os.MkdirTemp("", "bunpack-*")
	if err != nil {
		die("创建临时目录失败", err)
	}
	defer os.RemoveAll(stage)

	var extra []*os.File

	env := os.Environ()

	// 入口总是走 fd
	handle, err := stageFd(stage, m.Entry, entry)
	if err != nil {
		die("暂存入口失败", err)
	}
	extra = append(extra, handle)

	// 按清单分配剩余 fd，并设置对应的环境变量
	nextFD := m.EntryFD + 1
	for _, ext := range m.Inline {
		name, ok := findExt(entries, ext)
		if !ok {
			continue
		}
		handle, err := stageFd(stage, name, entries[name])
		if err != nil {
			die("暂存 "+name+" 失败", err)
		}
		// ExtraFiles[i] 对应子进程 fd (EntryFD+i)，先补齐空位再放置
		slot := nextFD - m.EntryFD
		for len(extra) <= slot {
			extra = append(extra, nil)
		}
		extra[slot] = handle
		if envName := m.InlineEnv[ext]; envName != "" {
			env = append(env, envName+"="+strconv.Itoa(nextFD))
		}
		nextFD++
	}

	// 原生模块等必须落盘的资源
	for _, ext := range m.Native {
		name, ok := findExt(entries, ext)
		if !ok {
			continue
		}
		dir, err := writeCached(m.Name, name, entries[name])
		if err != nil {
			die("写入 "+name+" 失败", err)
		}
		if m.NativeEnv != "" {
			env = append(env, m.NativeEnv+"="+dir)
		}
	}

	for k, v := range m.RuntimeEnv {
		env = append(env, k+"="+v)
	}

	rtPath, ok := findRuntime(m.Runtime)
	if !ok {
		fmt.Fprintf(os.Stderr, "%s: 未找到运行时 %s\n", m.Name, m.Runtime)
		if m.Runtime == "bun" {
			fmt.Fprintln(os.Stderr, "  安装: curl -fsSL https://bun.sh/install | bash")
		}
		os.Exit(127)
	}

	cmd := exec.Command(rtPath, "/dev/fd/"+strconv.Itoa(m.EntryFD))
	cmd.Args = append(cmd.Args, os.Args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = env
	cmd.ExtraFiles = extra

	if err := cmd.Run(); err != nil {
		die(m.Runtime+" 执行失败", err)
	}
}

// findExt 返回 payload 中匹配扩展名的条目名。
// map 迭代顺序随机，因此按名字排序后取第一个，保证同一产物每次结果一致。
// 需排除清单本身：-inline .json 会匹配到 bunpack.json，那只是元数据不是资源。
func findExt(entries map[string][]byte, ext string) (string, bool) {
	names := make([]string, 0, len(entries))
	for name := range entries {
		if name == manifestName {
			continue
		}
		if filepath.Ext(name) == ext {
			names = append(names, name)
		}
	}
	if len(names) == 0 {
		return "", false
	}
	sort.Strings(names)
	return names[0], true
}

// stageFd 把内容写入 stage 目录下的文件，返回可传给子进程的句柄。
//
// 文件必须保留路径：Bun 收到 /dev/fd/N 参数时会解析回真实路径再打开，
// 提前 unlink 会报 Module not found（实测）。因此文件随 stage 目录一起，
// 由 runApp 的 defer 整目录清理。
func stageFd(stage, name string, data []byte) (*os.File, error) {
	path := filepath.Join(stage, filepath.FromSlash(name))
	// rel 可能带子目录，先建好父级
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return nil, err
	}
	if _, err := f.Seek(0, 0); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

// writeCached 把必须落盘的资源按内容哈希写入缓存，返回其目录。
func writeCached(app, name string, data []byte) (string, error) {
	sum := sha256.Sum256(data)
	dir := filepath.Join(cacheRoot(), app, hex.EncodeToString(sum[:])[:16])
	path := filepath.Join(dir, name)
	if _, err := os.Stat(path); err == nil {
		return dir, nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	return dir, os.WriteFile(path, data, 0o644)
}

// cacheRoot 遵循 XDG 约定，可用 BUNPACK_CACHE_DIR 覆盖。
func cacheRoot() string {
	if v := os.Getenv("BUNPACK_CACHE_DIR"); v != "" {
		return v
	}
	if v := os.Getenv("XDG_CACHE_HOME"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".cache")
}

// findRuntime 在 PATH 与常见安装位置查找运行时。
func findRuntime(name string) (string, bool) {
	if p, err := exec.LookPath(name); err == nil {
		return p, true
	}
	var cands []string
	if v := os.Getenv("BUN_INSTALL"); v != "" {
		cands = append(cands, filepath.Join(v, "bin", name))
	}
	if h := os.Getenv("HOME"); h != "" {
		cands = append(cands, filepath.Join(h, ".bun", "bin", name))
	}
	cands = append(cands,
		filepath.Join("/opt/homebrew/bin", name),
		filepath.Join("/usr/local/bin", name),
		filepath.Join("/usr/bin", name),
	)
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() && st.Mode()&0o111 != 0 {
			return c, true
		}
	}
	return "", false
}
