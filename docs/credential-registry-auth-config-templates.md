# Credential Registry · auth_config_json 模板

Warmup Executor 通过 Credential Registry 的 `platform` 与 `auth_config_json` 决定使用哪类 provider。下表为四类 provider 的**可填字段**与必填/选填说明；未列在表中的 Registry 字段（如 `refresh_token`、`account`、`mailbox_id`、`login_username`、`password`）仍按现有逻辑从对应属性读取。

---

## 1. Gmail

**Registry 必填**：`platform` = `Gmail`（或 `Google` / `Google Workspace`），`refresh_token` 必填（OAuth2 刷新令牌）。

**auth_config_json**：Gmail 走原生 API，通常**可不填**；若填则仅作可选提示，执行器不依赖其内容。

```json
{
  "provider": "Gmail"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 否 | 与 Registry 的 `platform` 一致即可，用于展示或兼容 |

**环境变量**：`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`（与 refresh_token 配套使用）。  
**所需权限**：Gmail API `gmail.send`、`gmail.modify`；Google People API 联系人写入（用于 Add Contact）。

---

## 2. Zoho

**Registry 必填**：`platform` = `Zoho`（或 `Zoho Mail`），`refresh_token` 必填。

**auth_config_json**：Zoho 走原生 API，通常**可不填**。

```json
{
  "provider": "Zoho"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 否 | 与 Registry 的 `platform` 一致即可 |

**环境变量**：`ZOHO_CLIENT_ID`、`ZOHO_CLIENT_SECRET`，可选 `ZOHO_REDIRECT_URI`、`ZOHO_REGION`。  
**所需权限**：Zoho Mail 发信与消息更新；Zoho Contacts 创建联系人（用于 Add Contact）。

---

## 3. Microsoft 365

**Registry 必填**：`platform` = `Microsoft 365`（或 `M365` / `Office 365` / `Outlook`），`refresh_token` 必填。

**auth_config_json**：M365 走 Microsoft Graph，通常**可不填**。

```json
{
  "provider": "Microsoft 365"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `provider` | 否 | 与 Registry 的 `platform` 一致即可 |

**环境变量**：`M365_CLIENT_ID`、`M365_CLIENT_SECRET`，可选 `M365_TENANT`。  
**所需权限**：`Mail.ReadWrite`、`Mail.Send`、`Contacts.ReadWrite`。

---

## 4. SMTP（兼容非三大平台）

用于非 Gmail / Zoho / M365 的邮箱。执行器按动作拆分为：**Send/Reply → smtp**，**Open/Star → imap**，**Add Contact → contacts (CardDAV)**。缺哪一块，对应动作会失败并回写 Queue。

**Registry 建议**：`platform` = `SMTP`；`account` / `mailbox_id` / `login_username` 填邮箱标识；若 SMTP/IMAP 共用同一账号密码，可在 `password` 填一份，并在 `auth_config_json` 的 `smtp`/`imap` 中省略或复用。

**auth_config_json 必填结构**：

```json
{
  "provider": "SMTP",
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "username": "user@example.com",
    "password": "填写 SMTP 密码",
    "fromEmail": "user@example.com",
    "fromName": "可选显示名"
  },
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "username": "user@example.com",
    "password": "填写 IMAP 密码",
    "mailbox": "INBOX",
    "starFlag": "\\\\Flagged"
  },
  "contacts": {
    "type": "carddav",
    "baseUrl": "https://contacts.example.com/addressbooks/user/default/",
    "username": "user@example.com",
    "password": "CardDAV 密码"
  },
  "messageLookup": {
    "useReplyToMessageId": true,
    "useThreadId": true,
    "fallbackToSubjectSearch": true,
    "fallbackToCounterpartySearch": true
  }
}
```

### smtp（Send / Reply）

| 字段 | 必填 | 说明 |
|------|------|------|
| `host` | 是 | SMTP 主机 |
| `port` | 否 | 默认 587 |
| `secure` | 否 | 是否 TLS，默认 false |
| `username` | 是 | 登录用户名，可复用 Registry `account` |
| `password` | 是 | SMTP 密码，可复用 Registry `password` |
| `fromEmail` | 是 | 发件人邮箱 |
| `fromName` | 否 | 发件人显示名 |

### imap（Open / Star）

| 字段 | 必填 | 说明 |
|------|------|------|
| `host` | 是 | IMAP 主机 |
| `port` | 否 | 默认 993 |
| `secure` | 否 | 默认 true |
| `username` | 是 | 同 smtp 或 Registry |
| `password` | 是 | 同 smtp 或 Registry |
| `mailbox` | 否 | 默认 INBOX |
| `starFlag` | 否 | 星标对应 IMAP 标志，默认 `\Flagged` |

### contacts（Add Contact，CardDAV）

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 固定 `carddav` |
| `baseUrl` | 是 | CardDAV 地址簿 URL（以 / 结尾） |
| `username` | 否 | 可选，Basic 认证时用 |
| `password` | 否 | 可选，Basic 认证时用 |
| `bearerToken` | 否 | 可选，Bearer 认证时用 |

### messageLookup（IMAP 定位邮件）

| 字段 | 必填 | 说明 |
|------|------|------|
| `useReplyToMessageId` | 否 | 默认 true，优先按 Message-ID 查 |
| `useThreadId` | 否 | 默认 true |
| `fallbackToSubjectSearch` | 否 | 默认 true，按主题搜索 |
| `fallbackToCounterpartySearch` | 否 | 默认 true，按对方邮箱搜索 |

---

## 回退规则

- 若 `auth_config_json` 为空或解析失败，执行器仅使用 Registry 的 `platform`、`refresh_token`、`account`、`mailbox_id`、`login_username`、`password` 等字段。
- SMTP 的 `smtp.username` / `smtp.password` 若未填，会回退到 Registry 的 `login_username` / `account` 与 `password`。
- 未识别的 `platform`（或非 Gmail/Zoho/Microsoft 365/SMTP）会按「unsupported_provider」失败并写回 Queue。
