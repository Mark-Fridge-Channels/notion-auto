# Warmup Executor 邮件操作改为对接 Mail Automation Agent（minimal-server）

**类型:** feature  
**优先级:** normal  
**投入:** high  

---

## TL;DR

将 Warmup Executor 的所有邮件相关操作（发信、回复、打开、标星、加联系人等）从「按平台调用各厂商 API（Gmail / Zoho / M365 / SMTP）」改为「统一通过 Mail Automation Agent 扩展的 minimal-server HTTP 接口」执行。外部程序（即本仓库的 Warmup Executor）只需向 `http://127.0.0.1:3939/command` 发送约定格式的 JSON，由 Thunderbird + 扩展完成实际操作，不再直接集成各平台 API。

---

## 当前状态 vs 期望

- **当前：**  
  - `src/warmup-provider.ts` 内按 `provider`（Gmail / Zoho / Microsoft 365 / SMTP）选择对应 Adapter（GmailAdapter、ZohoAdapter、M365Adapter、SmtpAdapter）。  
  - 每种 Adapter 直接调用 `gmail-send`、`zoho-mail`、`m365-mail`、`smtp-mail` 等模块的 API（refresh_token、access_token、各平台 REST/IMAP/SMTP）。  
  - 凭据与平台强绑定，需在 Notion/Credential Registry 中区分 provider，并配置对应 OAuth/密钥。

- **期望：**  
  - Warmup Executor 侧**不再**依赖 Gmail/Zoho/M365/SMTP 的 API 或 token。  
  - 所有邮件操作统一通过 **minimal-server** 的 `POST /command` 完成，请求体为 `{ request_id, action, payload [, idempotency_key ] }`。  
  - 动作与文档一致：`switch_account_context`、`send_email`、`reply_message`、`open_message`、`resolve_message`、`star_message`、`add_contact`、`forward_message` 等。  
  - 前置条件由文档约定：先启动 `node minimal-server/server.js`（默认 `127.0.0.1:3939`），Thunderbird 已安装并加载 Mail Automation Agent 扩展；外部程序与 minimal-server 同机或可访问该端口。

---

## 对接协议要点（来自文档）

- **唯一入口：** `POST http://127.0.0.1:3939/command`，`Content-Type: application/json`。  
- **请求体：** `request_id`（必填）、`action`（必填）、`payload`（必填）、`idempotency_key`（可选，send_email / reply_message 支持）。  
- **响应：** 200 时 body 为 `{ request_id, success, result? }` 或 `{ request_id, success: false, error: { code, message, details? } }`；504 表示扩展超时（默认 120s，可 `COMMAND_TIMEOUT_MS` 调节）。  
- **错误码：** VALIDATION、NOT_FOUND、CONTEXT_NOT_SET、API_ERROR、TIMEOUT。  
- **推荐流程：** 多轮操作前先 `switch_account_context`（按 email/accountId/identityId）；回复时可用 `resolve_message` 取 `headerMessageId` 再 `reply_message`；防重复回复使用 `idempotency_key`。

---

## 动作与现有 Warmup 事件类型的对应关系（建议）

| Warmup 计划事件 | minimal-server action     | 说明 |
|-----------------|---------------------------|------|
| Send            | send_email                | to, subject, plainTextBody；可选 identityId/accountId（或先 switch_account_context） |
| Reply           | reply_message             | 目标：messageId / headerMessageId / folderPath+subject；plainTextBody；支持 idempotency_key |
| Open            | open_message              | accountId + folderPath/folderId + 定位（headerMessageId 或 subject/from/to/日期） |
| Star            | star_message              | accountId + 目标（messageId / headerMessageId / folderPath+subject）；starred 默认 true |
| Add Contact     | add_contact               | email + addressBookId/parentId；可选 displayName 等 |
| （若后续支持）  | resolve_message / forward_message | 按文档 payload 映射 |

---

## 涉及文件

- **核心逻辑：**
  - `src/warmup-provider.ts` — 用「Mail Automation Agent 适配器」替代现有 Gmail/Zoho/M365/Smtp 四个 Adapter；实现基于 `fetch` 的 `command()`，按 `plannedEventType` 映射到对应 action 与 payload；保留 `WarmupActionDescriptor` / `WarmupActionExecutionResult` 等接口形态，便于 `queue-sender.ts` 不改调用方式。
- **配置与运行时：**
  - `src/warmup-runtime.ts` — 若仍需要「当前执行账号」概念，可能仅保留与 Notion 凭据解析相关的部分；provider 可固定为单一类型（如 "MailAutomationAgent"）或从配置读取 minimal-server 的 base URL/端口。
  - `src/queue-sender-config.ts` — 如需从配置读取 minimal-server 的 base URL 或超时时间，在此扩展。
- **可考虑精简（本 issue 范围内可选）：**
  - `src/gmail-send.ts`、`src/zoho-mail.ts`、`src/m365-mail.ts`、`src/smtp-mail.ts`、`src/gmail-read.ts` — 若 Warmup Executor **仅**通过 minimal-server 执行邮件操作，这些模块可不再被 Warmup 路径引用；若项目其他功能（如非 Warmup 的发信/读信）仍使用，则保留且仅从 warmup-provider 中移除依赖。

---

## 实现要点（建议）

1. **新增 minimal-server 客户端**  
   在 `warmup-provider.ts` 或独立模块（如 `mail-automation-agent-client.ts`）中实现 `command<T>(action, payload, options?)`：POST `/command`、JSON body、request_id、可选 idempotency_key、超时（建议 130_000 ms，略大于服务端 120s）。

2. **账号上下文**  
   执行一批任务前，根据 Queue 项/凭据中的邮箱（或 accountId）调用 `switch_account_context`，后续 send_email / reply_message 等可省略 accountId/identityId。

3. **Send**  
   `send_email`：payload 含 to（可数组）、subject、plainTextBody、可选 cc/bcc；dry_run 按需；idempotency_key 可选。

4. **Reply**  
   若 Queue 中已有 headerMessageId 或可由 resolve_message 得到，则 `reply_message` 传 headerMessageId + accountId + folderPath + plainTextBody；建议 idempotency_key 如 `reply-${headerMessageId}` 防重复。

5. **Open / Star / Add Contact**  
   按文档 payload 从 WarmupQueueItem / credential 中取 accountId、folderPath、subject、messageId/headerMessageId 等填充。

6. **错误与日志**  
   将 minimal-server 返回的 `error.code` / `error.message` 映射为 Executor 侧失败原因（如 credential_not_found、api_error、timeout），便于 Notion 回写与排查。

7. **Mark Read**  
   文档未单独列出「标为已读」action；若扩展后续提供或通过 open 等间接实现，再在适配层补充；否则当前 MarkRead 事件类型可暂不实现或标记为 unsupported。

---

## 风险与备注

- **依赖运行环境：** minimal-server 与 Thunderbird 扩展必须先启动且可用，否则所有 Warmup 邮件操作会失败（连接被拒绝或 504）。建议在 Executor 启动或首轮前做一次健康检查（如 POST /command 简单 action 或单独 health 端点若有）。
- **超时：** 扩展执行可能较慢（如弹出发送确认），客户端超时应 ≥ 服务端 COMMAND_TIMEOUT_MS，并统一错误提示。
- **凭据形态：** 当前 Credential Registry 可能存的是各平台 refresh_token；改为 Agent 对接后，可能仅需「邮箱 + 在 Thunderbird 中已配置的账号」即可，需确认 Notion 中是否仍用同一套 Credential 表（仅语义变为「Thunderbird 账号」）。
- **与 issue 012 的关系：** 012 针对「Executor 不执行」的排查；本 issue 完成后，不执行的原因可能变为「minimal-server 未启动 / 扩展未就绪」等，日志与文档需体现。

---

## 探索阶段已确认结论（Clarifications）

- **Credential / Platform**：对接后不再区分 Notion Credential 的 platform（Gmail/Zoho/M365/SMTP）；只需能解析出「账号」（邮箱）。Executor 固定使用 Mail Automation Agent 适配器，不再按 platform 选多平台 Adapter。
- **reply_to_message_id**：约定为 Thunderbird 的 **headerMessageId**（邮件头 Message-ID）；Reply 时直接传给 `reply_message` 的 payload。
- **folderPath（都先用 INBOX）**：  
  minimal-server 的 `open_message`、`reply_message`、`star_message`、`resolve_message` 等需要指定**邮件所在文件夹**（如收件箱、已发送）。「都先用 INBOX」指：首版实现里，所有需要 folderPath 的请求**一律传 `"INBOX"`**（Thunderbird 收件箱），不从 Queue 或 Credential 读其他文件夹。  
  **含义**：当前 Warmup 场景下，要打开/回复/标星的那封邮件默认都在收件箱；若将来需要操作「已发送」「草稿」等，再扩展为从配置或 Notion 读取 folderPath。
- **add_contact 的 addressBookId**：采用 **queue-sender.json 或 env 配置默认通讯录 ID**（选项 B）。需在配置形态上增加一项（如顶层可选 `mail_automation_agent_default_address_book_id`，或通过 env 如 `MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID` 读取）。
- **minimal-server 配置**：base URL、端口、超时等**全部通过环境变量**配置（例如 `MAIL_AUTOMATION_AGENT_BASE_URL` 默认 `http://127.0.0.1:3939`，`MAIL_AUTOMATION_AGENT_TIMEOUT_MS` 默认 130000）。
- **健康检查失败**：若启动或首轮前发现 minimal-server 不可达，**直接让进程退出并告警**（不仅跳过本轮打日志）。
- **Open 语义**：首版只做「打开邮件」（对应扩展的 `open_message`，在浏览器中打开该封邮件），不做「标为已读」。
- **执行结果回填**：`WarmupActionExecutionResult` 从扩展返回的 result 中取能满足文档约定、推进 Queue 与 Execution Log 的字段即可（如 messageId/headerMessageId、stableIdentifiers 等按需映射）。

---

## 验收

- Warmup Executor 在「仅启动 minimal-server + Thunderbird 扩展、不配置 Gmail/Zoho/M365 等 token」的前提下，能对 Queue 中的 Send/Reply/Open/Star/Add Contact 等任务按文档协议调用 `/command` 并正确推进状态、写 Execution Log。
- 不再依赖 `gmail-send`、`zoho-mail`、`m365-mail`、`smtp-mail` 在 Warmup 执行路径上的调用（其他非 Warmup 功能可保留原有调用）。
