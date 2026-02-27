# 018 - Reply Tasks 配置页 + Gmail 发回复 · 实现计划

**Overall Progress:** `100%`

## TLDR

在 Dashboard 新增 Reply Tasks 配置与任务列表：用户可管理多条 Reply Tasks 数据库 URL（含发件人库 URL），切换后展示当前库的 Task 列表；支持单条发送（可编辑正文）与批量发送（Status ≠ Done）。发信：Task → IM（relation）→ Thread ID、Touchpoint → Sender Account，用 Gmail API 按 threadId 发送，成功后回写 Task Status = Done（Notion Status 类型）。

## Critical Decisions

- **Task ↔ IM**：Reply Task 在 Notion 中通过 relation 指向 Inbound Message；解析链 Task → IM page → Thread ID、Touchpoint relation → Touchpoint → Sender Account。
- **配置**：独立 JSON（如 `reply-tasks.json`），条目含 `reply_tasks_db_id`、`sender_accounts_database_url`；另存 `selected_id` 或当前选中索引，用于切换与列表查询。
- **发信**：首版不实现 In-Reply-To/References，仅传 threadId；需在 gmail-send 支持「仅 threadId」的回复发送（新函数或 sendFollowup 的 messageIdLast 可选/占位）。
- **Status 回写**：Reply Tasks 的 Status 为 Notion **Status** 类型，完成态选项名 **Done**（complete 分组）。

---

## Tasks

- [x] 🟩 **Step 1: Reply Tasks 配置模块**
  - [x] 🟩 新建 `src/reply-tasks-config.ts`：定义 schema，每条 `reply_tasks_db_id`、`sender_accounts_database_url`；列表 + `selected_index` 表示当前选中；校验、默认配置、`reply-tasks.json` 读写，路径可 env 或默认项目目录。
  - [x] 🟩 提供 `loadReplyTasksConfigOrDefault`、`saveReplyTasksConfig`、`validateReplyTasksConfig`；无文件时返回默认（空列表），与 inbound-listener-config 风格一致。

- [x] 🟩 **Step 2: Notion Reply Tasks 适配**
  - [x] 🟩 新建 `src/notion-reply-tasks.ts`：按 database_id 查询 Reply Tasks 库，返回 Task 列表（pageId、Task Summary、Status、Suggested Reply）；从 Task 的 IM relation 取 IM page，再取 Thread ID、Touchpoint relation；从 Touchpoint 取 Sender Account；To 用 IM 的 From Email，Subject 用 Re: IM Subject。
  - [x] 🟩 实现 `updateReplyTaskStatusDone(notion, taskPageId)`：将 Reply Task 的 Status 更新为 Done（Notion Status 类型）。
  - [x] 🟩 实现 `getReplyTaskSendContext(notion, taskPageId)`：解析单条 Task 为发信上下文（threadId, to, subject, senderAccount, suggestedReply）。

- [x] 🟩 **Step 3: Gmail 发回复（仅 threadId）**
  - [x] 🟩 在 `src/gmail-send.ts` 中新增 `sendInThread(threadId, from, to, subject, htmlBody)`：仅 threadId，不设 In-Reply-To/References，复用 buildCold1Mime + requestBody { raw, threadId }。
  - [x] 🟩 正文由调用方转为 HTML（换行 → `<br>`）后传入。

- [x] 🟩 **Step 4: 发回复流程（单条 + 批量）**
  - [x] 🟩 实现 `sendOneReplyTask(notion, taskPageId, senderAccountsDatabaseUrl, bodyHtml?)`：解析上下文、取凭据、sendInThread、成功后 updateReplyTaskStatusDone。
  - [x] 🟩 实现 `sendBatchReplyTasks(notion)`：取当前选中配置、listReplyTasks( filterStatusNotDone )、逐条 sendOneReplyTask，返回汇总结果。

- [x] 🟩 **Step 5: API 与 Dashboard UI**
  - [x] 🟩 在 `server.ts` 注册：`GET/POST /api/reply-tasks/config`、`GET /api/reply-tasks/list`（当前选中库）、`POST /api/reply-tasks/send`（taskPageId、可选 bodyHtml）、`POST /api/reply-tasks/send-batch`。
  - [x] 🟩 Dashboard 新增「Reply Tasks 配置」卡片：条目列表（Reply Tasks 库 URL + 发件人库 URL）、添加/编辑/删除、选中当前、保存配置；加载 Task 列表、批量发送未完成。
  - [x] 🟩 Task 列表展示：Task Summary、Status、Suggested Reply 摘要；单条「发送」弹窗可编辑正文后发送；批量发送未完成。

- [x] 🟩 **Step 6: 示例配置与文档**
  - [x] 🟩 提供 `reply-tasks.json.example`（含一条占位 reply_tasks_db_id、sender_accounts_database_url）；README 中已补充 Reply Tasks 配置与发回复流程说明。

---

## 依赖与顺序

- Step 1 独立；Step 2 依赖 Notion 库结构（Task 有 relation 到 IM）；Step 3 独立可与 Step 2 并行思路；Step 4 依赖 1、2、3；Step 5 依赖 1、4；Step 6 收尾。
