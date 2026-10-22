# macOS 代码签名与 bunpack

macOS arm64 要求可执行文件**必须有签名结构**（Mach-O 里存在 `LC_CODE_SIGNATURE`），否则内核直接 `SIGKILL`。签名是否「完美」不是硬性条件，但没有签名一定不行。

单文件产物曾偶发启动即 `Killed: 9`，排查后确认与追加 payload 的时机有关。现在的做法是先重签再追加，产物落在结构完整的 adhoc 签名上。

## 报错长什么样

进程被内核直接杀掉，终端只显示：

```
zsh: killed     ./xbot
```

系统日志（`log show --predicate 'eventMessage CONTAINS "xbot"' --last 5m`）给出真实原因：

```
AMFI: 'xbot' has no CMS blob?
AMFI: 'xbot': Unrecoverable CT signature issue, bailing out.
ASP: Security policy would not allow process: /Users/.../xbot
```

注意不是崩溃，是**没启动起来**。

## AMFI 做什么

AppleMobileFileIntegrity 是内核里强制执行代码签名的子系统。`execve` 之前先校验，**没有签名结构就拒绝加载**，进程变成 corpse 并收到 SIGKILL。签名存在但结构有瑕疵时通常只记日志（见下方实测）。

```
用户执行 ./xbot
    ↓
内核 execve
    ↓
AMFI 校验签名 ──失败──→ SIGKILL
    ↓ 通过
加载 Mach-O，程序开始跑
```

macOS 11 起 arm64 强制要求有效签名，x86_64 相对宽松。

## 签名在二进制里的位置

签名嵌在 Mach-O 内部，由 `LC_CODE_SIGNATURE` 指向：

```
┌──────────────────────────┐
│ Mach-O Header            │
│ Load Commands            │
│   └ LC_CODE_SIGNATURE ───┼──→ dataoff=3181504, datasize=24978
├──────────────────────────┤
│ __TEXT / __DATA ...      │
├──────────────────────────┤
│ 签名数据                  │   offsets [3181504, 3206482)
│ CodeDirectory + hashes   │
└──────────────────────────┘
```

`CodeDirectory` 把文件按 4096 字节分页，逐页记 SHA-256。内核运行时重算比对。

**这解释了为什么追加 payload 是安全的**：追加的字节落在 `dataoff + datasize` 之后，不在哈希覆盖范围内。

## 三种签名

| 类型 | flags | 证书 | AMFI 日志 | 能否运行 |
| --- | --- | --- | --- | --- |
| 无签名 | 无 CodeDirectory | — | — | ❌ SIGKILL |
| linker-signed | `0x20002` | 无 | `Unrecoverable CT signature issue` | ✅ 已验证可运行 |
| adhoc | `0x2` | 无 | `is adhoc signed` | ✅ |
| Developer ID | `0x10000` | 有 | 正常 | ✅ 需公证过 Gatekeeper |

**linker-signed** 是 Go / clang 链接器发现「系统要求签名」后自动补的最小签名。它没有 CMS blob，AMFI 每次都记一条 `Unrecoverable CT signature issue`，但这**是警告级日志，不影响加载**——实测 C 程序（33KB）与 Go 程序（3.2MB）连续多次运行均正常（见 [golang/go#69212](https://github.com/golang/go/issues/69212) 的历史讨论）。

代价在排障：这条假警告会持续刷屏，真正的拦截（`ASP: Security policy would not allow process`）反而被淹没。

**adhoc** 是无证书但结构完整的签名，适合本地构建与内部分发，能过 AMFI 基础校验（但过不了 Gatekeeper）。

## 实测：什么情况才会被 kill

在同一台机器上对同一份 Mach-O 分别处理后运行：

| 操作 | CodeDirectory | 结果 |
| --- | --- | --- |
| `codesign --remove-signature` | 不存在 | **137（SIGKILL）** |
| 保持链接器产物（linker-signed） | `0x20002` | 正常，连续 3 次 exit=0 |
| `codesign --force --sign -`（adhoc） | `0x2` | 正常 |

C 程序（33KB）与 Go 程序（3.2MB）的 linker-signed 版本都能稳定运行，并且都会触发 `Unrecoverable CT signature issue` 日志。

**结论**：硬性要求是「存在 CodeDirectory」，不是「签名无瑕疵」。

查当前产物的签名级别：

```fish
codesign -dvvv xbot | grep CodeDirectory
# flags=0x20002(linker-signed)   ← 有缺陷
# flags=0x2(adhoc)               ← 正常
```

## 为什么必须在追加前签名

`codesign` 签名前会校验 Mach-O 结构自洽。文件追加过数据后它会拒绝：

```
$ codesign --force --sign - xbot
xbot: main executable failed strict validation
```

且**静默失败**——退出码 0，文件一个字节没改。只能靠 `flags` 判断是否真的签上。

签名覆盖 `[0, dataoff+datasize)`，之后追加的字节不在范围内：

```
签名覆盖范围 ─────────┐
[启动器代码 + 签名]   │ [marker + payload]   ← 不被校验
                      └─────────────────
```

所以顺序不能反：

```
✅ 先签 → 后追加    签名有效
❌ 先追加 → 后签    codesign 拒绝
```

## bunpack 的实现

`bunpack/pack.go` 分两步写产物：

```go
// ① 写纯净启动器
os.WriteFile(out, selfData, 0o755)
// ② 重签，把 flags 0x20002 换成 0x2
resign(out)
// ③ 追加 marker 与 payload
os.OpenFile(out, os.O_WRONLY|os.O_APPEND, 0o755)
```

`resign` 只在 darwin 上执行，缺 `codesign` 时静默跳过：

```go
func resign(path string) error {
    if runtime.GOOS != "darwin" {
        return nil
    }
    codesign, err := exec.LookPath("codesign")
    if err != nil {
        return nil
    }
    return exec.Command(codesign, "--force", "--sign", "-", path).Run()
}
```

## 验证

```fish
# 签名级别
codesign -dvvv ~/.bun/bin/xbot | grep CodeDirectory

# 是否被 AMFI 拦截（应输出 is adhoc signed）
log show --predicate 'eventMessage CONTAINS "xbot"' --last 1m | grep AMFI

# 连续启动（124 是超时，表示正常运行）
for i in 1 2 3
    timeout 4 ~/.bun/bin/xbot </dev/null >/dev/null 2>&1
    echo "run$i=$?"
end
```

产物 5.6MB，`flags=0x2(adhoc)`，AMFI 记 `is adhoc signed`，多次启动稳定。

## 为什么仍然要重签

linker-signed 能运行，改造为 adhoc 不是为了让程序「能跑」，而是：

- **消除日志噪声**：每次启动都刷 `Unrecoverable CT signature issue`，会淹没真正的拦截记录
- **策略收紧时更安全**：系统版本升级后对签名完整性的要求可能变严
- **与应用签名习惯一致**：`flags=0x2` 是本地构建的标准形态
