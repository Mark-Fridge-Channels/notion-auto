# Feature Implementation Plan: Dashboard 统一启停 + 节流入全局设置 + Inbound 随启与自动重启

**Overall Progress:** `100%`

## TLDR

主「启动/停止」同时控制 Playwright、Queue Sender、Inbound Listener；节流四项迁入 Dashboard 全局设置（单位秒、嵌套 `queueThrottle`），由 server 在启动 Queue Sender 时注入 env；去掉 Queue Sender 与 Inbound 的独立启停按钮，Inbound 随主启动、进程挂掉时每 1 分钟检测并自动重启，并增加「手动重启 Inbound Listener」按钮与 `/api/inbound-listener/restart`。保留现有 queue-sender / inbound-listener 的 start/stop API。

## Critical Decisions

- **节流结构**：Schedule 使用嵌套 `queueThrottle?: { minIntervalSec, maxIntervalSec, maxPerHour, maxPerDay }`；默认 180、300、10、50。界面一律秒，spawn 时换算成 ms 写入 env，queue-sender 不改内部逻辑。
- **节流来源**：由 server 在调用 `startQueueSender()` 前从 `loadSchedule(getSchedulePath())` 取节流并设置 `process.env` 的 `QUEUE_THROTTLE_*`，runner 保持无参。
- **主启停**：`/api/start` 依次启动 Inbound（默认 configPath）、Queue Sender（带节流 env）、Playwright；`/api/stop` 依次停止三者。已 running 的组件不重复启动。
- **Inbound 自动重启**：Server 端每 1 分钟检查一次：若 `runner.getRunStatus() === 'running'` 且 `inboundListenerRunner.getInboundListenerStatus() === 'idle'`，则调用 `startInboundListener(undefined)`。
- **手动重启 Inbound**：新增 `/api/inbound-listener/restart`（先 stop 再 start），前端按钮只调该接口。
- **API 保留**：`/api/queue-sender/start|stop`、`/api/inbound-listener/start|stop` 保留，仅前端移除对应按钮。
- **Dashboard 节流说明**：在全局设置中节流四项旁用大白话说明用途（两封间隔、每发送者每小时/每天上限、保存后下次启动 Queue Sender 生效）。

---

## Tasks

- [x] 🟩 **Step 1: Schedule 增加 queueThrottle**
  - [x] 🟩 在 `src/schedule.ts` 中为 Schedule 增加可选 `queueThrottle?: { minIntervalSec, maxIntervalSec, maxPerHour, maxPerDay }` 类型与默认值（180, 300, 10, 50）。
  - [x] 🟩 在 `getDefaultSchedule()` 中写入默认 queueThrottle。
  - [x] 🟩 在 `mergeSchedule()` 中合并 queueThrottle（缺省用默认值）。
  - [x] 🟩 在 `validateSchedule()` 中校验 queueThrottle（正数、min ≤ max、整数等）。

- [x] 🟩 **Step 2: Server 主启停与节流注入**
  - [x] 🟩 修改 `/api/start`：先 `loadSchedule(getSchedulePath())`；若存在 queueThrottle，将 minIntervalSec/maxIntervalSec 转为 ms 写入 `process.env.QUEUE_THROTTLE_*`，按顺序启动 Inbound、Queue Sender、Playwright；已 running 的跳过。
  - [x] 🟩 修改 `/api/stop`：依次停止 Playwright、Queue Sender、Inbound Listener。

- [x] 🟩 **Step 3: Inbound 自动重启与 restart API**
  - [x] 🟩 在 server 启动后设 `setInterval` 60_000 ms：主在跑且 Inbound idle 时自动 startInboundListener。
  - [x] 🟩 新增 `POST /api/inbound-listener/restart`；`dashboard-inbound-listener-runner.ts` 导出 `restartInboundListener(configPath?)`。

- [x] 🟩 **Step 4: Dashboard 全局设置节流 UI 与大白话**
  - [x] 🟩 在「全局设置」中增加 Queue 发信节流四项 + 大白话说明；fillGlobal/collectSchedule 读写 queueThrottle。

- [x] 🟩 **Step 5: Dashboard 按钮与事件**
  - [x] 🟩 移除 QS/Inbound 启停按钮；保留状态展示；增加「手动重启 Inbound Listener」按钮；btnStart/btnStop 仅调 /api/start 与 /api/stop。

- [x] 🟩 **Step 6: env.example 与收尾**
  - [x] 🟩 在 `env.example` 中注明 `QUEUE_THROTTLE_*` 已迁移至 Dashboard 全局设置，可选作覆盖用。
  - [x] 🟩 `dashboard-inbound-listener-runner.ts` 已导出 `restartInboundListener(configPath?)`，供 `/api/inbound-listener/restart` 使用。
