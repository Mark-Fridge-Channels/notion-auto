# Dashboard 统一启停 + 节流入全局设置 + Inbound 随启与自动重启

**类型:** feature  
**优先级:** normal  
**工作量:** medium

---

## TL;DR

- 把 Queue Sender 节流四项配置迁到 Dashboard「全局设置」，单位改为秒，代码从全局配置读取。
- 主「启动/停止」同时控制 Playwright、Queue Sender；去掉 Queue Sender 的独立启停按钮。
- Inbound Listener 不再单独启停：随 Dashboard「启动」默认启动，进程挂掉时轮询自动重启，并增加「手动重启 Inbound Listener」按钮。

---

## 当前状态 vs 期望

| 项目 | 当前 | 期望 |
|------|------|------|
| 节流配置 | 仅 env（`QUEUE_THROTTLE_*`，单位 ms），无 UI | 放在 Dashboard 全局设置，用户可编辑，**时间单位秒**；运行时从全局配置读（不再依赖 env） |
| 主「启动」 | 只启动 Playwright | 同时启动 Playwright + Queue Sender |
| 主「停止」 | 只停止 Playwright | 同时停止 Playwright + Queue Sender |
| Queue Sender 按钮 | 有独立「启动 Queue Sender」「停止 Queue Sender」 | **去掉**这两按钮（状态可保留展示） |
| Inbound Listener 按钮 | 有独立「启动/停止 Inbound Listener」 | **去掉**启停按钮；Dashboard 启动后**默认启动** Inbound Listener |
| Inbound 进程挂了 | 无自动恢复 | **轮询检测**，挂了则**自动重启** |
| Inbound 手动重启 | 无 | 增加**「手动重启 Inbound Listener」**按钮 |

---

## 涉及文件（主要）

- **`src/server.ts`**  
  - 全局设置 HTML：在「全局设置」卡片中增加节流四项（单位秒）；主启动/停止逻辑改为同时控制 Playwright + Queue Sender；去掉 Queue Sender 启停按钮；去掉 Inbound 启停按钮，增加「手动重启 Inbound Listener」；`fillGlobal` / `collectSchedule` 读写节流字段；启动时拉取当前 schedule 并传给 Queue Sender（见下）。
- **`src/schedule.ts`**  
  - `Schedule` 类型增加节流相关字段（或嵌套 `queueThrottle`）；`mergeSchedule` / 校验里支持新字段；持久化与现有 schedule 一起。
- **`src/queue-sender.ts`**  
  - 节流参数改为从「全局配置」读：要么启动时由 server 通过 env 注入（从 schedule 写入 `QUEUE_THROTTLE_*` 再 spawn），要么改为读与 schedule 同源的配置文件/API。推荐：**server 在 spawn Queue Sender 时把当前 schedule 中的节流（换算成 ms）写入 `env`**，queue-sender 仍用现有 env 读取逻辑，无需改 queue-sender 内部接口。
- **`src/dashboard-queue-sender-runner.ts`**  
  - `startQueueSender(opts?: { throttleFromSchedule?: { minIntervalSec, maxIntervalSec, maxPerHour, maxPerDay } })` 或由 server 在调用前设置 `process.env` 再调用无参 `startQueueSender()`，避免在 runner 里读 schedule 文件（由 server 读 schedule 并写 env 更清晰）。
- **`src/dashboard-inbound-listener-runner.ts`**  
  - 无接口变化；若需「重启」语义，可封装 `restartInboundListener()`：先 stop 再 start。
- **`src/server.ts`（轮询与自动重启）**  
  - 在已有定时刷新 status 的基础上，增加轮询：若发现 Inbound Listener 状态为 idle 且「上次是 running」（或进程退出），则自动调用 start；或单独 setInterval 每 N 秒检查一次 `getInboundListenerStatus()`，若应为运行中却为 idle 则自动重启。注意：仅当「用户已点击过主启动」时才自动拉活 Inbound，避免未启动时误启。

---

## 配置项与单位（节流）

- 两封间隔：**最小间隔（秒）**、**最大间隔（秒）**（对应原 `QUEUE_THROTTLE_MIN_INTERVAL_MS` / `MAX_`，默认可 180、300 秒）。
- 每小时每发送者上限：**数字**（默认 10）。
- 每天每发送者上限：**数字**（默认 50）。
- 保存到 schedule 时，内部可存为秒或毫秒（建议存秒，下发/计算时再转 ms），界面一律用秒。

---

## 风险与注意

- **启动顺序**：主「启动」时建议顺序为：先启动 Inbound Listener，再 Queue Sender，再 Playwright（或按现有习惯，但要一致），避免依赖问题。
- **轮询自动重启**：需区分「用户主动停止」与「进程崩溃」。若用户点击主「停止」，会主动 stop Inbound，此时不应再自动拉活。可在 server 侧维护一个 `inboundShouldBeRunning: boolean`，仅当主启动为 true 且 Inbound 为 idle 时才自动重启。
- **env.example**：完成迁移后，在 `env.example` 中把 `QUEUE_THROTTLE_*` 标为弃用或说明「已迁移至 Dashboard 全局设置」，避免重复配置。

---

## 验收要点

1. 全局设置中可编辑四项节流（两间隔为秒、每小时/每天上限），保存后生效；新启动的 Queue Sender 使用该配置。
2. 点击「启动」后，Playwright、Queue Sender、Inbound Listener 均启动；点击「停止」后三者均停止。
3. Dashboard 上不再有「启动/停止 Queue Sender」按钮；仍可显示 Queue Sender 状态。
4. 不再有「启动/停止 Inbound Listener」按钮；Dashboard 启动后 Inbound 默认运行；若进程异常退出，在「主启动」仍开启的前提下自动重启。
5. 有「手动重启 Inbound Listener」按钮，点击后仅重启 Inbound，不影响 Playwright/Queue Sender。
