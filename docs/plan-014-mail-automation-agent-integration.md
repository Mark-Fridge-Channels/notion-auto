# Feature Implementation Plan: Warmup Executor 对接 Mail Automation Agent

**Overall Progress:** `100%`

## TLDR

将 Warmup Executor 的邮件操作从多平台 API（Gmail/Zoho/M365/SMTP）改为统一调用 Mail Automation Agent 的 minimal-server（`POST /command`）。新增 HTTP 客户端与单一 Agent 适配器，启动时做健康检查（失败则进程退出），配置通过环境变量与 queue-sender.json 可选项。

## Critical Decisions

- **单一适配器、不区分 platform**：Executor 固定使用 Mail Automation Agent；`getWarmupProviderAdapter()` 始终返回 Agent 适配器，不再按 Credential 的 platform 选择 Gmail/Zoho/M365/SMTP。
- **配置方式**：minimal-server 的 base URL、超时用**环境变量**；add_contact 的默认通讯录 ID 用 **queue-sender.json 顶层可选字段 + env 覆盖**（env 优先）。
- **健康检查**：启动后、进入轮询前检测 minimal-server 可达性；不可达则 **process.exit(1)** 并打 error 日志。
- **folderPath**：首版所有需文件夹的请求一律传 `"INBOX"`；**Open** 仅做 `open_message`（打开邮件），不做标为已读。
- **reply_to_message_id**：即 Thunderbird 的 headerMessageId，Reply 时直接传给 `reply_message`。

## Tasks

- [x] 🟩 **Step 1: Mail Automation Agent 客户端模块**
  - [x] 🟩 新增 `src/mail-automation-agent-client.ts`：实现 `command<T>(action, payload, options?)`，POST `${baseUrl}/command`，body 含 `request_id`、`action`、`payload`、可选 `idempotency_key`；超时用 AbortController，从 env 读 `MAIL_AUTOMATION_AGENT_BASE_URL`（默认 `http://127.0.0.1:3939`）、`MAIL_AUTOMATION_AGENT_TIMEOUT_MS`（默认 130000）。
  - [x] 🟩 定义并导出 `CommandResponse<T>` 类型（request_id, success, result?, error?）；处理 HTTP 504 与 JSON 解析，抛出或返回结构化错误。
  - [x] 🟩 实现 `healthCheck(): Promise<void>`：发送一次轻量 command（如 `switch_account_context` 空 payload 或最小 payload），若连接被拒绝或超时则 throw，若收到 200（含 success:false 的 VALIDATION/CONTEXT_NOT_SET）视为服务可达。

- [x] 🟩 **Step 2: 配置与环境变量**
  - [x] 🟩 在 `env.example` 中增加：`MAIL_AUTOMATION_AGENT_BASE_URL`、`MAIL_AUTOMATION_AGENT_TIMEOUT_MS`、`MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID`（可选），并加注释说明用途。
  - [x] 🟩 在 `queue-sender-config.ts` 的 `WarmupExecutorEntry` 中增加可选 `mail_automation_agent_default_address_book_id?: string`；校验与序列化时保留该字段；默认通讯录 ID 读取逻辑：env `MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID` 优先，否则用 entry 该字段。

- [x] 🟩 **Step 3: Warmup Provider 仅保留 Mail Automation Agent 适配器**
  - [x] 🟩 在 `warmup-provider.ts` 中移除对 `gmail-read`、`gmail-send`、`zoho-mail`、`m365-mail`、`smtp-mail` 的 import；删除 `GmailAdapter`、`ZohoAdapter`、`M365Adapter`、`SmtpAdapter` 类及 `warmupProviderAdapters` 数组。
  - [x] 🟩 新增 `MailAutomationAgentAdapter` 类，实现 `WarmupProviderAdapter`：`provider` 为固定字符串（如 `"MailAutomationAgent"`）；`supports(eventType)` 支持 Send、Reply、Open、Star、Add Contact、Wait。
  - [x] 🟩 `execute(context)` 内：先根据 `context.item.actorMailboxId || context.item.account`（或 credential.account）调用 `command("switch_account_context", { email })`，从 result 取 `accountId`；再按 `plannedEventType` 调用对应 action（send_email / reply_message / open_message / star_message / add_contact），folderPath 固定 `"INBOX"`；Reply 使用 `item.replyToMessageId` 作为 headerMessageId，可选 `idempotency_key: reply-${headerMessageId}`；Add Contact 使用 context 传入的 defaultAddressBookId（Step 4 中通过 context 扩展传入）。
  - [x] 🟩 将扩展返回的 `error.code` 映射为可读失败原因（TIMEOUT→timeout, CONTEXT_NOT_SET→credential_not_found, NOT_FOUND→not_found, API_ERROR/VALIDATION→api_error 等），失败时 throw Error 或返回以便 queue-sender 的 catch 里调用 failItem。
  - [x] 🟩 `getWarmupProviderAdapter(_provider?)` 改为始终返回 `MailAutomationAgentAdapter` 单例（或每次 new），不再根据 provider 查找；`WarmupActionExecutionResult.provider` 使用 `"MailAutomationAgent"`（需在类型上允许该字符串，见 Step 5）。

- [x] 🟩 **Step 4: 执行上下文支持 defaultAddressBookId**
  - [x] 🟩 扩展 `WarmupProviderExecutionContext` 或 `createWarmupProviderExecutionContext` 的入参：增加可选 `options?: { defaultAddressBookId?: string }`；context 中携带该值供 Agent 适配器在 Add Contact 时使用。
  - [x] 🟩 在 `queue-sender.ts` 的 `processOne` 中，调用 `createWarmupProviderExecutionContext(item, credential, { defaultAddressBookId: entry.mail_automation_agent_default_address_book_id ?? process.env.MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID })`（需确保 entry 类型已含该可选字段，见 Step 2）。

- [x] 🟩 **Step 5: 类型与 runtime 兼容**
  - [x] 🟩 在 `warmup-runtime.ts` 或 `warmup-provider.ts` 中，将 `WarmupProviderKey` 扩展为包含 `"MailAutomationAgent"`，或让 `WarmupActionExecutionResult.provider` 类型接受该字符串，保证 Execution Log 写入与现有字段兼容。
  - [x] 🟩 确认 `queue-sender.ts` 中不再因 `provider === null` 走到 unsupported_provider（因 getWarmupProviderAdapter 始终返回适配器）；若有对 `runtime.provider` 的依赖，改为不依赖或兼容新 provider 名。

- [x] 🟩 **Step 6: 启动时健康检查并退出**
  - [x] 🟩 在 `queue-sender.ts` 的 `main()` 中，在 `for (;;)` 循环之前：调用 `mail-automation-agent-client` 的 `healthCheck()`；若抛出，则 `logger.error` 并 `process.exit(1)`，确保进程不进入轮询。
  - [x] 🟩 健康检查仅在进程启动时执行一次；不要求每轮前都检查。

- [x] 🟩 **Step 7: 结果映射与 Wait**
  - [x] 🟩 Agent 适配器从各 action 的 result 中取 `headerMessageId` / `messageId` / `stableIdentifiers` 等，填充 `WarmupActionExecutionResult` 的 `messageId`、`threadId`、`metadata`，满足 queue-sender 与 Execution Log 写入需求。
  - [x] 🟩 Wait 事件：不调用 minimal-server，直接返回 noop 结果（与现有多平台 Adapter 行为一致）。

- [x] 🟩 **Step 8: 文档与收尾**
  - [x] 🟩 在 README 或 `docs/` 中补充：Warmup Executor 依赖 minimal-server 与 Thunderbird 扩展；启动顺序与 env 说明（见 issue 014 与 env.example）。
  - [x] 🟩 确认无遗留 console.log、未移除的旧 adapter 引用；跑一次 TypeScript 编译与现有测试（若有）通过。
