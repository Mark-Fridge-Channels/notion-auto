# Feature Implementation Plan: Queue 方案 B（按发送者节流 + 程序控制节奏）

**Overall Progress:** `100%`

## TLDR

将 Queue Sender 改为「完全由程序控制发送节奏」：不再使用 Notion 的 Planned Send At 决定是否可发；按**发送者账号**独立节流（两封间隔 3～5 分钟、每小时最多 10、每天最多 50）；无固定轮询间隔，按「下次可发时间」休眠，无待发时 1 分钟拉一次 Notion。避免重启后批量连发，实现更简单。

## Critical Decisions

- **Planned Send At 完全不参与**：查询 Pending 时不再过滤「计划时间已到」；所有满足四 Flag、Subject/Body 等的 Pending 都进入待发，发送顺序与时机 100% 由程序规则决定。
- **节流按发送者**：每个 Sender Account 独立维护 nextSendAt、本小时已发数、今日已发数；10/小时、50/天为**每发送者**上限。
- **无固定轮询间隔**：主循环根据「所有发送者中最早的 nextSendAt」计算休眠时长；无待发项时休眠 1 分钟再拉 Notion。

## Tasks

- [x] 🟩 **Step 1: notion-queue 支持忽略 Planned Send At**
  - [x] 🟩 为 `pageToQueueItem` 增加可选参数（如 `options?: { ignorePlannedSendAt?: boolean }`），当 `ignorePlannedSendAt === true` 时不因 `now < plannedSendAt` 返回 skip。
  - [x] 🟩 为 `queryQueuePending` 增加可选参数（如 `options?: { ignorePlannedSendAt?: boolean }`），传入 `pageToQueueItem`；默认保持现有行为（不忽略），便于兼容。
  - [x] 🟩 queue-sender 调用时传入 `ignorePlannedSendAt: true`。

- [x] 🟩 **Step 2: 节流配置与 per-sender 状态（queue-sender）**
  - [x] 🟩 从 env 读取节流参数（默认值括号内）：`QUEUE_THROTTLE_MIN_INTERVAL_MS`（180000）、`QUEUE_THROTTLE_MAX_INTERVAL_MS`（300000）、`QUEUE_THROTTLE_MAX_PER_HOUR`（10）、`QUEUE_THROTTLE_MAX_PER_DAY`（50）；未配置时用默认值。
  - [x] 🟩 在 queue-sender 内维护 per-sender 状态：`Map<senderKey, { nextSendAt, countThisHour, countThisDay, hourStart, dayStart }>`；发送后更新 nextSendAt = now + random(min, max)，并按自然小时/自然日滚动更新计数（新小时/新日则重置对应计数）。

- [x] 🟩 **Step 3: 主循环改为「拉取 → 按发送者分组 → 每发送者至多发 1 条 → 按 nextSendAt 休眠」**
  - [x] 🟩 拉取待发：调用 `queryQueuePending(..., { ignorePlannedSendAt: true })`，page_size 使用 industry.batchSize 或固定较大值（如 100），以拿到足够项按发送者分组。
  - [x] 🟩 将 items 按 `senderAccount` 分组（同一发送者内保持 Queued At 顺序）。
  - [x] 🟩 对每个发送者：若有待发项且 `now >= nextSendAt` 且未超 10/小时、50/天（需先根据当前时间判断是否进入新小时/新日并重置计数），则取该发送者队列首条执行 `processOne`，成功后更新该发送者的 nextSendAt 与计数。
  - [x] 🟩 计算休眠：若有任意发送者有待发且其 nextSendAt 在未来，则 `sleepMs = min(nextSendAt - now)`（并限制上限如 24h）；若无待发项则 `sleepMs = 60_000`。执行 `sleep(sleepMs)` 后回到循环开头。
  - [x] 🟩 保留「当前时段、行业为 Queue」判断；无时段时仍用 `SLEEP_NO_SLOT_MS`。

- [x] 🟩 **Step 4: 配置与文档**
  - [x] 🟩 在 env.example 中新增：`QUEUE_THROTTLE_MIN_INTERVAL_MS`、`QUEUE_THROTTLE_MAX_INTERVAL_MS`、`QUEUE_THROTTLE_MAX_PER_HOUR`、`QUEUE_THROTTLE_MAX_PER_DAY`，并注释说明（按发送者、两封间隔 3～5 分钟、每小时/每天上限）。
  - [x] 🟩 在 README 的 Queue Sender / Gmail 相关小节中简要说明：发送节奏由程序控制，Planned Send At 不参与；节流为全局配置、按发送者生效；无固定轮询、按下次发送时间休眠。

- [x] 🟩 **Step 5: 清理与边界**
  - [x] 🟩 移除 queue-sender 中不再使用的固定轮询间隔常量（`BATCH_INTERVAL_MIN_MS` / `BATCH_INTERVAL_MAX_MS`），改为使用节流参数与动态 sleep。
  - [x] 🟩 首次发送某发送者时：nextSendAt 可为 0 或 now，使该发送者在本轮即可发 1 封（若未超限）；实现时统一「无状态则视为可发」。
  - [x] 🟩 异常处理：单条 processOne 失败不影响其他发送者；主循环 try/catch 与网络类错误日志保留。
