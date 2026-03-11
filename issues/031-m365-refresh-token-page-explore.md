# 探索：M365 邮箱获取 refresh_token 的页面功能（与 Gmail 一样「登录授权即可」）

## 结论

**可以实现，且与 Gmail 一致：用户只需在浏览器打开页面、点击「用 Microsoft 账号登录授权」、登录并同意权限，回调后页面展示 refresh_token 供复制到发件人库。**  
**最简单实现方案：仿照现有 Gmail 脚本，新增独立脚本（如 `scripts/m365-oauth-refresh-token.ts`），独立端口（如 9011），不改 Dashboard/server。**

---

## 一、Gmail 现有实现（对标）

- **脚本**：`scripts/gmail-oauth-refresh-token.ts`
- **方式**：独立 Node HTTP 服务，端口 9010。
- **流程**：
  1. 用户打开 `http://127.0.0.1:9010`
  2. 页面展示「用 Google 账号登录授权」链接（`oauth2.generateAuthUrl` 生成）
  3. 用户点击 → 跳转 Google → 登录并同意 → 重定向到 `http://127.0.0.1:9010/callback?code=xxx`
  4. 脚本用 `code` 调 `oauth2.getToken(code)` 换 token，取 `refresh_token` 展示在页面上，用户复制到 Notion 发件人库 password 列。
- **依赖**：GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET；Google Console 需配置 redirect_uri `http://127.0.0.1:9010/callback`。

用户侧体验：**只要登录授权即可**，无需在终端粘贴 code。

---

## 二、M365 OAuth 与现有代码的关系

- **m365-mail.ts** 已用 refresh_token 换 access_token：  
  `getM365AccessToken(refreshToken)` 使用 env M365_CLIENT_ID、M365_CLIENT_SECRET、M365_TENANT（默认 common），scope 为  
  `offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send`。
- **获取 refresh_token** 需走授权码流程：
  1. 用户访问 **authorization URL**（Microsoft 登录页）→ 登录并同意 scope。
  2. Microsoft 重定向到 **redirect_uri** 并带上 `?code=xxx`。
  3. 后端用 **code** 向 **token endpoint** POST 换 token（grant_type=authorization_code）；响应中若 scope 含 `offline_access` 会返回 **refresh_token**。

与 Gmail 脚本的差异仅在于：授权 URL 与 token URL 的格式不同（Microsoft 使用 login.microsoftonline.com），逻辑完全一致（首页链出授权 → 回调接 code → 换 token → 展示 refresh_token）。

---

## 三、M365 授权 URL 与 token 请求格式

- **Authorization URL**（用户点击后跳转）：  
  `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?client_id={client_id}&response_type=code&redirect_uri={redirect_uri}&scope={scope}&response_mode=query`  
  - `tenant`：与 m365-mail 一致，env M365_TENANT 或 common。  
  - `redirect_uri`：需与 Azure 应用注册中配置的完全一致（如 `http://127.0.0.1:9011/callback`）。  
  - `scope`：与换 token 时一致，空格分隔并 URL 编码：  
    `offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send`

- **Token endpoint**（用 code 换 token）：  
  POST `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token`  
  Body（application/x-www-form-urlencoded）：  
  `grant_type=authorization_code&code={code}&redirect_uri={redirect_uri}&client_id={client_id}&client_secret={client_secret}&scope=...`  
  响应中 `refresh_token` 即所需结果；若未返回，通常为未申请 `offline_access` 或用户未同意。

---

## 四、实现方案对比

| 方案 | 做法 | 优点 | 缺点 |
|------|------|------|------|
| **A. 独立脚本** | 新建 `scripts/m365-oauth-refresh-token.ts`，独立 HTTP 服务（如端口 9011），GET / 展示授权链接，GET /callback 换 token 并展示 refresh_token | 与 Gmail 脚本一致，实现简单；不碰 server/Dashboard；复制 gmail 脚本改 URL/body 即可 | 需单独运行一次脚本（如 `npx tsx scripts/m365-oauth-refresh-token.ts`） |
| **B. 集成到 Dashboard** | 在 server.ts 增加路由，如 GET /m365-auth、GET /m365-auth/callback，Dashboard 某处加「M365 授权」入口 | 用户只开 Dashboard 即可点链接授权，少开一个终端 | 需改 server、Dashboard HTML；redirect_uri 依赖 Dashboard 端口/域名；若多环境需分别配置 Azure |

**推荐：方案 A（独立脚本）**——与现有 Gmail 获取方式一致、实现量最小、不引入 Dashboard 端口/安全相关考虑。

---

## 四.1 M365 环境变量：获取方式与作用

三个配置均来自 **Azure 门户（Microsoft Entra ID / 原 Azure AD）** 的「应用注册」。同一套凭据用于：① 独立脚本里「授权码换 refresh_token」、② 发信/读信时「refresh_token 换 access_token」（m365-mail.ts）。

| 变量 | 作用 | 在 Azure 里如何获取 |
|------|------|----------------------|
| **M365_CLIENT_ID** | 应用唯一标识；拼在授权 URL 与 token 请求的 `client_id` 参数里，Microsoft 据此识别是哪个应用在请求 token。 | 应用注册 → **概述** 页 → **应用程序(客户端) ID**（Application (client) ID）。不要用「对象 ID」。 |
| **M365_CLIENT_SECRET** | 应用密钥；仅在后端用 code 换 token、以及用 refresh_token 换 access_token 时随请求发送，证明「请求来自该应用」。不可暴露到前端。 | 应用注册 → **证书和密码**（Certificates & secrets）→ **新客户端密码** → 创建后复制 **值**（Value）列。**只显示一次**，离开页面后无法再查看，需当场保存到 .env。注意复制的是「值」不是「机密 ID」。 |
| **M365_TENANT** | 指定在哪个租户（组织/目录）做登录和换 token；会出现在 URL `login.microsoftonline.com/{tenant}/oauth2/v2.0/...` 里。 | **不设或设为 `common`**：允许任意 Microsoft 账号（个人 + 组织）登录，多租户/个人账号通用。**仅本组织**：应用注册 → **概述** → **目录(租户) ID**（Directory (tenant) ID），填到 M365_TENANT，则只有该租户下的账号能登录。 |

**获取步骤摘要**

1. 登录 [Azure 门户](https://portal.azure.com) → **Microsoft Entra ID**（或 Azure Active Directory）→ **应用注册** → **新注册**。
2. 名称自取；**支持的账户类型** 按需选（例如「任何组织目录中的账户和个人 Microsoft 账户」则与 `common` 一致）；**重定向 URI** 先选「Web」，填 `http://127.0.0.1:9011/callback`（与脚本一致）。
3. 注册完成后在 **概述** 页复制 **应用程序(客户端) ID** → 写入 .env 的 `M365_CLIENT_ID`；复制 **目录(租户) ID**（仅当你要限制为本组织时填到 `M365_TENANT`，否则不填或填 `common`）。
4. **API 权限**：添加 Microsoft Graph 委托权限 **Mail.Read**、**Mail.Send**；授权时 scope 含 `offline_access` 才会返回 refresh_token（脚本会请求）。
5. **证书和密码** → 新客户端密码 → 复制「值」→ 写入 .env 的 `M365_CLIENT_SECRET`。

脚本与 m365-mail 都会读这三项；CLIENT_ID / CLIENT_SECRET 必填，TENANT 不填则按 common 处理。

---

## 五、最简单实现方案（方案 A）要点

1. **新建** `scripts/m365-oauth-refresh-token.ts`  
   - 读 env：M365_CLIENT_ID、M365_CLIENT_SECRET、M365_TENANT（可选，默认 common）。  
   - 固定 redirect_uri：`http://127.0.0.1:9011/callback`（端口 9011 与 Gmail 9010 区分）。  
   - 固定 scope：`offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send`（与 m365-mail.ts 一致）。

2. **GET /**  
   - 生成 authorization URL（如上格式），返回 HTML 页：标题/说明 +「用 Microsoft 账号登录授权」链接。  
   - 可加简单 state 防 CSRF（可选，单机本地可省略）。

3. **GET /callback**  
   - 取 query 中 `code`（及 `error`/`error_description` 做错误页）。  
   - 用 code 向 token endpoint POST 换 token；成功则从响应取 `refresh_token`，返回 HTML 页展示 refresh_token 与「复制到发件人库 password 列」说明；无 refresh_token 时提示检查 scope/重新授权。

4. **Azure 应用注册**  
   - 用户需在「重定向 URI」中新增 `http://127.0.0.1:9011/callback`（与脚本中一致）。  
   - 应用权限（Delegated）：Mail.Read、Mail.Send；授权时勾选 offline_access（或通过 scope 请求）。

5. **文档**  
   - env.example / README 中补充：获取 M365 refresh_token 时运行 `npx tsx scripts/m365-oauth-refresh-token.ts`，浏览器打开 http://127.0.0.1:9011，点击授权后复制页面上 refresh_token 到发件人库。

---

## 六、依赖与约束

- **依赖**：现有 M365_CLIENT_ID、M365_CLIENT_SECRET、M365_TENANT；无需新 npm 包（用 `fetch` + 拼 URL 即可）。  
- **约束**：redirect_uri 必须与 Azure 中配置完全一致（含端口、path）；scope 与 m365-mail 使用的一致，否则后续换 access_token 可能缺权限。

---

## 七、待你确认（若有）

1. **入口形态**：仅「独立脚本 + 本地页面」是否满足你对「页面功能」的预期？若希望必须从 Dashboard 里点进去再跳转，则需采用方案 B 并增加 Dashboard 入口与 server 路由。  
2. **端口**：9011 是否可固定（与 Gmail 9010 区分、避免与现有服务冲突）？  
3. **多账号**：与 Gmail 脚本一致，服务保持运行可多次点击授权获取不同账号的 refresh_token，是否保留该行为？

若以上无异议，可按方案 A 直接实现；实现时仅新增脚本与文档，不修改 m365-mail.ts 或 server。
