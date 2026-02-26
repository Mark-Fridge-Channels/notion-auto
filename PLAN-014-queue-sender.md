# Feature Implementation Plan: Queue Sender（出站发送）

**Overall Progress:** `100%`

## TLDR

在现有「行业与任务链」上增加第二种行业类型 **Queue**：从 Notion Queue 数据库读取 Email Status=Pending 的项，按 Planned Send At / Sender Account / 收件人/主题/正文/Thread ID 规则，用 Gmail API 发送；凭据从**各行业自己的发件人库**（Notion）按 Sender Account→Email 匹配取 Email+password。成功/失败按文档回写 Queue（含 Stop Reason）；Followup 必须 threadId+In-Reply-To/References（需 Message ID Last）。Queue Sender 为独立常驻进程，由 Dashboard 启停，复用现有时段配置（仅当当前时段绑定行业为 Queue 类型时执行）；Dashboard 与 Playwright **日志合并**展示（tabs 区分）。

## Critical Decisions

- **独立入口**：Queue Sender 单独脚本 `src/queue-sender.ts`，不并入 `index.ts`，避免 Playwright 与 Notion/Gmail 两套依赖混在一起。
- **配置复用**：使用现有 `schedule.json` + 时段；行业增加 `type: 'playwright' | 'queue'`，Queue 行业必填 `queueDatabaseUrl`、`senderAccountsDatabaseUrl`（发件人库各自用）、可选 `batchSize`。
- **发件人库各自用**：每个 Queue 行业必填发件人库 URL，用 Queue 的 Sender Account 匹配该库 Email 字段取 Email+password。
- **日志合并**：Playwright 与 Queue Sender 共用「最近运行日志」区域，后端返回 runs 带来源标识，前端用 tabs 或标签区分。
- **回写**：失败时错误原因写入 Queue 的 **Stop Reason（text）**；Followup 缺 threadId 时不发，Needs Review + 回滚状态；单次最多重试 3 次，严格幂等（Sent At Last / Message ID Last 已有则不发）。

## Tasks

- [x] 🟩 **Step 1: 依赖与 env**
  - [x] 🟩 在 `package.json` 增加 `@notionhq/client`、`googleapis`（Gmail API）；`env.example` 与文档增加 `NOTION_API_KEY`（Notion Integration Token）。
  - [x] 🟩 确认发件人库、Queue 库的 Notion Integration 已加入对应数据库 Collaborators。（文档说明，运行时需用户自行配置）

- [x] 🟩 **Step 2: Schedule 类型与校验（schedule.ts）**
  - [x] 🟩 `ScheduleIndustry` 增加 `type?: 'playwright' | 'queue'`（默认 `'playwright'`）。
  - [x] 🟩 Queue 行业字段：`queueDatabaseUrl`、`senderAccountsDatabaseUrl`、`batchSize?`（默认 20）；`normalizeIndustry` / `mergeSchedule` 支持并给默认。
  - [x] 🟩 `validateIndustry`：当 `type === 'queue'` 时校验 `queueDatabaseUrl`、`senderAccountsDatabaseUrl` 非空，不校验 `notionUrl`/`tasks`；Playwright 保持现校验。
  - [x] 🟩 `getIndustryForNow` 不变（仍按 timeSlots 返回行业）；Queue Sender 进程内用其判断当前是否落在 Queue 行业时段。

- [x] 🟩 **Step 3: Notion 工具（新模块）**
  - [x] 🟩 从 Notion 数据库 URL 解析 `database_id`（支持 `?db=xxx` 及 path 形式）。
  - [x] 🟩 查询 Queue 库：filter（Email Status=Pending、四 Flag 全 false、Email/Subject/Body 非空）、sort（Queued At 升序）、page_size≤batchSize；仅当 `now >= Planned Send At` 且 Sent At Last/Message ID Last 为空时纳入（幂等）。
  - [x] 🟩 更新 Queue page：写 Email Status、Sent At Last、Thread ID、Message ID Last、Subject Last、Needs Review、Stop Flag、Stop Reason（text）等。
  - [x] 🟩 查询发件人库（由 `senderAccountsDatabaseUrl` 指定）：按 Email 属性等于 Queue 条目的 Sender Account，取 Email + password。

- [x] 🟩 **Step 4: Gmail 发信（新模块）**
  - [x] 🟩 使用发件人库的 password 作为 refresh_token + env GMAIL_CLIENT_ID/SECRET 认证 Gmail API。
  - [x] 🟩 Cold1：`messages.send` 无 threadId，body HTML；回写 message.id、threadId。
  - [x] 🟩 Followup：传 threadId，MIME 设置 In-Reply-To/References（Message ID Last）；缺 threadId 时不发，由 queue-sender 回写 Needs Review + 回滚 + Stop Reason。
  - [x] 🟩 单条发送失败与重试逻辑在 queue-sender 内实现（最多 3 次后标 Needs Review + Stop Reason）。

- [x] 🟩 **Step 5: Queue Sender 主流程（src/queue-sender.ts）**
  - [x] 🟩 加载 schedule；若未落入任何时段或行业非 Queue 类型则 sleep 1 分钟再检查。
  - [x] 🟩 当 `getIndustryForNow()` 为 Queue 行业时：解析 queueDatabaseUrl、senderAccountsDatabaseUrl、batchSize；查询 Pending 项；逐条取凭据、发信、回写；批量后 sleep 5–10 分钟。
  - [x] 🟩 进程常驻循环；日志由 runner 采集。

- [x] 🟩 **Step 6: Queue Sender Runner 与 API（server）**
  - [x] 🟩 新增 `dashboard-queue-sender-runner.ts`：spawn `npx tsx src/queue-sender.ts`，维护 status 与 runLogs。
  - [x] 🟩 新增 API：`GET /api/queue-sender/status`、`POST /api/queue-sender/start`、`POST /api/queue-sender/stop`。
  - [x] 🟩 修改 `GET /api/logs`：返回 runs 每项带 `kind: 'playwright' | 'queue-sender'`，合并排序供前端 tabs 展示。

- [x] 🟩 **Step 7: Dashboard 行业与任务链（server.ts HTML + JS）**
  - [x] 🟩 行业列表行：增加「类型」列（Playwright/Queue）与主 URL（Queue 显示 queueDatabaseUrl）；新建行业默认 `type: 'playwright'`。
  - [x] 🟩 编辑弹窗：行业类型单选；Queue 时显示 Queue 数据库 URL、发件人库 URL、每批条数；保存时按类型写回。
  - [x] 🟩 `collectSchedule()` 使用内存中的 industries（含 type/queue 字段）；`openEditModal` 按 `ind.type` 显示/隐藏并回填。

- [x] 🟩 **Step 8: Dashboard Queue Sender 启停与日志合并（server.ts HTML + JS）**
  - [x] 🟩 Header 增加 Queue Sender 状态与「启动 Queue Sender」「停止 Queue Sender」按钮；轮询 `/api/queue-sender/status`。
  - [x] 🟩 最近运行日志：tabs 按 runs 的 `kind` 显示「Playwright #id 时间」/「Queue #id 时间」。

- [x] 🟩 **Step 9: 兼容与收尾**
  - [x] 🟩 `index.ts`：当当前时段行业为 Queue 类型时跳过执行（等待直至落入 Playwright 行业）；切换行业后若新区间为 Queue 则同样等待。
  - [x] 🟩 `schedule.example.json` 增加 Queue 行业示例；README 补充 Queue 类型、发件人库各自用、NOTION_API_KEY、日志合并说明。
