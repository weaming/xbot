// bunpack 把 Bun 的 JS 程序打包成单文件可执行程序，运行时借用系统 bun。
//
// 同一个二进制既是启动器也是打包器：
//   ./app                      执行内嵌的 JS 程序
//   BUNPACK=1 ./app build ...  继续打包其他程序
//
// 这样打包器本身也能分发，不需要目标机额外安装 Go 工具链。
package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
)

// marker 分隔启动器与 payload；打包与解包必须一致。
var marker = []byte("\n__BUNPACK_PAYLOAD__\n")

// manifestName payload 内的清单文件名。
const manifestName = "bunpack.json"

func main() {
	// 当前可执行文件没有 payload 时，说明它还是原始打包器，走命令行分支
	exe, err := os.Executable()
	if err != nil {
		die("无法定位自身", err)
	}
	exe, _ = filepath.EvalSymlinks(exe)

	off, err := payloadOffset(exe)
	if err != nil {
		// 没有 payload：作为打包器/工具运行
		runCLI(exe)
		return
	}

	entries, err := readPayload(exe, off)
	if err != nil {
		// marker 可能只是代码里的常量而非真实 payload
		runCLI(exe)
		return
	}

	mf, err := readManifest(entries)
	if err != nil {
		die("读取清单失败", err)
	}

	// 产物自身也能继续打包：用环境变量触发，不占用命令行参数，
	// 避免与应用自己的子命令冲突
	if isPackMode() {
		runCLIArgs(exe, tailArgs())
		return
	}

	runApp(mf, entries)
}

func die(msg string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %s", displayName, msg)
	if err != nil {
		fmt.Fprintf(os.Stderr, ": %v", err)
	}
	fmt.Fprintln(os.Stderr)
	os.Exit(1)
}

// payloadOffset 返回 payload 起点。
//
// marker 同时存在于打包器自身的字符串常量里，因此必须校验其后紧跟 gzip 魔数，
// 否则会把代码段误认为 payload。
func payloadOffset(exe string) (int64, error) {
	data, err := os.ReadFile(exe)
	if err != nil {
		return 0, err
	}
	for start := len(data); ; {
		idx := bytes.LastIndex(data[:start], marker)
		if idx < 0 {
			return 0, os.ErrNotExist
		}
		off := idx + len(marker)
		if off+2 <= len(data) && data[off] == 0x1f && data[off+1] == 0x8b {
			return int64(off), nil
		}
		start = idx
	}
}
