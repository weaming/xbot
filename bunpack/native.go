package main

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// nativeArch 返回常见 napi 包使用的架构名。
// Linux 下部分包按 libc 区分，默认按 gnu 变体查找。
func nativeArch() string {
	arch := runtime.GOARCH
	if runtime.GOOS == "linux" {
		return arch + "-gnu"
	}
	return arch
}

// resolveNative 为指定包挑选本机平台的原生模块。
//
// 多平台 napi 包会随包发布各平台的 .node，
// bun build 全量内联会显著增大产物，因此按 GOOS/GOARCH 只取一个。
// 返回源文件路径与建议的输出名；找不到时 second 为空。
func resolveNative(pkg, workDir string) (src, name string, ok bool) {
	dir := filepath.Join(workDir, "node_modules", pkg)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "", "", false
	}

	// 优先匹配 <pkg>.<os>-<arch>.node，其次 <pkg>.<arch>.node
	want := []string{
		pkg + "." + runtime.GOOS + "-" + nativeArch() + ".node",
		pkg + "." + runtime.GOOS + "-" + runtime.GOARCH + ".node",
		pkg + "." + runtime.GOARCH + ".node",
	}
	for _, w := range want {
		p := filepath.Join(dir, w)
		if _, err := os.Stat(p); err == nil {
			return p, pkg + ".node", true
		}
	}

	// 兜底：目录内只有一个 .node 时直接用它（普通单原生包是常态）
	var only string
	count := 0
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".node") {
			continue
		}
		only = e.Name()
		count++
	}
	if count == 1 {
		return filepath.Join(dir, only), pkg + ".node", true
	}
	return "", "", false
}

// collectNative 把声明的包的原生模块复制进 stage。
func collectNative(stage string, pkgs []string, workDir string) error {
	for _, pkg := range pkgs {
		src, name, ok := resolveNative(pkg, workDir)
		if !ok {
			continue
		}
		if err := copyFile(src, filepath.Join(stage, name)); err != nil {
			return err
		}
	}
	return nil
}

func copyFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0o644)
}
