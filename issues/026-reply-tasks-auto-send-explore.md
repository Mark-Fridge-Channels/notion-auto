# 026 Reply Tasks 自动发送 — 探索结论

## 1. 需求与现有实现的理解

- **需求**：Reply Tasks 配置 / Task 列表旁增加「开启自动发送」开关；打开后自动轮询当前选中库中「待发送」的 Task，按 Queue 发信节流逐条发送并标为 Done。
- **现有相关实现**：
  - `listReplyTasks(notion, dbId, { filterStatusNotDone: true })`：返回 Status ≠ Done 的 Task，按 `last_edited_time` 降序，最多 100 条。
  - `sendOneReplyTask(notion, taskPageId, senderAccountsDatabaseUrl, bodyHtml?)`：单条发送，不传 bodyHtml 时用 Suggested Reply 转 HTML；成功后回写 Done。
  - Queue Sender：独立进程（`queue-sender.ts`），由 `dashboard-queue-sender-runner.ts` spawn；节流从 env 读取（server 启动前从 `schedule.queueThrottle` 写入 env）；进程内维护 `Map<senderKey, SenderThrottleState>`，每轮「每发送者至多发 1 条」再按 nextSendAt 休眠。
  - 节流配置：`schedule.queueThrottle`（minIntervalSec, maxIntervalSec, maxPerHour, maxPerDay），Dashboard 全局设置编辑，启动 Queue Sender 时 server 注入 env。

## 2. 集成点与依赖

- **配置**：当前选中的 Reply Tasks 来自 `loadReplyTasksConfigOrDefault()` 的 `selected_index`，自动发送每轮应基于该选中项取 `reply_tasks_db_id` + `sender_accounts_database_url`。
- **节流**：若复用同一套「配置」，则自动发送启动时同样从 `loadSchedule(getSchedulePath())` 取 `queueThrottle`，可写入 env 后 spawn 子进程，或 in-process 时直接传对象。
- **发送者标识**：Reply Task → getReplyTaskSendContext → `senderAccount`；节流按 senderAccount（或对应 email）为 key，与 Queue Sender 一致即可。
- **无时段限制**：Queue Sender 有「当前时段是否为 queue 行业」；Reply Tasks 自动发送不依赖 schedule 时段，只要开关打开就轮询。

## 3. 需产品/你确认的问题

### 3.1 「Todo 状态」的定义（建议明确）

- **现状**：`listReplyTasks(..., { filterStatusNotDone: true })` 表示 **Status ≠ Done** 的都会返回（Notion 里可能是 Todo、In Progress 等）。
- **歧义**：需求里写的是「Todo 状态的 Task」。
- **请确认**：自动发送的对象是  
  - **A**：仅 Status 名为 "Todo" 的 Task，还是  
  - **B**：所有 Status ≠ Done 的 Task（与当前「批量发送」一致）？  
  若选 A，需要改 list 的 filter（例如 `status.equals("Todo")`），并确认 Notion 中 Status 属性选项名是否就是 "Todo"。

### 3.2 节流状态是否与 Queue Sender 共用（影响实现形态）

- **现状**：Queue Sender 在**独立进程**内维护节流状态（每发送者已发数、nextSendAt），与 server 不共享。
- **若 Reply Tasks 自动发送也做成独立进程**：会拥有自己的一份节流状态，即「配置共用、状态不共用」——同一发件人可同时受 Queue 的 10/小时 和 Reply Tasks 的 10/小时 限制，理论最大 20/小时。
- **若要求「共用」节流状态**：则需两进程共享同一份计数/nextSendAt，可选方案：  
  - 节流状态上移到 server（如 server 内存或简单文件），Queue Sender 与 Reply Tasks 进程都通过 server 的 API 申请「是否可发」；  
  - 或 Reply Tasks 自动发送不做成独立进程，改为 server 内 in-process 循环，但即便如此仍无法与已存在的 Queue Sender 子进程共享状态，除非 Queue Sender 也改为向 server 问节流。  
  共用会带来较大改动。
- **请确认**：首版是否接受「**配置共用、状态不共用**」（Reply Tasks 独立进程 + 独立节流状态，但用同一份 schedule.queueThrottle）？若接受，实现简单、与现有 Queue Sender 对称；若必须共用状态，需要约定是首版就做跨进程共享，还是后续迭代再做。

### 3.3 每轮发送条数

- Queue Sender：每轮按发送者分组，**每发送者至多发 1 条**，再 sleep。
- **请确认**：Reply Tasks 自动发送是  
  - **A**：每轮「每发送者至多发 1 条」（与 Queue 一致，节流更细），还是  
  - **B**：每轮「全局至多发 1 条」再 sleep（实现更简单）？  
  若选 A，需要先拉列表、按 senderAccount 分组，再按节流选可发的第一条。

### 3.4 发送顺序

- 当前 `listReplyTasks` 排序为 `last_edited_time` 降序（最近编辑在前）。
- **请确认**：自动发送是否保持「列表顺序」即可（即当前实现下的「最近编辑优先」），还是希望改为「最早编辑优先」等其它顺序？若无特殊要求，建议保持现状。

### 3.5 开启时无有效配置 / 无待发

- 若用户点击「开启自动发送」时：未选择任何 Reply Tasks 配置项（entries 为空或 selected_index 无效）、或当前库没有 Status ≠ Done 的 Task。
- **请确认**：是  
  - **A**：允许启动，进程/循环照常跑，每轮拉列表为空则长 sleep，不报错；还是  
  - **B**：拒绝启动并提示「请先选择 Reply Tasks 配置并确保有待发送任务」？  
  建议 A，与 Queue Sender「无待发时 sleep 再拉」一致。

### 3.6 运行日志与状态展示

- 需求已写：状态可见（运行中/已停止）。
- **可选**：是否需要在 Reply Tasks tab 下提供「最近运行日志」（类似 Queue Sender 的 run logs），便于排查发送失败、节流等待等？若首版不做，可仅保留「运行中 / 已停止」+ 可选「上次发送时间 / 条数」等简单信息。

## 4. 边界与约束（已明确或可沿用）

- **选中的配置**：自动发送每轮读 `loadReplyTasksConfigOrDefault()`，自然跟随用户在 Dashboard 的「选中项」切换，无需额外逻辑。
- **发送内容**：自动发送使用 Task 的 Suggested Reply 转 HTML，不开放编辑，与 issue 描述一致。
- **错误与重试**：单条发送失败（如凭据缺失、网络错误）不中断循环，仅打日志并跳过该条，与现有 `sendOneReplyTask` 返回 `{ ok: false, error }` 一致；是否要重试单条可沿用现有逻辑或后续再加。
- **实现形态**：在「节流状态不共用」的前提下，采用**独立进程**（如 `reply-tasks-auto-sender.ts` + `dashboard-reply-tasks-auto-sender-runner.ts`）与 Queue Sender 对称、节流逻辑可复用 queue-sender 的 throttle 工具或抽成共享模块，便于维护。

## 5. 用户确认结论（2025-02-28）

| 问题 | 选择 | 说明 |
|------|------|------|
| 3.1 发送对象 | **所有 Status ≠ Done 都发** | 与现有批量发送一致，不改 filter；无需只限 "Todo"。 |
| 3.2 节流状态 | **配置共用、状态不共用** | 独立进程 + 独立节流状态，用同一份 schedule.queueThrottle；与 Queue Sender 对称实现。 |
| 3.3 每轮条数 | **B：每轮全局至多 1 条** | 每轮至多发 1 条再 sleep，实现简单。 |
| 3.4 发送顺序 | **顺序发送，不要倒序** | 自动发送按「最早编辑优先」：需 `last_edited_time` **升序**（ascending）。当前 `listReplyTasks` 为降序，实现时需支持排序方向（见下）。 |
| 3.5 无配置/无待发 | **A：允许启动** | 允许启动，每轮拉列表为空则长 sleep，不报错。 |
| 3.6 运行日志 | **需要运行日志** | Reply Tasks 自动发送需提供「最近运行日志」，与 Queue Sender 一致。 |

### 实现备注（发送顺序）

- `listReplyTasks` 当前写死 `sorts: [{ timestamp: "last_edited_time", direction: "descending" }]`。
- 自动发送需要「最早编辑优先」，即 **ascending**。做法二选一：
  - **方案 A**：为 `listReplyTasks` 增加可选参数，如 `options.sortLastEdited?: 'asc' | 'desc'`，默认保持 `'desc'`（Dashboard 列表不变），auto-sender 调用时传 `'asc'`。
  - **方案 B**：auto-sender 拉列表后自行按 `last_edited_time` 排序——但当前 `ReplyTaskListItem` 未暴露 `last_edited_time`，需接口或返回扩展。
- **建议**：方案 A，在 `listReplyTasks` 的 options 里加 `sortLastEdited: 'asc' | 'desc'`（可选，默认 `'desc'`），Notion query 的 sorts 据此设置；若 Notion API 不返回 last_edited_time 在 list 里，需查 Notion 文档确认 query 结果是否含该字段，否则需在 options 里传 sort 给 query。当前 `notion.databases.query` 的 results 里每页有 `last_edited_time`，所以只需把 sort 改为可配置即可。

## 6. 小结

- 上述 6 项已确认；实现形态为**独立进程**（reply-tasks-auto-sender + runner），节流配置共用、状态不共用，每轮 1 条、最早编辑优先、允许无待发时启动、需运行日志。
- **listReplyTasks** 需支持排序方向（asc/desc），供自动发送使用升序。
- 可进入 **create-plan**，再实现。
