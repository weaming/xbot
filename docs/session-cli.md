# 会话命令行

`zbot session <子命令>` 直接读写 `$ZBOT_STATE_DIR`（默认 `~/.zbot`）下的会话，用于让其他 AI 或脚本操作会话，而不必进入 TUI。

```sh
zbot session list                 # 未归档会话（● 运行中 / 空闲）
zbot session list --all --json    # 含归档，结构化输出
zbot session show <id>            # 元信息 + 最近 3 轮消息
zbot session show <id> --all --full --json
zbot session new --title "排查 CI" --cwd ~/src/infra
zbot session rename <id> "新标题"
zbot session archive <id>
zbot session unarchive <id>
zbot session delete <id>
zbot session send <id> "跑一下测试" --wait=300
```

`id` 支持完整 id、唯一前缀或末几位；歧义会列出候选并报错。

## 读写规则

- `list` / `show` 只读事件日志，任何时候都能执行，会话正被 TUI 打开也安全。
- `new` / `rename` / `archive` / `unarchive` / `delete` 要求目标会话**没有被任何实例持有**（控制 socket 无监听者），否则拒绝并提示去持有它的实例里操作。写入在会话锁内完成，避免与 TUI 双写事件序列。
- `send` 是唯一要求"有实例持有"的子命令：它通过控制 socket 把消息投递给运行中的会话；不带 `--wait` 时只投递不等结果（结果不会回传），带 `--wait[=秒]` 时把对方回合的最终输出打到 stdout（默认等 300 秒）。
- 新建的会话不会被认领，等 TUI 打开它才真正开始执行。

## 输出

默认人类可读；`--json` 给结构化数据，字段取自事件流派生的会话摘要（`sessionId` / `title` / `cwd` / `turns` / `createdAt` / `updatedAt` / `archived` / `status` / `holderPid` / `busy`）。
