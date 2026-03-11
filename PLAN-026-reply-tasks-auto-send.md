# Feature Implementation Plan: Reply Tasks 自动发送

**Overall Progress:** `100%`

## TLDR

在 Reply Tasks 配置与 Task 列表旁增加「开启自动发送」开关；打开后由独立子进程轮询当前选中库中 Status ≠ Done 的 Task，按全局 Queue 节流配置每轮至多发送 1 条（最早编辑优先），发送后标为 Done，并提供运行日志。节流配置共用、状态不共用；无待发时允许运行并长 sleep。

## Critical Decisions

- **发送对象**：所有 Status ≠ Done（与批量发送一致），不限定仅 "Todo"。
- **节流**：配置共用（schedule.queueThrottle）、状态不共用；独立进程内自维护 per-sender 节流状态，与 Queue Sender 对称。
- **每轮条数**：每轮全局至多 1 条，发完后按 min/max 间隔 sleep。
- **发送顺序**：最早编辑优先，即 `last_edited_time` 升序；`listReplyTasks` 增加可选 `sortLastEdited: 'asc' | 'desc'`。
- **无配置/无待发**：允许启动，列表为空时长 sleep（如 60s）再拉。
- **运行日志**：提供最近 N 次运行日志（stdout/stderr），在 Reply Tasks tab 展示。
- **实现形态**：独立进程 `reply-tasks-auto-sender.ts` + `dashboard-reply-tasks-auto-sender-runner.ts`，由 server 启停并注入节流 env。

## Tasks

- [x] 🟩 **Step 1: listReplyTasks 支持排序方向**
  - [x] 🟩 在 `src/notion-reply-tasks.ts` 的 `listReplyTasks` 的 options 中增加可选 `sortLastEdited?: 'asc' | 'desc'`，默认 `'desc'`（保持现有 Dashboard 列表行为）。
  - [x] 🟩 将 `notion.databases.query` 的 `sorts` 改为根据该参数设置 `direction: 'ascending' | 'descending'`。

- [x] 🟩 **Step 2: reply-tasks-auto-sender 常驻脚本**
  - [x] 🟩 新建 `src/reply-tasks-auto-sender.ts`：dotenv、Notion client、从 env 读取节流（与 queue-sender 相同的 QUEUE_THROTTLE_*），以及 reply-tasks 配置路径（或默认 reply-tasks.json）。
  - [x] 🟩 实现 per-sender 节流状态（nextSendAt、countThisHour、countThisDay、hourStart、dayStart）及 rollAndCanSend / 间隔计算（可参考 queue-sender.ts 的 throttle 逻辑，不抽共享模块，本脚本内实现即可）。
  - [x] 🟩 主循环：每轮 `loadReplyTasksConfigOrDefault()` 取当前选中项；若无有效 entry 或无 NOTION_API_KEY，sleep 后继续；否则 `listReplyTasks(notion, dbId, { filterStatusNotDone: true, sortLastEdited: 'asc' })`，若列表为空则 sleep(60_000) 后继续；取列表第一条，用 `getReplyTaskSendContext` 取 senderAccount 作节流 key，若该发送者当前不可发则 sleep 到 nextSendAt 再继续；调用 `sendOneReplyTask`（不传 bodyHtml），根据结果更新节流状态并 sleep(minInterval～maxInterval)，失败则仅打日志并 sleep 后继续。
  - [x] 🟩 使用 logger 输出关键步骤（启动、每轮无任务/无配置、发送成功/失败、节流等待），便于 runner 采集日志。

- [x] 🟩 **Step 3: dashboard-reply-tasks-auto-sender-runner**
  - [x] 🟩 新建 `src/dashboard-reply-tasks-auto-sender-runner.ts`：仿照 `dashboard-queue-sender-runner.ts`，spawn `npx tsx src/reply-tasks-auto-sender.ts`，stdio pipe，采集 stdout/stderr 到当前 run log，保留最近 10 次运行日志（MAX_RUN_LOGS=10，MAX_LINES_PER_RUN=2000）；`getReplyTasksAutoSendStatus(): 'idle'|'running'`、`startReplyTasksAutoSend()`、`stopReplyTasksAutoSend()`、`getReplyTasksAutoSendRunLogs(n)`；exit 时把 currentRunLog 写入 runLogs；Windows 下 spawn 方式与 queue-sender-runner 一致（shell + 转义）。
  - [x] 🟩 不在此文件内注入节流 env；由 server 在调用 start 前注入并恢复（与 /api/start 中 Queue Sender 的 throttle 注入方式一致）。

- [x] 🟩 **Step 4: Server API 与节流注入**
  - [x] 🟩 在 `src/server.ts` 中引入 `dashboard-reply-tasks-auto-sender-runner`；新增 `GET /api/reply-tasks-auto-send/status`（返回 `{ status }`）、`POST /api/reply-tasks-auto-send/start`、`POST /api/reply-tasks-auto-send/stop`、`GET /api/reply-tasks-auto-send/logs?n=10`（返回 `{ runs }`，结构可与 queue-sender logs 一致：id、startTime、endTime、lines）。
  - [x] 🟩 在 `POST /api/reply-tasks-auto-send/start` 中：若已在运行则 400；否则从 `loadSchedule(getSchedulePath())` 取 `queueThrottle`，将 min/max 间隔与 maxPerHour/maxPerDay 写入 process.env（QUEUE_THROTTLE_*），调用 `startReplyTasksAutoSend()`，再恢复 env（与现有 queue-sender 启动前注入逻辑一致）。

- [x] 🟩 **Step 5: Reply Tasks tab UI**
  - [x] 🟩 在 Reply Tasks 卡片内、「当前库 Task 列表」上方或下方增加一行：自动发送状态文案（如「自动发送：已停止」/「自动发送：运行中」）、按钮「开启自动发送」「停止自动发送」（根据 status 禁用其一），与 Queue Sender 在主视图的展示方式类似。
  - [x] 🟩 在 Reply Tasks tab 内增加「Reply Tasks 自动发送 · 最近运行日志」区块：展示最近若干次运行的日志（与主视图日志区样式一致，可复用 .run-log 等 class），数据来源为 `GET /api/reply-tasks-auto-send/logs`；切换至 Reply Tasks tab 时若需可请求该接口刷新。
  - [x] 🟩 前端：定时或 tab 激活时轮询 `GET /api/reply-tasks-auto-send/status` 以更新按钮与状态文案；start/stop 调用后刷新状态与日志。

- [ ] 🟥 **Step 6: 主启动是否带起自动发送（本计划不实现）**
  - 首版仅支持在 Reply Tasks tab 内手动「开启/停止自动发送」；不修改 `POST /api/start`。若后续需要「主启动时一并开启」，再在 start 中注入节流并调用 `startReplyTasksAutoSend()`。
