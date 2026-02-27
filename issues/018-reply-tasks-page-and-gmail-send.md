# 018 - Reply Tasks 配置页 + Gmail 发回复并回写 Done

**Type:** feature  
**Priority:** normal  
**Effort:** medium  

---

## TL;DR

新增 Dashboard 页面：用户可保存/更新「Reply Tasks」对应的 Notion 数据库 URL 列表，并可在多个配置间切换。在此基础上，实现从 Reply Task 发 Gmail 回复（From=Touchpoint 的 Sender Account，threadId=入站消息的 Thread ID），发送成功后把 Notion 中该任务状态更新为 Done。

---

## 背景：RE Reply Tasks 数据库

- **用途**：需人工/程序完成的「回复类待办」，多由 Prompt/流程在检测到 Touchpoint 有入站邮件后生成，驱动后续动作（起草回复、安排电话、发资料等）。
- **常用字段**：`Task Summary`（标题）、`Status`（Todo / In Progress / Blocked / Done）、`Task Type`（Draft Reply / Schedule Call / Send Info 等）、`Suggested Reply`（AI 草拟正文，纯文本+换行）、`Task Notes`（如 inbound_message_id 等）。

---

## 需求拆解

### 1) 新页面：Reply Tasks URL 列表的保存、更新与切换

- 用户可在 Dashboard 上管理「Reply Tasks」对应的 Notion 数据库 URL 列表（可多条）；每条可带发件人库 URL，与当前选中库绑定。
- 支持保存、更新、以及**切换**：切换 = 选择当前使用的 Reply Tasks 库，并**查询该库的 Task 列表**在页面上展示。
- 持久化方式可与现有 Inbound Listener 配置类似（如独立 JSON），具体实现时定。

### 2) 用 Gmail 发回复时的规则

- **From**：使用 **Touchpoint 的 Sender Account** 对应的发信邮箱（与当初外联用同一账号），保证同一对话线程一致。
- **threadId**：使用 **Inbound Message（RE Inbound Messages）里的 Thread ID**；发信时在 Gmail API 的 `users.messages.send` 中带上该 `threadId`，并在 raw MIME 中设置 `In-Reply-To` 和 `References`（可用入站 Message-ID 或已保存的上一封 outbound Message-ID 构造），使 Gmail 将回复归入同一线程。
- **实现**：基于现有 Gmail API（如 `gmail-send.ts` 的 `sendFollowup`），需从 Notion 取到：Task 关联的 Inbound Message / Touchpoint、Sender Account、Thread ID、以及用于 In-Reply-To/References 的 Message-ID（若库中存的是 Gmail message id，需通过 Gmail API 再取完整 message 拿到 RFC 5322 的 `Message-ID` header，若暂无则可用现有逻辑尽量兼容）。

### 3) 发送完成后回写 Notion

- 发送成功后，将对应 Reply Task 在 Notion 中的 **Status** 更新为 **Done**。

---

## Current state

- Dashboard 已有 Inbound Listener 配置页（保存/编辑 groups、IM DB、Touchpoints DB、发件人库等），无「Reply Tasks」URL 列表管理。
- 已有 Gmail 发信（Cold1 / Followup）、发件人库按 Sender Account→Email 取凭据；无「从 Reply Task 发回复并回写 Done」的流程。

---

## Expected outcome

1. **Reply Tasks 配置页**：用户可添加/编辑/删除/切换多条 Notion Reply Tasks 数据库 URL（含发件人库 URL），持久化；切换后展示**当前选中库的 Task 列表**。
2. **发回复流程**：支持**单条发送**（用户选一条 Task，可编辑正文后发送）与**批量发送**（筛选 Status ≠ Done 的 Task）。从 Task → IM（relation）→ Thread ID、Touchpoint → Sender Account；From = Sender Account 对应邮箱，threadId = IM 的 Thread ID；用 Gmail API 发送（threadId，首版可不设 In-Reply-To/References）→ 成功后将该 Task 的 Status 更新为 Done（Notion Status 类型，选项名 Done）。
3. **正文**：默认用 Task 的 Suggested Reply，**用户可在前端修改正文后再发送**。
4. **数据与权限**：发信凭据从配置项中的发件人库 URL + Sender Account 匹配；Notion 回写需 Integration 有 Reply Tasks 库的写权限。

---

## Relevant files

- `src/server.ts` — 新增 Reply Tasks 配置 API 与 Dashboard 上「Reply Tasks 配置」卡片/列表 UI；若发回复由前端或现有 runner 触发，需加对应接口。
- 新建或扩展配置模块（如 `reply-tasks-config.ts` 或扩展现有 JSON schema）— 存 Reply Tasks URL 列表与当前选中项。
- `src/gmail-send.ts` — 已有 `sendFollowup`，可复用于带 threadId 的回复；若需从 Gmail 取 Message-ID header，可能需在 `gmail-read.ts` 或新模块中取完整 message。
- `src/notion-inbound.ts` 或新建 `src/notion-reply-tasks.ts` — 读 Reply Task、关联的 Inbound Message/Touchpoint（含 Sender Account、Thread ID）、更新 Task Status 为 Done。
- `src/notion-queue.ts` — `fetchSenderCredentials(notion, senderAccountsDatabaseUrl, senderAccount)` 可复用于按 Sender Account 取发信凭据。

---

## 澄清与约定（实现依据）

- **Task ↔ IM**：Reply Task 在 Notion 中通过 **relation 指向 Inbound Message**。解析链：Task → IM page → Thread ID、Touchpoint relation → Touchpoint → Sender Account。
- **切换**：配置为多条 **Reply Tasks 数据库 URL**；切换 = 选择当前使用的库，并**查询该库的 Task 列表**展示。每条配置可带 **发件人库 URL**（与当前选中库绑定），用于按 Sender Account 取凭据。
- **发送**：支持**单条发送**与**批量发送**。批量时筛选 **Status ≠ Done** 的 Task。
- **正文**：一律用 **Suggested Reply** 作为正文（不按 Task Type 区分）；**用户可在前端修改正文后再发送**。To = IM 的 From Email，Subject = Re: IM 的 Subject。
- **Message-ID**：首版可不实现 In-Reply-To/References，仅传 threadId 即可。
- **Status 回写**：Reply Tasks 的 Status 为 **Notion Status 类型**；完成态选项名为 **`Done`**（在 complete 分组）。

---

## Risks / Notes

- **发件人库**：与 Inbound Listener / Queue 共用同一套凭据逻辑（按 Sender Account 匹配 Email 取 refresh_token）；发件人库 URL 建议随每条 Reply Tasks 配置项存储，与「当前选中的库」一致。
