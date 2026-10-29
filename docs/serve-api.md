# serve 接口

`zbot serve` 是无 UI 的长驻宿主：它与会话 TUI 各自组装同一个 `SessionHost`，两者互不依赖，可同时运行（会话归属由控制 socket 互斥）。

## 启动

```sh
zbot serve [--port 8787] [--bind 127.0.0.1] [--cwd <目录>] [--token <令牌>]
```

- 默认只绑 `127.0.0.1`。
- `--cwd` 是新建会话与工具的默认基准。
- 令牌优先级：`--token` > `ZBOT_SERVE_TOKEN` > `~/.zbot/serve/token`（首次启动自动生成，权限 0600）。
- 请求带 `Authorization: Bearer <token>`；SSE 用 `?token=<token>`（EventSource 不能自定义 header）。

## 路由

| 方法与路径 | 说明 |
| --- | --- |
| `GET /` | 端点清单 |
| `GET /healthz` | 存活与活跃会话数 |
| `GET /sessions` | 会话摘要列表 |
| `POST /sessions` | 建会话并立即认领，body `{cwd?, title?}`，返回 `{sessionId}` |
| `GET /sessions/:id` | 单个会话摘要，不存在 404 |
| `GET /sessions/:id/events?since=<seq>` | 事件流（SSE）；加 `format=json` 一次性拉取 |
| `POST /sessions/:id/messages` | body `{text, wait?}`；不带 `wait` 返回 202 并后台执行，带 `wait: true` 等到回合结束 |
| `POST /sessions/:id/cancel` | 中止当前回合 |

## 行为约定

- **事件流推持久化事实**：每帧带 `id: <seq>` 与 `data: <AgentEvent JSON>`，可用 `Last-Event-ID`（重连时优先）或 `since` 断线续传；瞬态的逐 token 片段不在此接口范围。
- **一次性拉取**：`?format=json` 返回 `AgentEvent[]`（与 SSE 的 `data` 同形状），按 `since` 过滤。
- **不漏不重**：服务端先订阅、后回放，回放期间到达的事件进缓冲，回放结束后按 seq 去重补推。
- **忙时拒绝**：会话已有回合在跑时 `POST .../messages` 返回 409，不会排队。
- **不夺权**：会话被其他实例（另一个 TUI / serve）持有时同样返回 409，本服务不做协商式接管。
- **202 只代表已受理**：不带 `wait` 时后台执行，失败只写服务端日志；要结果就带 `wait: true`。
- **回合结果**：`wait: true` 返回 `{ok, aborted}`；`aborted: true` 表示回合被取消（不是失败）。
- **心跳**：空闲每 15s 发一行 SSE 注释（`: ping`），服务端禁用空闲超时以便长连接停留。

## 时间轴重置

会话被 `truncate`（时间点恢复）或 `delete` 时，服务端下发具名事件并把游标归零：

```
id: 0
event: reset
data: {}
```

`EventSource` 的 `onmessage` 收不到具名事件，客户端需要 `addEventListener("reset", ...)`，收到后清空本地状态。`id: 0` 让浏览器的 `Last-Event-ID` 一并归零，避免重连时带着失效游标永久静默。

用 `format=json` 一次性拉取的客户端没有推送通道可依赖：truncate 后旧游标只会一直返回空数组，客户端需自行用「返回为空且会话仍在推进」或「`max(seq)` 变小」判定游标失效，并从 `since=0` 重取。

`GET /sessions/:id/events` 对未知会话返回空流（不报 404），因为事件流是「订阅该 id 的时间轴」，会话之后可能被创建。

## 错误码

| 状态 | 含义 |
| --- | --- |
| 400 | `text` 为空，或 `since` 不是非负整数 |
| 401 | 令牌缺失或错误 |
| 404 | 路径不存在或会话不存在 |
| 405 | 方法不支持 |
| 409 | 会话正在执行中 / 已归档需先取消归档 / 由其他实例持有 |
| 500 | 服务端内部错误（细节只写服务端日志） |
