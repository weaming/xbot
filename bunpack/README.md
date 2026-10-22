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

# 资源走 fd 注入，原生模块落盘
bunpack build src/main.ts -out ./app -name myapp \
    -inline .json -native .node -external my-addon \
    -env .json=MYAPP_CONFIG_FD -env .node=MYAPP_NATIVE_DIR

# 打包已有目录
bunpack pack ./dist -out ./app -name myapp
```

## 资源分派

| 类型 | 处理方式 | 是否落盘 |
| --- | --- | --- |
| 入口 JS | 传给子进程 fd 3 | 否 |
| `-inline` 资源 | fd 依次递增（4、5…），环境变量告知 fd 号 | 否 |
| `-native` 资源 | 按内容哈希解到缓存目录，环境变量告知目录 | 是 |

`-native` 必须落盘：napi 的 `dlopen` 只接受真实文件路径，无法从 fd 加载。

JS 侧按环境变量取值：

```ts
const fd = Number(process.env.MYAPP_CONFIG_FD);   // 从 fd 读资源
const dir = process.env.MYAPP_NATIVE_DIR;          // 原生模块所在目录
```

两者都是可选分支：未设置时退回普通文件路径或内置回退逻辑。

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

- 只压缩不加密：payload 是 gzip 压缩的 tar，解包即可读到源码。
  需要隐藏源码时用 `bun build --compile`
- 目标机需有 bun（或 `-runtime` 指定的运行时）
- 打包器代码含 marker 常量，判定 payload 时必须校验其后紧跟 gzip 魔数
- 一份产物只对应一个平台（`-external` 收集的是打包机的平台）
