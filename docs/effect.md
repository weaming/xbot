# Effect 使用边界（zbot）

Effect 在这里只承担一件事：**把长驻异步的并发、定时器与生命周期讲清楚**。不做依赖注入改造，不做全仓重写。

## 为什么引入

zbot 是常驻宿主 + TUI + 任务调度三合一的进程，难点从来不是请求怎么写，而是：

- 谁在跑、跑多久、被谁打断（回合、job、后台 shell、watchdog）；
- 定时器和监听器有没有人清（原来散落在 `finally` 里的 `clearInterval` / `clearTimeout` / `removeEventListener`）；
- 停机时有没有把在跑的东西等差、差多久（原来靠 50ms 轮询 + deadline）。

这三件事正好是 Effect 的作用域（`Scope`）、结构化并发（fiber 中断）与调度（`Effect.sleep` + `race`）覆盖的部分。

## 分层规则

- 允许写 Effect：`jobs/`、`tools/`、`control/`、`mcp/`、`services/` 的**内核**。
- 禁止写 Effect：`tui/`（渲染要求同步即时）、`format/`、`events/event-log`（纯追加写）、`jobs/store`（SQLite 同步调用）。
- 唯一桥接层是 `src/utils/effect.ts`；跨层的公共 API 一律保持 Promise/同步签名，内部用 Effect 表达，边界用 `runPromiseOrAbort` 收回 Promise。

## 写法要点

```ts
// 一个作用域内的伴生任务：回合结束（含抛错、被中断）自动收掉
yield* Effect.scoped(Effect.gen(function* () {
    yield* Effect.forkScoped(heartbeat);   // 租约续期
    yield* Effect.forkScoped(deadline);    // 回合超时
    yield* Effect.promise(() => runTurn()); // 实际工作
}));
```

- `Effect.gen(function* () {})` 在 v4 **不绑定 `this`**：类里用 `const runner = this` 起别名。
- `yield*` 到失败必须 `return yield*`，否则后续代码仍会执行。
- 错误用 `Data.TaggedError`；只有真的要分拣错误时才建错误类型，否则统一 `catchCause` + `Cause.squash` 还原。
- 作用域内 `forkScoped` 的 fiber 不用管清理；跨作用域才需要留 fiber 句柄手动 `Fiber.interrupt`。

## 本仓踩过的坑

- **`interruptOnAbort` + `raceFirst` 会撤销整组**：signal 触发时它中断 fiber，同一 race 里别的分支也一起没。要在 abort 时"做事"（杀进程）用 `whenAborted(signal, action)`。
- **`Effect.sleep` 会占住进程退出**：后台 watchdog 用 `sleepUnref(ms)`，行为等同原来的 `setTimeout(...).unref()`。
- **`Effect.runFork` 的 fiber 不再有 Promise 的 `finally`**：收尾放 `Effect.ensuring`，失败放 `Effect.catchCause`，两者都要显式写。
- **超时 ≠ 中断**：回合超时的语义是"让宿主中止回合并等它正常返回 aborted"，不是中断本地 Promise，所以用 fork 的 watchdog，不用 `Effect.timeoutOrElse`。

## 现状对照

| 位置 | 用法 |
|---|---|
| `utils/effect.ts` | `interruptOnAbort` / `whenAborted` / `runPromiseOrAbort` / `sleepUnref` 四个桥 |
| `jobs/runner.ts` | 轮询与租约心跳是 fiber（`repeatEvery`），回合超时是作用域内 watchdog，`stop()` 用 `Fiber.join` + `Effect.race` 等收尾，不再有 `setInterval` + 50ms 轮询 |
| `tools/background-tasks.ts` | 后台任务超时 watchdog（中断即清定时器、不阻止退出）、前台超时/abort 双出口 `raceFirst`、`wait()` 的定时器与监听器交给 Effect |
| `tools/background-tasks.test.ts` | 前台完成/超时/转后台、stop、wait 超时与 abort（引入 Effect 时补的测试） |

## 待做（按收益排序）

1. `host/session-host.ts`：回合登记集合（`inflightTurns`、`cancellingSessions`）与 `waitForSessionTurns` 的 deadline race 换成 fiber + `Deferred`，这是现在最难读的一块。
2. `mcp/client-manager.ts`：连接池按 `Layer.scoped` / 作用域管理，`close` 现在靠 `Promise.all` 兜。
3. `utils/file-lock.ts` 与 `control/client.ts` 的重试：`Schedule.exponential` + 抖动，重试策略只有一处定义。
4. 时间相关测试用 `effect/testing` 的 `TestClock` 跑虚拟时间（job 租约/超时用例现在真的等秒）。

## 编辑期诊断

- 带诊断的类型检查：`bun run check`（= `effect-tsgo tsc --noEmit`，跑的是 `@effect/tsgo` 自带的 Effect 增强 tsc，版本跟随本地 typescript）。
- 报出的诊断：floating effect（`TS377001`）、对不会失败的 Effect 误用 catch、layer 依赖泄漏等。
- 不走 `prepare` 打补丁：补丁会污染 `node_modules`、重装即失效，还得为生产安装准备跳过开关。`bun run build` 里的 `tsc` 只做纯类型检查，不需要诊断。
