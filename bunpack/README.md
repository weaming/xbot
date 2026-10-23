# bunpack

把 Bun 的 JS/TS 程序打成单文件可执行程序，运行时借用系统已安装的 bun。

同一个二进制既是打包器也是启动器：没有 payload 时走命令行，有 payload 时执行内嵌程序。

打包后的产物同样能继续打包，用环境变量触发，不占用应用自己的命令行参数：

```sh
BUNPACK=1 ./app build src/index.ts -out ./other
```

## 为什么不直接用 `bun build --compile`

`--compile` 会把约 60MB 的 Bun 运行时复制进产物。bunpack 借用目标机已有的 bun。

| 方式 | 产物 | 需要 bun |
| --- | --- | --- |
| `bun build --compile` | 66 MB | 否 |
| bunpack | 1.6 MB（无原生依赖） | 是 |

## 用法

```sh
# 最简单：无原生依赖
bunpack build src/index.ts -out ./app

# 带资源；有原生模块时再声明 -external
bunpack build src/main.ts -out ./app -name myapp \
    -inline .json -native .node -external my-addon

# 打包已有目录
bunpack pack ./dist -out ./app -name myapp
```

## 资源的组织方式

payload 按**相对路径**保留构建目录的结构，运行前解到临时目录
（`$TMPDIR/bunpack-<随机>/`），进程退出即整个目录删除。

入口与资源保持原有的相对位置，所以代码里直接按相对路径读取即可，
不需要任何环境变量或特殊 API：

```ts
import path from "node:path";

// bun build 把资源引用生成为相对路径，配合 import.meta.dir 定位
const file = path.resolve(import.meta.dir, "./config.json");
const config = JSON.parse(fs.readFileSync(file, "utf8"));
```

目录层级同样保留，子目录里的资源写 `"../assets/x.json"` 也能命中。

`-native` 资源（`.node`）必须落盘：napi 的 `dlopen` 只接受真实文件路径。
它们按内容哈希解到 `$XDG_CACHE_HOME/<name>/<hash>/`，路径通过
`-env .node=MYAPP_NATIVE_DIR` 告知，同一份内容只解一次。

## 原生模块

`-external <pkg>` 让包走 `bun build --external`，再由 bunpack 按 `GOOS/GOARCH`
从 `node_modules/<pkg>` 里挑选**单个**平台的 `.node` 放入产物。

多平台 napi 包会随包发布各平台的二进制，全部内联会让产物膨胀数倍。
声明后只保留本机那一个。

查找顺序：`<pkg>.<os>-<arch>.node` → `<pkg>.<os>-<arch>.node`（含 libc）
→ `<pkg>.<arch>.node` → 目录内唯一的 `.node` → `<pkg>.node` / `index.node`。

## 运行时查找

按 `PATH` → `BUN_INSTALL` → `~/.bun/bin` → 系统常见路径依次探测。
GUI 启动（Finder、launchd）的 PATH 不含 `~/.bun/bin`，因此不能只依赖 `PATH`。

## 缓存

`-native` 资源按内容哈希缓存到 `$XDG_CACHE_HOME/<name>/<hash>/`，
可用 `BUNPACK_CACHE_DIR` 覆盖。内容变化时哈希变化，旧缓存自然失效。

## 限制

- 运行时会把 payload 解到 `$TMPDIR/bunpack-<随机>/`，退出即删。
  进程被 `SIGKILL` 时该目录会残留，可用 `rm -rf $TMPDIR/bunpack-*` 清理
- 只压缩不加密：payload 是 gzip 压缩的 tar，解包即可读到源码。
  需要隐藏源码时用 `bun build --compile`
- 目标机需有 bun（或 `-runtime` 指定的运行时）
- 打包器代码含 marker 常量，判定 payload 时必须校验其后紧跟 gzip 魔数
- 一份产物只对应一个平台（`-external` 收集的是打包机的平台）
