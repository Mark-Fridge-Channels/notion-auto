# 018 - Reply Tasks 配置页 + Gmail 发回复 · 探索

对《018-reply-tasks-page-and-gmail-send.md》需求做探索：理解现有实现、集成点与约束，并列出所有需澄清的问题。**不涉及实现。**

---

## 1. 现有代码与集成点

### 1.1 Dashboard 与配置

- **server.ts**：内嵌 HTML Dashboard，已有 Inbound Listener 配置卡片（groups：IM DB、Touchpoints DB、发件人库 URL、mailboxes）；API：`GET/POST /api/inbound-listener/config`、status/start/stop。
- **inbound-listener-config.ts**：独立 JSON `inbound-listener.json`，多组，每组 `inbound_messages_db_id`、`touchpoints_db_id`、`sender_accounts_database_url`、`mailboxes[]`。
- Reply Tasks 配置若独立存，可仿照：独立 JSON（如 `reply-tasks.json`）或扩展现有某配置；需至少「Reply Tasks 库 URL 列表 + 当前选中项」。

### 1.2 Notion 侧

- **notion-inbound.ts**：IM 表幂等查/建、Touchpoints 按 Thread ID 查、IM 行带 `Touchpoint` relation、写回 Touchpoint（Replied/Stopped 等）。**无** Reply Tasks 表的读/写。
- **notion-queue.ts**：Queue 表查询、发件人库 `fetchSenderCredentials(notion, senderAccountsDatabaseUrl, senderAccount)`，按 **Email 属性等于 Sender Account** 取 email + password。
- Touchpoint 与 Queue 为同一张表，有 `Sender Account`（rich_text）、`Thread ID` 等；IM 行有 `Touchpoint` relation 指向该表。

### 1.3 Gmail

- **gmail-send.ts**：`sendCold1`、`sendFollowup(threadId, messageIdLast, from, to, subject, htmlBody)`；`sendFollowup` 已支持 threadId + In-Reply-To/References（由 messageIdLast 构造）。
- **gmail-read.ts**：`getMessageAndParse` 拉取单条 message 并解析，**未**返回 RFC 5322 的 `Message-ID` header；若首版要严格设 In-Reply-To，需在此扩展或单独取 header。

### 1.4 数据流关系（当前理解）

- 入站邮件 → Inbound Listener 按 threadId 在 Touchpoints 表找到唯一行 → 写 IM 行并带 Touchpoint relation。
- 若「Reply Task」在 Notion 中通过 **relation 关联到 IM**，则：Task → IM page → 从 IM 取 Thread ID、从 IM 的 Touchpoint relation 取 Touchpoint page → Touchpoint 取 Sender Account。
- 若 Task 只存 **Task Notes 里的 inbound_message_id**（或类似），则需在**某个** IM 库里按 Message ID 查 IM；存在多组 Inbound 时有多套 IM 库，**必须明确「用哪套 IM/Touchpoint/发件人库」**才能解析出 threadId 与 Sender Account。

---

## 2. 需澄清的问题

### 2.1 Reply Task 与 IM / Touchpoint 的关联方式（关键）

- 在 Notion 的 **RE Reply Tasks** 数据库中，Task 行是如何关联到入站消息 / Touchpoint 的？
  - **A**：Task 有 **relation 指向 Inbound Message**（或指向 Touchpoint）？
  - **B**：仅 **Task Notes**（或某文本字段）里存了 inbound_message_id / thread_id 等，无 relation？
- 若是 B，则「从 Task 反查 IM」必须在某个 IM 库里查；多组 Inbound 存在多个 IM 库，**需要知道「该 Reply Tasks 库对应哪一组/哪个 IM 库」**，否则无法解析。是否约定：**每条 Reply Tasks URL 配置项同时绑定一套「IM DB + Touchpoints DB + 发件人库 URL」**（类似 Inbound 的一 group）？

### 2.2 发件人库与「当前选中」的语义

- 发回复时 Sender Account 来自 Touchpoint，凭据需从**某个**发件人库 URL 取。当前需求写「与 Inbound Listener / Queue 共用同一发件人库」：
  - 是**全局唯一**一个发件人库 URL（例如从 env 或某固定配置读）？
  - 还是**每个 Reply Tasks 库一条配置**：Reply Tasks DB URL + 发件人库 URL（+ 可选 IM DB、Touchpoints DB，用于从 Task 解析 threadId/Sender Account）？
- 「**切换**」是指：在多个 Reply Tasks **库 URL** 之间选一个作为「当前用于发回复/展示」的单选，对吗？是否有「按任务所属库自动选」等其它语义？

### 2.3 发回复的触发方式与粒度

- 发回复由谁、如何触发？
  - **方式 1**：用户在 Dashboard（或后续 Task 列表页）对**某一条 Task** 点「发送」→ 后端只处理这一条，发完回写 Done。
  - **方式 2**：有一个「处理当前选中库内所有待发 Task」的批量/后台 runner（类似 Queue Sender），轮询或定时执行。
- 若首版只做「单条发送」（方式 1），API 可为 `POST /api/reply-tasks/send` body `{ taskPageId }` 或 `{ taskPageId, replyTasksDbId }`；若要做方式 2，需要明确筛选条件（例如 Status = In Progress / Todo、Task Type = Draft Reply 等）。

### 2.4 邮件内容与收件人

- **正文**：是否一律用该 Task 的 **Suggested Reply** 作为邮件正文（纯文本转 HTML，如换行 → `<br>`）？若 Task Type 为 Schedule Call / Send Info 等，是否也发邮件，还是仅 **Draft Reply** 才发？
- **To**：回复时收件人应为「入站那封的 From Email」即 IM 的 `From Email`，是否按此约定？
- **Subject**：是否统一用 `Re: ${IM 的 Subject}`（若已有 Re: 前缀则不再加）？

### 2.5 Message-ID 与 In-Reply-To（可选，可首版从简）

- 需求提到：库中若只存 Gmail message id，严格设 In-Reply-To 需用 Gmail API 再取完整 message 的 `Message-ID` header。
- **首版**是否接受：暂时不设 In-Reply-To/References，或用占位/空，仅保证 `threadId` 正确，让 Gmail 仍能归入同一线程？还是必须首版就实现「取入站 message 的 Message-ID header 并写入 MIME」？

### 2.6 Status 与 Notion 字段名

- 回写 Done 时，Reply Tasks 库中 **Status** 字段的 Notion 类型是 **Status** 还是 **Select**？选项值是否确认为 **"Done"**（与需求描述一致）？若库中为其它选项名（如 "Completed"），是否需兼容？

---

## 3. 小结

- **实现前必须澄清**：Task ↔ IM/Touchpoint 的关联方式（2.1）以及发件人库/配置绑定方式（2.2）；否则无法确定「从 Task 解析 threadId、Sender Account、发件人凭据」的路径。
- **影响 API 与 UI**：触发方式（2.3）决定是「单条发送 API」还是「批量 runner + 筛选条件」。
- **内容与收件人**（2.4）、Message-ID 首版范围（2.5）、Status 字段类型（2.6）可在确认后写入实现说明或 PLAN，避免实现时再猜。

请按上述编号回复或补充，便于写入实现计划并开工。

---

## 4. 澄清结果（已确认）

- **2.1 Task ↔ IM**：在 Notion 里 Reply Task 通过 **relation 连到 Inbound Message**（即 Task → IM）。
- **2.2 切换**：有多个 Reply Tasks 的 **Notion 数据库地址**，需要在这些地址之间切换；切换后**查询并展示当前选中库对应的 Task 列表**。发件人库来源未单独说明，实现时可采用「每条 Reply Tasks 配置项带发件人库 URL」与当前选中的库绑定，便于多环境。
- **2.3 触发**：**允许单条发送，也允许批量发送**。批量发送时筛选 **Status ≠ Done** 的 Task 进行发送。
- **2.4 正文与收件人**：正文一律用 **Suggested Reply**，不按 Task Type（Draft Reply 等）区分；**用户可在界面上修改正文后再发送**。To / Subject 仍按 IM 的 From Email、Re: Subject（需求中已约定）。
- **2.5 Message-ID**：首版**可以不做** In-Reply-To/References 的严格实现，仅保证 threadId 正确即可。
- **2.6 Status**：Reply Tasks 库中的 **Status** 为 **Notion Status 类型**（非 Select）；完成态选项名为 **`Done`**，位于 **complete** 分组。

以上已同步到《018-reply-tasks-page-and-gmail-send.md》的「澄清与约定」小节，可直接作为实现依据。
