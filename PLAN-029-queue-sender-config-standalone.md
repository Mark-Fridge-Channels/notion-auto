# Feature Implementation Plan: 029 Queue Sender 配置独立（类 Reply Tasks）

**Overall Progress:** `100%`

## TLDR

Queue 发信配置从 schedule 的「行业与任务链」中剥离，改为独立 JSON（queue-sender.json）+ 页面配置，支持多条；每轮跑所有配置的 Queue，不再依赖 schedule 时段；schedule 废除 queue 行业类型，加载时忽略 queue 行业并继续。

## Critical Decisions

- **配置**：`queue-sender.json`，结构 `{ entries: [ { name, queue_database_url, sender_accounts_database_url, batch_size? } ] }`，snake_case，与 reply-tasks 一致；无 selected_index，每轮跑所有 entry。
- **Queue Sender 进程**：不再读 schedule/getIndustryForNow；每轮固定间隔加载 queue-sender 配置，对每条 entry 顺序执行一轮拉取+发送，共用同一 senderStates（每日节流跨多条配置）。
- **Schedule**：废除 type=queue；加载时过滤掉 queue 行业、修正或移除引用 queue 的 timeSlot，保证旧 schedule 可加载。
- **兼容**：已有 schedule 含 queue 行业则忽略并继续；UI 表单项描述清楚（显示名、Queue 数据库 URL、发件人库 URL、每批条数）。

## Tasks

- [x] 🟩 **Step 1: queue-sender-config 模块**
  - [x] 🟩 新建 `src/queue-sender-config.ts`：QueueSenderEntry、QueueSenderConfig、validate/getDefault/getPath/load/loadOrDefault/save；风格对齐 reply-tasks-config。

- [x] 🟩 **Step 2: queue-sender 进程改读新配置、每轮跑所有**
  - [x] 🟩 移除 schedule/getIndustryForNow/getSchedulePath；每轮 loadQueueSenderConfigOrDefault()，对每条 entry 顺序 runOneRound，共用 senderStates。
  - [x] 🟩 runOneRound(notion, entry: QueueSenderEntry, throttle, senderStates)；processOne 改为接收 senderAccountsDatabaseUrl 字符串。
  - [x] 🟩 节流仍从 env 读。

- [x] 🟩 **Step 3: schedule 废除 queue 行业、加载时忽略**
  - [x] 🟩 ScheduleIndustry 仅保留 playwright；移除 queueDatabaseUrl、senderAccountsDatabaseUrl、batchSize；ScheduleIndustryType 仅 "playwright"。
  - [x] 🟩 validateIndustry 仅校验 playwright 字段；normalizeIndustry 遇 type=queue 转为默认 playwright 行业（同 id），保证旧配置可加载。
  - [x] 🟩 行业编辑弹窗与 renderIndustries：移除 Queue 类型与 Queue URL 输入，仅 Playwright。

- [x] 🟩 **Step 4: API 与 Dashboard UI**
  - [x] 🟩 GET/POST `/api/queue-sender/config`，从 queue-sender-config 读写。
  - [x] 🟩 Dashboard 新增 tab「Queue 发信配置」：列表（显示名、Queue URL、发件人库 URL、每批条数）、添加/编辑/删除、表单项描述清楚，保存调用 POST。
  - [x] 🟩 行业编辑处已移除 Queue 类型与 Queue URL（Step 3 完成）。

- [x] 🟩 **Step 5: index.ts 与 server 中 queue 相关清理**
  - [x] 🟩 index.ts：移除 `isPlaywrightIndustry` 及「当前是否 queue 时段」的等待分支；仅 Playwright 行业参与主流程。
  - [x] 🟩 server 行业弹窗与渲染已在 Step 3 完成。
  - [x] 🟩 已提供 `queue-sender.json.example`；env.example 已增加 `QUEUE_SENDER_CONFIG` 说明。
