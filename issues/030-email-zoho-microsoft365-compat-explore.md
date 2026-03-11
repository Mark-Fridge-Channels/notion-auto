# 030 邮件 Zoho / Microsoft 365 兼容 — 探索

基于 issue 030 与现有代码的探索结论，以及需要你确认的问题。

---

## 1. 现有实现摘要

### 1.1 发件人凭据

- **唯一来源**：发件人库（Notion DB），每行：**Email** + **password**（当前存 Gmail `refresh_token`）。
- **读取方式**：`notion-queue.ts` 的 `fetchSenderCredentials(notion, senderUrl, senderAccount)`，按 `senderAccount` 匹配发件人库的 **Email** 列，取该行的 **password**。
- 无「厂商」字段，全库默认 Gmail；env 仅 `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`。

### 1.2 发信路径

| 入口 | 发件人来源 | 调用链 |
|------|------------|--------|
| Queue Sender | Queue 配置的 `sender_accounts_database_url` + 每条的 `senderAccount` | `fetchSenderCredentials` → `getGmailClient(creds.password)` → `sendCold1` / `sendFollowup` |
| Reply Tasks | Reply Tasks 配置的 `sender_accounts_database_url` + Task→IM→Touchpoint 的 `senderAccount` | `fetchSenderCredentials` → `getGmailClient(creds.password)` → `sendInThread` |

- `gmail-send.ts`：Cold1（新线程）、Followup（In-Reply-To/References）、InThread（仅传 `threadId`，Gmail 归并会话）。
- 两处发信都只认「一个 password 列」，无厂商分支。

### 1.3 入站监听路径

- **配置**：`inbound-listener.json` → 多 group，每组 `inbound_messages_db_id`、`touchpoints_db_id`、`sender_accounts_database_url`、`mailboxes[]`。
- **流程**：对每个 mailbox（发件人库的 Email），用 `fetchSenderCredentials(notion, group.sender_accounts_database_url, mailbox)` 取 `password` → `getGmailClientForRead(creds.password)` → `listInboxMessageIds` / `getMessageAndParse`。
- **写入 Notion**：`notion-inbound.ts` 写 IM 表，字段含 **Message ID**（即 `gmail_message_id`）、**Thread ID**（Gmail thread id）。Reply Task 发信时从 IM 读 **Thread ID** 作为 Gmail `threadId` 调 `sendInThread`。

结论：**发信与监听都强依赖「一个 password = Gmail refresh_token」和 Gmail API；Notion 中 IM 的 Message ID / Thread ID 是 Gmail 语义。**

---

## 2. 集成点与约束

- **发件人库**：若支持多厂商，必须能区分每行厂商（例如新增 **Provider** 列：Gmail / Zoho / Microsoft 365），并可能按厂商用不同列存凭据（如 Gmail 用 password 存 refresh_token，Zoho 另列存 Zoho refresh_token）。`fetchSenderCredentials` 需返回「厂商 + 对应凭据」。
- **发信**：Queue Sender / Reply Tasks 在「取到凭据」后，按厂商分支：调 `gmail-send` 或 Zoho/M365 的发信实现；Reply 的「同一会话」在 Gmail 用 threadId，在 Zoho/M365 可能需用 In-Reply-To/References（类似现有 Followup）。
- **监听**：每个 mailbox 需按厂商选不同「列 inbox / 解析单封」实现；返回结构需统一为当前 `InboundMessageParsed` 的语义（message_id、thread_id、from、to、subject、body_plain 等），以便现有 `processOneMessage`、Notion 写入、路由逻辑复用。Notion IM 的 **Message ID** / **Thread ID** 若继续通用使用，应视为「不透明 ID」：Gmail 存 Gmail id，Zoho/M365 存各自 id；Reply 发信时再按厂商用对应 API 的「同一会话」语义。
- **配置与 env**：Zoho、M365 各自需要 OAuth client（或 SMTP/IMAP）配置；env 或配置文件需区分厂商，且不破坏现有 Gmail-only 部署。

---

## 3. 需要你确认的问题

### 3.1 范围与优先级

1. **先做发信还是先做监听？** 还是一次性两个都支持？
2. **Zoho 与 Microsoft 365 的优先级？** 先做其中一个，还是两个并列做？
3. **认证方式**：仅 OAuth2，还是也要支持 SMTP/IMAP（例如 Zoho/M365 用 app 密码）？若支持 SMTP/IMAP，发件人库是否用同一列存「密码」、靠 Provider 区分语义？

### 3.2 发件人库与凭据

4. **发件人库结构**：是否确定「一个发件人库混用多厂商」即每行一个 **Provider**（如 Select：Gmail / Zoho / Microsoft 365）？还是考虑「每个厂商一个发件人库」、由配置指定用哪个库（当前 Queue/Reply/Inbound 都是一库一个 URL）？
5. **凭据列**：Gmail 继续用 **password** 存 refresh_token；Zoho/M365 是各自一列（如 **zoho_refresh_token**、**m365_refresh_token**），还是统一一列 **password**、根据 Provider 解析不同格式（如 JSON `{ "provider":"zoho", "refresh_token":"..." }`）？

### 3.3 入站与 Notion 模型

6. **Message ID / Thread ID**：Notion IM 表是否保持「Message ID」「Thread ID」两列，但允许多厂商（Gmail 存 Gmail 的 id，Zoho/M365 存各自 id）；Reply 发信时由「该 IM 来自哪一厂商」决定用哪套 API 的 thread/会话语义？还是希望 IM 表增加「Provider」列，便于路由与展示？
7. **Reply 的「同一会话」**：Zoho/M365 若没有 Gmail 那种 threadId，是否约定：用 In-Reply-To/References 回复（即逻辑上等同现有 `sendFollowup`），而不强求「thread」概念？

### 3.4 配置与运维

8. **OAuth 获取方式**：Zoho、M365 的 refresh_token 是否在本项目内提供脚本获取（类似 `scripts/gmail-oauth-refresh-token.ts`），还是只文档说明、由用户自行获取后填入？
9. **节流**：当前节流按「发件人」（email/senderAccount）。多厂商后是否仍按发件人维度统一节流，还是按厂商有不同上限（如 Gmail 50/天、Zoho 另设）？

### 3.5 边界情况

10. **同一 group 内 mailboxes 混用多厂商**：Inbound 的同一 group 下 `mailboxes` 是否允许既有 Gmail 又有 Zoho/M365？若是，当前「每个 mailbox 取一次凭据、调一次 Gmail 读」要改为「按凭据的 provider 调对应读信实现」。
11. **Queue/Reply 的 Sender Account**：若发件人库中某行是 Zoho，Queue 或 Reply Task 的 Sender Account 指向该行时，是否只要「按该行 Provider 用 Zoho 发信」即可，无需其他配置（例如不再依赖 GMAIL_* env）？

---

## 4. 决策记录（已确认）

根据你的回复整理为可实现约束：

### 4.1 范围与 API

- **发信和监听都要做**；**M365 和 Zoho 都要开发**。
- **仅用 API**：Microsoft Graph API（M365）、Zoho Mail API；不做 SMTP/IMAP。

### 4.2 发件人库与 Provider 来源

- **Provider 是从 Notion 里获取的新的一列**：在发件人库（Notion 数据库）中**新增一个属性列**，列名例如 **Provider**，类型可为 Select，可选值如 Gmail / Zoho / Microsoft 365。代码通过 Notion API 查询发件人库时，除读取 Email、password 外，**同时读取该行的 Provider**；不依赖 env 或本地配置推断厂商，完全由 Notion 中该列决定。
- **用 Provider 列在发件人库里区分平台**：每行根据该列区分所属平台；同一库可混用多厂商。未填或历史行为：可约定空/缺省视为 Gmail，以兼容旧数据。

### 4.3 IM 与 Reply

- **IM 表同样在 Notion 中新增 Provider 列**：📥 Inbound Messages 数据库新增属性列 **Provider**（如 Select：Gmail / Zoho / Microsoft 365）。写入入站消息时，该列取值**来自当时拉取该邮件的 mailbox 所在发件人库行的 Provider**（即从 Notion 发件人库读到的值原样写入 IM）；Reply 发信时从 IM 读 **Thread ID** 与 **Provider**，按 Provider 选 API。
- **统一用**：Reply 发信时按 **该 IM 的 Provider** 选对应 API（Gmail / Zoho / M365）；同一会话语义各厂商用各自 API（Gmail 用 threadId，Zoho/M365 用各自 API 的 thread 或 In-Reply-To/References）。

### 4.4 Token 与运维

- **Token 获取脚本**：后续再处理（不纳入首版实现范围）。
- **节流**：未单独指定；实现时默认保持「按发件人」维度即可，若有需要再按厂商拆分。

### 4.5 混用与依赖

- **同一 Inbound group 内允许 mailboxes 混用多厂商**：同一组下可有 Gmail、Zoho、M365 的 mailbox；按每个 mailbox 所在发件人库行的 Provider 调用对应读信实现。
- **Queue/Reply 发信**：仅依赖**该行**的 Provider；若 Sender Account 指向 Zoho 行则用 Zoho 发信，无需额外配置（该厂商所需 env 如 ZOHO_CLIENT_ID 等另行配置）。

---

## 5. 决策补充（凭据与枚举）

- **凭据列**：**共用 password 列**，用新列 **Provider** 区分解析方式（Gmail 行 password=refresh_token；Zoho 行 password=Zoho refresh_token；M365 行 password=M365 refresh_token）。实现时按 Provider 分支取用，无需多列。
- **Provider 枚举**：**统一**。发件人库与 IM 表使用同一套可选值（如 `Gmail` / `Zoho` / `Microsoft 365`），便于 Reply 与路由时精确分支。

---

## 6. Zoho / M365 API 实现清晰度（发信与收信）

以下基于官方文档与常见用法整理，便于实现时对照；**发信、收信在两边 API 上均可实现，语义清晰**，仅少量实现细节需在开发时确认。

### 6.1 Zoho Mail API

| 能力 | 是否清晰 | 要点 |
|------|----------|------|
| **OAuth** | ✅ | `https://accounts.zoho.com/oauth/v2/token`（注意区域：com/eu/com.cn），`grant_type=refresh_token` + `client_id` + `client_secret` + `refresh_token` + `redirect_uri`（须与注册一致）。access_token 约 1 小时，用 refresh_token 续期。 |
| **发信（新邮件）** | ✅ | `POST /api/accounts/{accountId}/messages`，body: `fromAddress`, `toAddress`, `subject`, `content`, `mailFormat`(html/plaintext)。accountId 来自「Get All User Accounts」一次查询。 |
| **发信（回复）** | ✅ | `POST /api/accounts/{accountId}/messages/{messageId}`，body: `action: "reply"`, `fromAddress`, `toAddress`, `subject`, `content`。按 messageId 回复即落在同一 thread，无需自建 In-Reply-To。 |
| **列收件箱** | ✅ | `GET /api/accounts/{accountId}/messages/view?folderId=xxx&limit=1-200&sortBy=date&sortorder=false`。需先调「Get all folders」取收件箱的 folderId。返回每条含 `messageId`, `threadId`, `fromAddress`, `toAddress`, `subject`, `summary`, `receivedTime`。 |
| **取单封内容** | ✅ | `GET /api/accounts/{accountId}/folders/{folderId}/messages/{messageId}/content`。返回 `data.content` 为 **HTML**；需在本地做 HTML→纯文本（与现有 `gmail-read` 的 `htmlToPlainText` 一致）及截断。 |

**实现时注意**：  
- 首轮需解析 **accountId**（Get All User Accounts）与收件箱 **folderId**（Get all folders）；可缓存或按 mailbox 存。  
- 区域：Zoho 有 com / eu / com.cn，token URL 与 API base 可能不同，需在配置或 env 中区分。

### 6.2 Microsoft Graph API（M365）

| 能力 | 是否清晰 | 要点 |
|------|----------|------|
| **OAuth** | ✅ | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`，`grant_type=refresh_token` + `client_id` + `client_secret` + `refresh_token` + `scope`。scope 需含 `offline_access` 拿 refresh_token，发信 `Mail.Send`，读信 `Mail.Read`（或 Mail.ReadBasic）。 |
| **发信（新邮件）** | ✅ | `POST /v1.0/me/sendMail`，body 为 JSON message（toRecipients, subject, body）。或 MIME base64。 |
| **发信（回复）** | ✅ | `POST /v1.0/me/messages/{messageId}/reply`，body 可只含 reply 正文。API 自动归入同一 conversation，无需自建 In-Reply-To。 |
| **列收件箱** | ✅ | `GET /v1.0/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc`。返回含 `id`, `conversationId`, `subject`, `from`, `toRecipients`, `receivedDateTime`, `bodyPreview`；完整 body 需再调 get message。 |
| **取单封内容** | ✅ | `GET /v1.0/me/messages/{id}`；请求头 `Prefer: outlook.body-content-type=text` 可要纯文本，否则默认 HTML。可复用现有 HTML→plain 逻辑做兜底。 |

**实现时注意**：  
- `tenant` 可为 `common` 或具体租户 ID，需与注册一致。  
- 列表不返回完整 body，需对每条 message id 再请求一次 get message（与当前 Gmail 的 list + getMessageAndParse 模式一致）。

### 6.3 与现有 Gmail 流程的对应关系

| 环节 | Gmail（现有） | Zoho | M365 |
|------|----------------|------|------|
| 列收件箱 | `messages.list` q=in:inbox -in:sent | messages/view + folderId=inbox | mailFolders/inbox/messages |
| 取单封 | `messages.get` format=full | folders/…/messages/…/content | messages/{id} + Prefer body |
| 新邮件 | `messages.send` raw MIME | POST accounts/…/messages | sendMail |
| 回复同会话 | sendInThread(threadId) 或 sendFollowup(In-Reply-To) | POST …/messages/{messageId} action=reply | POST messages/{id}/reply |
| 统一结构 | InboundMessageParsed | 同上：message_id, thread_id, from, to, subject, body_plain 等 | 同上 |

**结论**：Zoho 与 M365 的**发信、收信**在官方 API 上都有明确接口；实现时只需按 Provider 分支调用对应 API，并把列表/单封结果映射到现有 `InboundMessageParsed`（及 Notion IM 的 Message ID / Thread ID / Provider）。唯一需要约定的是 Zoho 的**区域**（及对应 token URL / base URL）和 M365 的 **tenant** 从何处读（env 或发件人库扩展列，可放在 PLAN 里定）。

---

## 7. 小结

- 实现多厂商已确定：**发件人库 Provider 列 + 共用 password 列按 Provider 解析；发信/监听用 Microsoft Graph、Zoho Mail API；IM 表增加 Provider、枚举统一；同一 group 可混用厂商；发信与 Reply 仅依赖该行 Provider；token 脚本后补。**
- **Zoho / M365 的发信与收信 API 清晰**，可直接作为 PLAN-030 的实现依据；实现时仅需落实 Zoho 区域与 M365 tenant 的配置方式。

---

## 8. 其他问题与是否可进入 PLAN

### 8.1 是否还有未决问题？

**需求层面**：没有必须再和你确认的歧义。当前探索已覆盖：范围（发信+监听、Zoho+M365、仅 API）、Provider 从 Notion 新列读/写、凭据共用 password 按 Provider 解析、枚举统一、混用与 Reply 依赖该行/IM 的 Provider、token 脚本后补、节流按发件人。

**实现层面（留给 PLAN/实现时定）**：

- **Zoho 区域**：token URL 与 API base（com / eu / com.cn）从 **env**（如 `ZOHO_REGION`）读，还是发件人库再增一列「区域」——PLAN 里二选一或约定默认即可。
- **M365 tenant**：`tenant`（common 或租户 ID）从 **env**（如 `M365_TENANT`）读，还是每行/每库配置——PLAN 里约定即可。
- **Provider 列名与枚举字面量**：Notion 列名是否严格 `Provider`、可选值是否严格 `Gmail` / `Zoho` / `Microsoft 365`（与现有 Email、password 等命名风格一致即可），在 PLAN 里写清便于实现与文档一致。

以上均为技术/实现选择，不改变已确认的产品与数据模型，**不阻塞写 PLAN**。

### 8.2 是否已经可以进行 PLAN？

**可以。** 探索文档中的约束与决策已足够写出 PLAN-030，包括：

- **Critical Decisions**：Provider 为 Notion 新列（发件人库 + IM）；凭据共用 password、按 Provider 解析；发信/读信按 Provider 分支调用 Gmail / Zoho / M365 API；Zoho 区域与 M365 tenant 的配置方式在 PLAN 中明确（建议先 env）。
- **Tasks 可拆分为**：发件人凭据读取扩展（返回 Provider + password）→ 抽象或分支发信/读信 → Zoho 发信+收信 → M365 发信+收信 → IM 写入 Provider、Reply 按 IM Provider 选 API → env.example 与兼容旧数据（Provider 空视为 Gmail）。

如需，我可以直接起草 **PLAN-030** 文档（Critical Decisions + 分步 Tasks）。
