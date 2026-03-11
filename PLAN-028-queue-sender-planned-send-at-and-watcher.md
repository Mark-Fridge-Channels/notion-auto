# Feature Implementation Plan: 028 Queue Sender Planned Send At + Watcher + 节流简化

**Overall Progress:** `100%`

## TLDR

Queue Sender 发送节奏改为由程序控制且 **Planned Send At 参与**：仅当计划发送时间落在「当前时间往前 5 分钟内」才发送，无 Planned Send At 一律不发送，过期超过 5 分钟的不处理；固定**每分钟**轮询一轮。为 Queue Sender 增加**后台 watcher**（listen 后每分钟若 idle 则自动拉，与 Inbound 一致）。**节流简化**：只保留「每个发件人每天最多发几封」，取消两封间隔与每小时上限；Schedule/UI/server/queue-sender/reply-tasks-auto-sender 同步调整。

## Critical Decisions

- **Planned Send At 窗口**：仅当 `plannedSendAt != null` 且 `now - 5min ≤ plannedSendAt ≤ now` 才纳入；无 plannedSendAt 或过期 >5min 均不纳入。
- **轮询**：每轮末尾统一 sleep(60_000)，仅在 Queue 行业时段内才拉取并发送；时段逻辑保留。
- **Watcher**：与 Inbound 一致，不区分主启动，listen 后 `setInterval(60_000)` 若 `getQueueSenderStatus() === 'idle'` 则 `startQueueSender()`。
- **节流**：只保留 `maxPerDay`；旧 schedule 含四项时只读 `maxPerDay`（缺省 50），保存只写 `maxPerDay`。

## Tasks

- [x] 🟩 **Step 1: notion-queue 支持 5 分钟发送窗口**
  - [x] 🟩 在 `PageToQueueItemOptions` / `QueryQueuePendingOptions` 中增加 `plannedSendWindowMs?: number`；当传入时表示「仅当 plannedSendAt 在 [now - plannedSendWindowMs, now] 内且非空才纳入」。
  - [x] 🟩 在 `pageToQueueItem` 中：若传入 `plannedSendWindowMs`，则（1）`plannedSendAt == null` 直接 skip（无 Planned Send At 一律不发送）；（2）`plannedSendAt != null` 时仅当 `now - plannedSendWindowMs <= plannedSendAt && plannedSendAt <= now` 才返回 ok，否则 skip（未到或过期）。不再使用 `ignorePlannedSendAt` 当使用窗口时。
  - [x] 🟩 在 `queryQueuePending` 中把 `plannedSendWindowMs` 传给 `pageToQueueItem`；若传了 `plannedSendWindowMs` 则不再传 `ignorePlannedSendAt`。文档注释更新。

- [x] 🟩 **Step 2: schedule 节流简化为仅 maxPerDay**
  - [x] 🟩 将 `QueueThrottle` 改为只含 `maxPerDay: number`；`DEFAULT_QUEUE_THROTTLE` 改为 `{ maxPerDay: 50 }`。
  - [x] 🟩 `validateSchedule` 中对 `queueThrottle` 只校验 `maxPerDay` 为正整数。
  - [x] 🟩 `mergeSchedule` 中从 raw 读取 `queueThrottle` 时只取 `maxPerDay`（缺省 50），兼容旧 JSON。

- [x] 🟩 **Step 3: queue-sender 固定每分钟轮询 + 使用 5 分钟窗口 + 节流仅每日上限**
  - [x] 🟩 调用 `queryQueuePending` 时传入 `{ plannedSendWindowMs: 5 * 60 * 1000 }`，不再传 `ignorePlannedSendAt: true`。
  - [x] 🟩 主循环：每轮后统一 `await sleep(60_000)`；非 Queue 时段仍 sleep 1 分钟。
  - [x] 🟩 节流：`SenderThrottleState` 只保留 `countThisDay`、`dayStart`；`rollAndCanSend` 只检查 `countThisDay < maxPerDay`；`getThrottleConfig` 只读 `QUEUE_THROTTLE_MAX_PER_DAY`（缺省 50）。
  - [x] 🟩 `runOneRound` 返回 `Promise<void>`，主循环固定 sleep 1 分钟。
  - [x] 🟩 启动日志改为「Planned Send At 5 分钟窗口、每分钟轮询；节流仅每日上限」。

- [x] 🟩 **Step 4: server — Queue Sender watcher + 节流 UI/注入仅 maxPerDay**
  - [x] 🟩 在 `listen` 回调内增加 Queue Sender：启动时若 idle 则 loadSchedule 后注入 `QUEUE_THROTTLE_MAX_PER_DAY` 并 `startQueueSender()`；`setInterval(60_000)` 若 idle 则同样注入并拉起。
  - [x] 🟩 全局设置只保留「每个发件人每天最多发几封」一项；删除两封间隔、每小时上限的输入与文案。
  - [x] 🟩 `fillGlobal` / `collectSchedule` 只读写 `queueThrottleMaxPerDay`。
  - [x] 🟩 `POST /api/start`、`POST /api/queue-sender/start`、`POST /api/reply-tasks-auto-send/start` 中只注入并恢复 `QUEUE_THROTTLE_MAX_PER_DAY`。

- [x] 🟩 **Step 5: reply-tasks-auto-sender 节流仅每日上限**
  - [x] 🟩 节流状态只保留 `countThisDay`、`dayStart`；从 env 只读 `QUEUE_THROTTLE_MAX_PER_DAY`（缺省 50）。
  - [x] 🟩 `rollAndCanSend` 只检查 `countThisDay < maxPerDay`；发送成功后只更新 countThisDay/dayStart。
  - [x] 🟩 移除 nextSendAt、countThisHour、hourStart 及两封间隔 sleep；无待发或不可发时 sleep 60_000 或 SLEEP_MIN_MS。
