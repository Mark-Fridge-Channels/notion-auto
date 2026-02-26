# 探索：仅生成授权页，用户登录后复制 refresh_token

**实现状态**：✅ 已完成（脚本 `scripts/gmail-oauth-refresh-token.ts` + README/env 说明）

## 需求理解

- **不做**：终端里「粘贴 code」的 oob 流程。
- **只做**：起一个本地页面，用户在该页点击「用 Google 登录授权」→ 跳转 Google 授权 → 授权后回到我们的页面，**页面上展示 refresh_token**，用户手动复制到发件人库的 password 列。

## 与现有代码的关系

| 项目 | 说明 |
|------|------|
| **gmail-send.ts** | 发信用 `getGmailClient(refreshToken)`，使用 `urn:ietf:wg:oauth:2.0:oob` 与 scope `gmail.send`。用**别的 redirect_uri** 拿到的 refresh_token 仍可用于 `getGmailClient`（token 绑定的是 client_id + 账号，不绑定 redirect_uri）。 |
| **依赖** | 已有 `googleapis`、`dotenv`；脚本仅需 `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`。 |
| **端口** | Dashboard 已占 9001，授权脚本用**独立端口**（如 9010），避免冲突。 |

## 流程设计

1. 运行 `npx tsx scripts/gmail-oauth-refresh-token.ts`。
2. 脚本启动 **HTTP 服务**（如 `http://127.0.0.1:9010`），并打印「请在浏览器打开: http://127.0.0.1:9010」。
3. **GET /**：返回 HTML 页面，页面上有一个按钮/链接「用 Google 账号登录授权」，指向 `oauth2.generateAuthUrl({ redirect_uri, scope })` 的 URL。
4. 用户在浏览器点击 → 跳转 Google → 登录并同意 → Google 重定向到 **http://127.0.0.1:9010/callback?code=xxx**（或带 error）。
5. **GET /callback?code=xxx**：脚本用 `oauth2.getToken({ code })` 换 token，拿到 `tokens.refresh_token`；若没有则返回错误页（提示重新授权或检查 OAuth 同意屏幕）。若有，则返回 HTML 页面：**大文本框或 `<pre>` 显示 refresh_token，并带「复制」按钮**（或仅展示文本，用户手动选中复制）。
6. 用户复制 refresh_token，贴到 Notion 发件人库对应行的 password 列。脚本可保持运行或退出（约定：展示完 token 后可在页面上提示「已复制后可关闭此页并 Ctrl+C 停止脚本」）。

## 技术点

- **redirect_uri**：脚本内使用 `http://127.0.0.1:9010/callback`（或 `http://localhost:9010/callback`，与 Google Console 中配置一致即可）。与 `gmail-send.ts` 的 oob 不同，**仅用于本脚本**获取 code；换到的 refresh_token 仍可用于发信。
- **Google Cloud Console**：用户须在对应 OAuth 2.0 客户端（与 GMAIL_CLIENT_ID 一致）的「已授权的重定向 URI」中**新增** `http://127.0.0.1:9010/callback`（或 localhost 同端口），否则授权后无法回调。
- **scope**：与发信一致，`https://www.googleapis.com/auth/gmail.send`。
- **state**：可选加 `state` 防 CSRF，本脚本单机本地使用可简化不实现。
- **服务生命周期**：拿到 refresh_token 并展示后，可保持监听（用户可多次刷新 / 再点授权换账号），或页面上提供「退出」说明，用户手动 Ctrl+C 停脚本。

## 涉及文件（实现时）

| 文件 | 修改点 |
|------|--------|
| **新建** `scripts/gmail-oauth-refresh-token.ts` | 读 env；创建 OAuth2 客户端（redirect_uri = http://127.0.0.1:9010/callback）；createServer 处理 GET /（展示授权按钮页）、GET /callback（换 token 并展示 refresh_token 页）；监听 9010；启动时打印打开地址。 |
| **README.md** 或 **issues/012** | 说明：先到 Google Console 为当前 OAuth 客户端添加 redirect_uri `http://127.0.0.1:9010/callback`，再运行脚本，打开页面完成授权后即可在页面上复制 refresh_token。 |

## 已确认

1. **端口**：固定 9010。
2. **复制方式**：页面上仅展示 refresh_token 文本 + 提示「请手动选中复制」即可，无需一键复制按钮。
3. **多账号**：需要。服务保持运行，用户可多次在页面上点「授权」换账号获取新的 refresh_token。

---

探索已收束，无其他待澄清项；可按此方案实现。
