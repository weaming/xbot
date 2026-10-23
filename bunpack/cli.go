package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// displayName 是帮助文本与错误信息里展示的命令名。
// 目前固定为 bunpack，需要时集中在此处修改。
const displayName = "bunpack"

// usage 打印用法，cmd 为帮助里展示的命令名。
func usage(cmd string) {
	fmt.Fprintf(os.Stderr, `%[1]s — 把 Bun 的 JS/TS 程序打成单文件，运行时借用系统 bun

用法:
  %[1]s build <入口文件> -out <文件> [选项]    构建并打包
  %[1]s pack <目录> -out <文件> [选项]         只打包已有产物

通用选项:
  -out <file>      输出文件（必填）
  -name <string>   应用名，用于提示与缓存目录，默认取入口文件名
  -inline <exts>   随产物分发的资源扩展名，逗号分隔（相对路径即可读取）
  -native <exts>   必须落盘到缓存目录的资源扩展名，逗号分隔
  -external <pkgs> 交给 bun 的 --external 并由本工具收集本机原生模块的包名，逗号分隔
  -env <ext=VAR>   资源位置对应的环境变量名，仅 -native 需要（可重复）
  -runtime <cmd>   目标机运行时命令，默认 bun

仅 build:
  -bun <path>      bun 可执行文件，默认从 PATH 查找
  -target <triple> bun build 的 target，默认 bun
  -workdir <dir>   查找 node_modules 的目录，默认当前目录

仅 pack:
  -entry <file>    入口 JS 文件名，默认取目录中唯一的 .js

资源如何交给程序:
  • payload 保留构建目录的相对结构，运行时解到临时目录，
    退出即整目录删除；入口与资源维持原有相对位置。
  • 因此代码里按相对路径读取即可（配合 import.meta.dir），
    不需要环境变量或特殊 API，子目录层级同样保留。
  • -native 资源必须落盘：napi 的 dlopen 只接受真实文件路径。
    本工具按内容哈希解到缓存目录，-env 用来告知该目录。
  • -external 的包由本工具按 GOOS/GOARCH 挑出单个原生模块，
    避免多平台版本全部内联导致体积膨胀。

示例:
  # 无资源依赖
  %[1]s build src/index.ts -out ./app

  # 带资源；有原生模块时声明 -external
  %[1]s build src/main.ts -out ./app -name myapp \
      -inline .json -native .node -external my-addon \
      -env .node=MYAPP_NATIVE_DIR

  # 打包已有构建产物
  %[1]s pack ./dist -out ./app -name myapp

产物继续打包:
  BUNPACK=1 ./app build <入口文件> -out <文件>
  用环境变量触发打包模式，不占用程序自身的命令行参数。

要求:
  • 目标机需有 bun（或 -runtime 指定的运行时）
  • 需隐藏源码时应改用 bun build --compile：本工具只压缩不加密，
    payload 是 gzip 压缩的 tar，解包即可读到 JS 源码
`, cmd)
}

// packModeEnv 是产物进入打包模式的环境变量开关。
const packModeEnv = "BUNPACK"

// isPackMode 判断当前是否以打包器身份运行。
func isPackMode() bool {
	v := strings.ToLower(os.Getenv(packModeEnv))
	return v == "1" || v == "true" || v == "yes"
}

// runCLI 解析参数并执行。
func runCLI(self string) {
	runCLIArgs(self, tailArgs())
}

// tailArgs 返回子命令及其参数，避免短参数下标越界。
func tailArgs() []string {
	if len(os.Args) <= 1 {
		return nil
	}
	return os.Args[1:]
}

// runCLIArgs 按子命令分派。
func runCLIArgs(self string, args []string) {
	if len(args) == 0 {
		usage(displayName)
		os.Exit(2)
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "build":
		doBuild(self, rest)
	case "pack":
		doPack(self, rest)
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n\n", cmd)
		usage(displayName)
		os.Exit(2)
	}
}

// commonOpts 是 build 与 pack 共享的参数。
type commonOpts struct {
	out       string
	name      string
	inline    string
	native    string
	external  string
	runtime   string
	envValues []string
	workDir   string
}

func (c *commonOpts) bind(fs *flag.FlagSet) {
	fs.StringVar(&c.out, "out", "", "输出文件")
	fs.StringVar(&c.name, "name", "", "应用名")
	fs.StringVar(&c.inline, "inline", "", "随产物分发的资源扩展名，逗号分隔")
	fs.StringVar(&c.native, "native", ".node", "必须落盘到缓存目录的扩展名，逗号分隔")
	fs.StringVar(&c.external, "external", "", "走 --external 并自动收集本机 .node 的包，逗号分隔")
	fs.StringVar(&c.runtime, "runtime", "", "运行时命令，默认 bun")
	fs.StringVar(&c.workDir, "workdir", ".", "查找 node_modules 的目录")
	fs.Var((*multiFlag)(&c.envValues), "env", "位置对应的环境变量 ext=VAR，仅 -native 需要（可重复）")
}

// manifest 依据参数构造清单。
func (c *commonOpts) manifest(appName, entry string) Manifest {
	mf := Manifest{
		Name:      appName,
		Entry:     entry,
		Inline:    splitCSV(c.inline),
		Native:    splitCSV(c.native),
		InlineEnv: map[string]string{},
		Runtime:   c.runtime,
	}
	for _, kv := range c.envValues {
		k, v, ok := strings.Cut(kv, "=")
		if !ok {
			fmt.Fprintf(os.Stderr, "无效的 -env: %s\n", kv)
			os.Exit(2)
		}
		// 与 native 扩展名匹配的 -env 指向落盘目录，其余指向 fd
		if isExtIn(k, mf.Native) || k == "native" {
			mf.NativeEnv = v
			continue
		}
		mf.InlineEnv[k] = v
	}
	return mf
}

// doBuild 运行 bun build，再把结果打成单文件。
func doBuild(self string, args []string) {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	var opts commonOpts
	opts.bind(fs)
	bunPath := fs.String("bun", "", "bun 可执行文件")
	target := fs.String("target", "bun", "bun build 的 target")

	// 位置参数（入口文件）可出现在任意位置，flag 包只认前置，故先重排
	flags, positional := reorderArgs(args)
	if err := fs.Parse(flags); err != nil {
		os.Exit(2)
	}
	if len(positional) == 0 {
		fmt.Fprintln(os.Stderr, "缺少入口文件")
		usage(displayName)
		os.Exit(2)
	}
	entryPath := positional[0]
	if opts.out == "" {
		fmt.Fprintln(os.Stderr, "缺少 -out")
		os.Exit(2)
	}

	name := *bunPath
	if name == "" {
		name = "bun"
	}
	bun, ok := findRuntime(name)
	if !ok {
		fmt.Fprintln(os.Stderr, "未找到 bun")
		os.Exit(127)
	}

	stage, err := os.MkdirTemp("", "bunpack-build-*")
	if err != nil {
		die("创建临时目录失败", err)
	}
	defer os.RemoveAll(stage)

	externals := splitCSV(opts.external)
	if err := runBunBuild(bun, *target, entryPath, stage, externals); err != nil {
		die("bun build 失败", err)
	}

	// 把声明的包在本机平台的原生模块复制进 stage：它们被 --external 跳过了
	if err := collectNative(stage, externals, opts.workDir); err != nil {
		die("收集原生模块失败", err)
	}

	appName := opts.name
	if appName == "" {
		appName = strings.TrimSuffix(filepath.Base(entryPath), filepath.Ext(entryPath))
	}
	if err := packFrom(self, stage, opts.manifest(appName, ""), opts.out); err != nil {
		die("打包失败", err)
	}
	fmt.Printf("%s → %s\n", entryPath, opts.out)
}

// doPack 打包已有目录。
func doPack(self string, args []string) {
	fs := flag.NewFlagSet("pack", flag.ExitOnError)
	var opts commonOpts
	opts.bind(fs)
	entry := fs.String("entry", "", "入口 JS 文件名")

	flags, positional := reorderArgs(args)
	if err := fs.Parse(flags); err != nil {
		os.Exit(2)
	}
	if len(positional) == 0 {
		fmt.Fprintln(os.Stderr, "缺少构建目录")
		usage(displayName)
		os.Exit(2)
	}
	dir := positional[0]

	appName := opts.name
	if appName == "" {
		appName = "app"
	}
	out := opts.out
	if out == "" {
		out = filepath.Join(dir, appName)
	}

	mf := opts.manifest(appName, *entry)
	if err := packFrom(self, dir, mf, out); err != nil {
		die("打包失败", err)
	}
	fmt.Printf("%s → %s\n", dir, out)
}

// multiFlag 收集可重复的 -env 参数。
type multiFlag []string

func (m *multiFlag) String() string { return strings.Join(*m, ",") }
func (m *multiFlag) Set(v string) error {
	*m = append(*m, v)
	return nil
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// reorderArgs 把位置参数移到末尾，使 flag 能解析任意顺序的选项。
// 需要区分 "-name value" 这类带值选项，否则其值会被误判为位置参数。
func reorderArgs(args []string) (flags, positional []string) {
	// flag 包要求已知哪个选项带值，这里按本工具的定义硬编码
	withValue := map[string]bool{
		"-out": true, "-name": true, "-entry": true, "-inline": true,
		"-native": true, "-env": true, "-runtime": true, "-bun": true,
		"-target": true, "-external": true, "-workdir": true,
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
			continue
		}
		flags = append(flags, a)
		if withValue[a] && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return flags, positional
}

// isExtIn 判断 k 是否是列表中的扩展名。
func isExtIn(k string, exts []string) bool {
	for _, e := range exts {
		if k == e {
			return true
		}
	}
	return false
}
