# Code Review: PLAN-030 邮件 Zoho / Microsoft 365 兼容

## ✅ Looks Good

- **Logging**：无 `console.log`；queue-sender、reply-tasks-send、inbound-listener 均使用 `logger`，带 pageId/mailbox/taskId 等上下文。
- **TypeScript**：无 `any`、无 `@ts-ignore`；`SenderCredentials`、`ZohoSendResult`、`M365SendResult`、`ZohoMessageListItem`、`M365MessageListItem` 等类型清晰。
- **架构**：与现有 Gmail 路径一致，按 Provider 分支；notion-queue 只读 Notion，zoho-mail/m365-mail 只做 HTTP，职责清晰。
- **错误处理**：reply-tasks-send 用 try/catch 统一返回 `SendOneResult`；queue-sender 重试与回写失败逻辑保留；inbound-listener 单条失败只 log、不中断整轮。
- **安全**：未在 log 或错误信息中输出 password/refresh_token；env 从 process.env 读取，无硬编码密钥。
- **兼容**：发件人库无 Provider 列或为空时 `getProviderFromProps` / `getProviderFromImProps` 返回 `"Gmail"`；未知 provider 时 Queue/Reply 回写失败、Inbound 打 log 并跳过。
- **Notion 写入**：`createInboundMessageRow` 的 Provider 使用 Select name，与文档约定一致；必填字段与截断（bodyPlain、messageTitle 等）与现有逻辑一致。

---

## ⚠️ Issues Found

### **[MEDIUM]** [src/zoho-mail.ts:152–156](src/zoho-mail.ts) - Zoho 发信 API 若未返回 messageId 会抛错

- **问题**：`sendZohoCold1` 将响应解析为 `res.data?.messageId`，若 Zoho 文档中发信接口实际不返回 `messageId`，会抛 `"Zoho 发信未返回 messageId"`，导致整条 Queue 回写失败。
- **Fix**：若官方响应无 messageId，改为不抛错，返回占位：`return { messageId: "", threadId: "zoho-sent" };`，与 M365 Cold1 一致；或先查文档/实际响应再决定是否保留严格校验。

### **[MEDIUM]** [src/m365-mail.ts:109](src/m365-mail.ts) - M365 Cold1 回写 Notion 的 messageId 为占位

- **问题**：`sendM365Cold1` 返回 `messageId: ""`、`threadId: "m365-cold1"`。Queue 成功回写使用 `result.messageId || result.threadId`，会写入 `"m365-cold1"` 到 Message ID Last，语义上并非真实 message id，后续若有依赖「同一会话」的 Followup 可能受影响。
- **Fix**：在文档或注释中说明 M365 新邮件不返回 messageId，故 Message ID Last 为占位；若后续要实现 M365 Followup，需改为从「已发送」文件夹查最近一条取 id，或接受仅 Gmail/Zoho 支持严格 Followup。

### **[LOW]** [src/zoho-mail.ts:48–50](src/zoho-mail.ts)、[src/m365-mail.ts:37–39](src/m365-mail.ts) - Token 失败时错误信息含 API 响应全文

- **问题**：`throw new Error(\`Zoho token 请求失败: ${res.status} ${t}\`)` 等将 `res.text()` 完整写入异常，若 OAuth 接口返回敏感信息（少见但可能），会进入 Notion 的 stopReason 或 log。
- **Fix**：生产环境可只保留 status 与简短原因（如解析 JSON 取 `error_description` 前 200 字符），或避免把完整 body 写入 Notion；当前实现对排查问题有帮助，可先保留并在文档中说明「错误信息可能包含 API 返回内容」。

### **[LOW]** [src/notion-inbound.ts:110](src/notion-inbound.ts) - Provider 与 Notion Select 选项必须完全一致

- **问题**：`"Provider": { select: { name: providerName } }` 要求 Notion 中该列已存在同名选项（如 "Microsoft 365" 含空格）；若用户建列时写成 "Microsoft365" 或 "M365"，会写失败或创建新选项（视 Notion 设置而定）。
- **Fix**：在 README 或 env.example 注释中明确写：Provider 列 Select 选项须为 **Gmail**、**Zoho**、**Microsoft 365**（拼写与空格一致）。

### **[LOW]** [src/zoho-mail.ts](src/zoho-mail.ts)、[src/m365-mail.ts](src/m365-mail.ts) - 无网络重试

- **问题**：gmail-read 有 `withRetry` 应对 TLS/网络瞬时失败，zoho-mail 与 m365-mail 的 fetch 无重试，偶发网络问题会直接失败。
- **Fix**：若希望行为与 Gmail 一致，可为 Zoho/M365 的 token 与 API 请求加简单重试（如最多 3 次、间隔 2s）；非必须，可作后续优化。

---

## 📊 Summary

- **Files reviewed:** 8（notion-queue, zoho-mail, m365-mail, queue-sender, reply-tasks-send, notion-reply-tasks, inbound-listener, notion-inbound）
- **Critical issues:** 0  
- **Warnings (MEDIUM):** 2（Zoho 发信 messageId 假设；M365 Cold1 messageId 占位语义）  
- **LOW:** 3（错误信息可能含 API 内容；Provider 选项命名；无重试）

总体实现符合现有风格与 PLAN-030，可直接使用；建议先确认 Zoho 发信 API 实际响应结构，并补充文档说明 M365 新邮件无 messageId 及 Provider 选项命名约定。
