# 邮件发送与监听兼容 Zoho 与 Microsoft 365

**类型**：feature  
**优先级**：normal  
**预估**：medium–high

## TL;DR

当前发信与入站监听仅支持 Gmail（OAuth2）。需要扩展为支持 **Zoho** 与 **Microsoft 365**，使发件人库可混用不同邮箱厂商的账号（发信 + 读信）。

## 当前状态

- **发信**：`gmail-send.ts` + Gmail OAuth2，发件人库 `password` 列存 `refresh_token`；Queue Sender、Reply Tasks 发信均走 Gmail API。
- **监听**：`gmail-read.ts` 拉取 Gmail 邮件，Inbound Listener 写 Notion；同一套 GMAIL_CLIENT_ID/SECRET，需 `gmail.readonly`。
- **配置**：env 仅 Gmail（GMAIL_CLIENT_ID/SECRET）；发件人库无「厂商」区分。

## 期望结果

- 发件人库可配置每个发件人所属厂商（如 Gmail / Zoho / Microsoft 365）。
- 发信时按厂商选用对应 API/协议（Gmail API、Zoho Mail API、Microsoft Graph 等）。
- 入站监听支持按厂商拉取收件箱（Zoho IMAP/API、M365 Graph 等）。
- 凭据与配置方式按厂商区分（OAuth2 各厂商一套或 SMTP/IMAP 等），不破坏现有 Gmail 用法。

## 涉及文件（主要）

- `src/gmail-send.ts`、`src/gmail-read.ts` — 抽象为「发信/读信」接口或按厂商分支。
- `src/queue-sender.ts`、`src/reply-tasks-send.ts` — 发信入口，需按发件人厂商选实现。
- `src/inbound-listener.ts`、`src/dashboard-inbound-listener-runner.ts`、`src/notion-inbound.ts` — 监听入口，需支持多厂商拉信。
- `env.example`、发件人库结构 — 新增 Zoho/M365 相关 env 与列（如 Provider、或各厂商 refresh_token 列）。

## 风险与备注

- 各厂商 OAuth2 流程、scope、token 存储方式不同，需分别实现或封装统一「邮件发送/读信」接口。
- Zoho、M365 可能有 SMTP/IMAP 方案，若采用则与现有 Gmail OAuth2 并存，配置与安全（密码 vs token）需统一约定。
- 发件人库 schema 变更（如新增 Provider 列）需兼容旧数据（默认 Gmail）。
