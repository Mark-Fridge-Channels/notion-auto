# Feature Implementation Plan: 030 邮件发送与监听兼容 Zoho / Microsoft 365

**Overall Progress:** `100%`

## TLDR

发信与入站监听当前仅支持 Gmail。扩展为支持 **Zoho** 与 **Microsoft 365**：发件人库与 IM 表在 Notion 中新增 **Provider** 列；凭据共用 **password** 列、按 Provider 解析；发信/读信按 Provider 分支调用 Gmail API、Zoho Mail API、Microsoft Graph API；同一 group 可混用厂商，Reply 发信按 IM 的 Provider 选 API。不破坏现有 Gmail 用法，兼容无 Provider 时视为 Gmail。

## Critical Decisions

- **Provider 来源**：发件人库与 📥 IM 表均在 Notion 中新增属性列 **Provider**（Select：Gmail / Zoho / Microsoft 365）。发件人凭据从 Notion 读取该列；IM 写入时取发件人库该行的 Provider。不依赖 env 推断厂商。
- **凭据**：共用 **password** 列存各厂商 refresh_token；按 Provider 决定如何用 password（Gmail/Zoho/M365 各自 OAuth 续期与调用）。
- **Zoho 区域 / M365 tenant**：Zoho 的 token 与 API base（com/eu/com.cn）用 env **ZOHO_REGION**（默认 com）；M365 的 tenant 用 env **M365_TENANT**（默认 common）。首版不放在发件人库扩展列。
- **Reply 发信**：从 IM 读 **Thread ID**、**Message ID**、**Provider**。Gmail 用 threadId 调 sendInThread；Zoho/M365 用 Message ID 调各自「回复单封」API（Zoho POST …/messages/{messageId} action=reply，Graph POST …/messages/{id}/reply）。
- **兼容**：发件人库无 Provider 列或该列为空时，视为 **Gmail**。IM 表需用户预先新增 Provider 列后再写入；旧 IM 行无 Provider 时 Reply 可约定按 Gmail 或按缺省处理（实现时明确一种）。

## Tasks

- [x] 🟩 **Step 1: 发件人凭据扩展（Notion Provider 读取）**
  - [x] 🟩 `notion-queue.ts`：`fetchSenderCredentials` 从发件人库行中读取 **Provider** 列（Select 取 name，或 Rich text 取文本），返回 `{ email, password, provider }`；provider 缺省、空或发件人库无该列时设为 `"Gmail"`。
  - [x] 🟩 导出 `SenderCredentials` 类型；调用方在 Step 4/5 改为使用 `creds.provider` 分支。

- [x] 🟩 **Step 2: Zoho Mail 模块（发信 + 读信）**
  - [x] 🟩 新增 `src/zoho-mail.ts`：getZohoAccessToken、getZohoAccountId、getZohoInboxFolderId、sendZohoCold1、sendZohoReply、listZohoInboxMessageIds、getZohoMessageAndParse；env ZOHO_REGION 默认 com。
  - [x] 🟩 `env.example` 增加 ZOHO_CLIENT_ID、ZOHO_CLIENT_SECRET、ZOHO_REDIRECT_URI、ZOHO_REGION 与 M365_* 说明。

- [x] 🟩 **Step 3: Microsoft Graph 模块（发信 + 读信）**
  - [x] 🟩 新增 `src/m365-mail.ts`：getM365AccessToken、sendM365Cold1、sendM365Reply、listM365InboxMessageIds、getM365MessageAndParse；env M365_TENANT 默认 common。

- [x] 🟩 **Step 4: Queue Sender 与 Reply Tasks 按 Provider 发信**
  - [x] 🟩 `queue-sender.ts`：按 `creds.provider` 分支 Gmail/Zoho/Microsoft 365，未知 provider 回写失败。
  - [x] 🟩 `notion-reply-tasks.ts`：`ReplyTaskSendContext` 增加 `provider`、`messageId`；`getReplyTaskSendContext` 从 IM 读 Provider、Message ID。
  - [x] 🟩 `reply-tasks-send.ts`：按 `ctx.provider` 分支；Zoho/M365 回复需 ctx.messageId。

- [x] 🟩 **Step 5: Inbound Listener 按 Provider 读信、IM 写入 Provider**
  - [x] 🟩 `inbound-listener.ts`：按 `creds.provider` 调用 gmail-read / zoho-mail / m365-mail 列收件箱与解析；`processOneMessage` 传入 provider。
  - [x] 🟩 `notion-inbound.ts`：`createInboundMessageRow` 增加必填参数 provider，写入 IM 表 Provider（Select）。
  - [x] 🟩 README 增加多厂商与 Provider 列说明。

- [x] 🟩 **Step 6: 兼容与收尾**
  - [x] 🟩 发件人库无 Provider 列时 `getProviderFromProps` 返回 `"Gmail"`；未知 provider 时 Queue/Reply 回写失败、Inbound 跳过并打 log。
  - [x] 🟩 节流保持按发件人维度，未改。
  - [x] 🟩 token 获取脚本不纳入本计划；queue-sender.json.example 已存在，未改。
