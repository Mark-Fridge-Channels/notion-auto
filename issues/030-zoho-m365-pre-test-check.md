# 030 Zoho/M365 交付测试前检查：功能逻辑与 refresh_token 方式

## 一、refresh_token 方式是否稳妥

### 结论：**是，使用 refresh_token 是服务端最稳妥、推荐的方式**

- **Zoho**  
  - 服务端应用走 **Authorization Code Flow**，首次授权后得到 **refresh_token**，之后用 refresh_token 向 `oauth/v2/token` 换取 **access_token**（约 1 小时有效）。  
  - 不在每次请求前让用户重新登录，只需在发件人库的 password 列存该用户的 refresh_token，程序侧按需用 refresh_token 换 access_token 即可。  
  - 官方对服务端应用的设计就是「存 refresh_token、按需刷新」；access_token 短期有效，不适合长期存或跨进程共享，**用 refresh_token 换 access_token 是标准且稳妥的做法**。

- **Microsoft 365（Graph）**  
  - 授权时 scope 需包含 **offline_access**，才会返回 **refresh_token**；之后 access_token 过期（约 1 小时）时，用 refresh_token 向 `/oauth2/v2.0/token` 换新 access_token。  
  - 服务端「代表用户」发信/读信（Delegated）场景下，**用 refresh_token 续期 access_token 是官方文档推荐方式**，无需用户反复登录。

当前实现：每次发信/读信前调用 `getZohoAccessToken(refreshToken)` 或 `getM365AccessToken(refreshToken)`，用发件人库中的 refresh_token 换当次使用的 access_token，**逻辑正确且符合两家规范**。  
唯一注意点：Zoho 对「同一 refresh_token 在 10 分钟内可换取的 access_token 数量」有限制（例如 10 个/10 分钟），若同一发件人在极短时间内大量发信可能被限流；当前 Queue 有节流（如每日上限、间隔），一般不会触发，测试时避免同一账号在 10 分钟内连续发很多封即可。

---

## 二、功能逻辑检查结果

### 1. 发件人凭据与 Provider

- **notion-queue.ts**  
  - `fetchSenderCredentials` 从发件人库按 Email 匹配行，取 **password**（getPasswordFromProps，支持 "password"/"Password"）和 **Provider**（getProviderFromProps：Select 的 name 或 Rich text；无或空则 `"Gmail"`）。  
  - 若 password 为空则跳过该行（返回 null），不会把空串传给 Zoho/M365。  
  - **结论**：逻辑正确；无 Provider 列或为空时默认 Gmail，兼容旧库。

### 2. Queue Sender（发信）

- **queue-sender.ts**  
  - 取到 `creds` 后 `provider = (creds.provider ?? "Gmail").trim() || "Gmail"`，再按 `provider === "Gmail" | "Zoho" | "Microsoft 365"` 分支。  
  - Zoho：`getZohoAccessToken(creds.password)` → `getZohoAccountId(accessToken)` → Cold1 或 Reply（带 messageIdLast）；失败进 catch，按是否「可重试」决定回写或重试。  
  - M365：`getM365AccessToken(creds.password)` → Cold1 或 Reply；同上。  
  - 未知 provider 时回写失败并明确提示「不支持的 Provider」。  
  - **结论**：分支、参数传递、错误与重试逻辑正确。  
  - **注意**：Provider 为**严格字符串相等**。若 Notion 中 Select 选项名为 "microsoft 365"（小写）或 "M365"，会落入「不支持的 Provider」。测试时 Notion 中选项名须为 **Gmail**、**Zoho**、**Microsoft 365**（与 README 一致）。

### 3. Reply Tasks（回复）

- **reply-tasks-send.ts**  
  - `ctx.provider`、`ctx.messageId` 来自 `getReplyTaskSendContext`（IM 的 Provider 与 Message ID）。  
  - Zoho/M365 回复前检查 `ctx.messageId?.trim()`，空则直接返回错误，不调 API。  
  - **结论**：逻辑正确；Reply 依赖 IM 的 Message ID 与 Provider，旧 IM 无 Provider 时 getReplyTaskSendContext 默认 "Gmail"，messageId 空时 Zoho/M365 会明确报错。

### 4. Inbound Listener（监听与写 IM）

- **inbound-listener.ts**  
  - 对每个 mailbox 取 `creds`，`provider = (creds.provider ?? "Gmail").trim() || "Gmail"`，按 Gmail / Zoho / Microsoft 365 分别调 gmail-read / zoho-mail / m365-mail 的「列收件箱 + 取单封解析」。  
  - 得到的 `InboundMessageParsed` 统一进 `processOneMessage(..., provider)`，其中 `createInboundMessageRow(..., { ..., provider: provider || "Gmail" })` 会把 provider 写入 IM 的 **Provider** 列。  
  - **结论**：按 Provider 分支拉信、写 IM 时回写 Provider 列，逻辑正确。

### 5. Zoho 模块（zoho-mail.ts）

- **Token**：`getZohoAccessToken` 使用 env `ZOHO_CLIENT_ID`、`ZOHO_CLIENT_SECRET`、`ZOHO_REDIRECT_URI`（默认 `https://localhost`）、`ZOHO_REGION`（默认 com）；请求体与 Zoho 文档一致（refresh_token, grant_type=refresh_token 等）。  
- **API 路径**：accountId 来自 Get All User Accounts；inbox folderId 来自 Get Folders 中 folderType=Inbox；发信/回复/列收件箱/取单封的 path 与官方一致。  
- **Cold1**：API 未返回 messageId 时返回占位 `threadId: "zoho-sent"`，不抛错，与之前 peer review 结论一致。  
- **列表**：`listZohoInboxMessageIds` 对 `data` 非数组返回 `[]`；单条解析用 list 的元数据补全 from/to/subject 等，逻辑正确。  
- **结论**：Zoho 端逻辑正确。测试时需保证**获取 refresh_token 时使用的 redirect_uri 与 env 中 ZOHO_REDIRECT_URI 一致**（默认即 `https://localhost`，若用别的需在 env 中配置）。

### 6. M365 模块（m365-mail.ts）

- **Token**：`getM365AccessToken` 使用 env `M365_CLIENT_ID`、`M365_CLIENT_SECRET`、`M365_TENANT`（默认 common）；scope 含 `offline_access`、`Mail.Read`、`Mail.Send`，符合「代表用户发信+读信」且需 refresh_token 的用法。  
- **发信**：sendMail 返回 202 无 body，实现用占位 messageId/threadId；reply 使用 `POST /me/messages/{id}/reply`，body 为 `{ comment: htmlBody }`，与 Graph 文档一致。  
- **读信**：列表用 `mailFolders/inbox/messages`；单封用 `messages/{id}` 并带 `Prefer: outlook.body-content-type=text`；对 `value` 非数组、body 缺失等有防护。  
- **结论**：M365 端逻辑正确。测试时需用**包含 offline_access、Mail.Read、Mail.Send 的 scope 做首次授权**，才能拿到可长期使用的 refresh_token。

---

## 三、测试前核对清单（给测试方）

1. **Notion**  
   - 发件人库：每行有 **Email**、**password**（存对应用户的 refresh_token）、**Provider**（Select，选项名必须为 **Gmail** / **Zoho** / **Microsoft 365**，拼写与空格一致）。  
   - IM 表：已新增 **Provider** 列（Select，同上三个选项），否则写入入站会报错。

2. **Zoho**  
   - 在 Zoho API Console 创建 Server-based Application，拿到 Client ID / Client Secret。  
   - 授权时 **redirect_uri** 与运行环境中的 **ZOHO_REDIRECT_URI** 完全一致（不设则视为 `https://localhost`）。  
   - 首次授权拿到 **refresh_token** 后，填入发件人库对应用户行的 **password** 列。  
   - 若为 EU/中国区，设置 **ZOHO_REGION**=eu 或 com.cn。

3. **M365**  
   - 在 Azure AD 注册应用，配置 redirect、申请 **offline_access**、**Mail.Read**、**Mail.Send**（Delegated），做用户授权拿到 **refresh_token**。  
   - 将 refresh_token 填入发件人库对应用户行的 **password** 列。  
   - 多租户用 **M365_TENANT**=common；单租户可填租户 ID。

4. **环境变量**  
   - 不用的厂商可不配对应 env（例如只测 Gmail 则不配 ZOHO_*、M365_*）；发件人库中 Provider 为 Zoho/M365 的行只有在配置了对应 env 时才会成功换 token。

---

## 四、已确认无问题的点（简要）

- 空/缺省 Provider 视为 Gmail，不报错。  
- password（refresh_token）为空时不会传给 Zoho/M365，会因「未找到发件人凭据」或「无 password」而跳过。  
- Zoho/M365 token 请求失败时抛错，Queue 会重试或回写失败原因到 Notion；Inbound 单邮箱失败只打 log，不拖垮整轮。  
- Reply 时 Zoho/M365 依赖 IM 的 Message ID，空则明确返回错误提示，不会误调 API。  
- 发信/读信使用的 API 路径、请求体、请求头与两家官方文档一致；使用 **refresh_token 换 access_token** 的方式符合服务端最佳实践，且为两家推荐做法。

---

## 五、可选优化（非必须，可后续做）

- **Provider 大小写**：当前为严格相等，若希望 Notion 中 "microsoft 365" 也能用，可对 provider 做 `.toLowerCase()` 再与 `"gmail"` / `"zoho"` / `"microsoft 365"` 比较。  
- **Zoho 限流**：同一 refresh_token 在 10 分钟内不要换取超过约 10 次 access_token；当前节流下一般不会触发，若后续有高频场景可考虑对 access_token 做短时缓存（按 refresh_token + TTL）。  
- **Token 脚本**：获取 Zoho/M365 的 refresh_token 的脚本未在本次实现；测试前需按官方文档或自写脚本完成首次授权并取得 refresh_token，再填入发件人库。

---

**总结**：功能逻辑和 refresh_token 使用方式均正确、稳妥，可按上述清单交付测试；测试时重点确认 Notion 列名/选项名、Zoho redirect_uri 与 M365 scope/offline_access，以及 env 与发件人库中 refresh_token 的对应关系即可。
