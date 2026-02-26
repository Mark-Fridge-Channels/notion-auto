# 用 googleapis 生成 Gmail refresh_token 的脚本

**类型**：feature  
**优先级**：normal  
**工作量**：small

---

## TL;DR

新增一个本地脚本，使用项目已有的 `googleapis` 与 `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`，跑一次 OAuth 2.0 授权流程，在终端输出 **refresh_token**，用户可复制到发件人库的 password 列。

---

## 当前 vs 期望

| 项目 | 当前 | 期望 |
|------|------|------|
| refresh_token 获取 | 文档写「可自行用脚本或 OAuth Playground 完成，此处不实现」 | 项目内提供脚本，用 googleapis 本地起一个授权页/打印授权 URL，用户访问后把 code 贴回脚本，脚本换 token 并打印 refresh_token |
| 用户体验 | 需去 Google OAuth Playground 或自己写一次性脚本 | 执行 `npx tsx scripts/gmail-oauth-refresh-token.ts`，按提示完成授权即可得到 refresh_token |

---

## 涉及文件

| 文件 | 修改点 |
|------|--------|
| **新建** `scripts/gmail-oauth-refresh-token.ts` | 读 env GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET；用 `google.auth.OAuth2` 生成 authUrl（scope 含 gmail.send），提示用户打开并粘贴 code；`getToken(code)` 取 tokens，打印 `tokens.refresh_token`；可选将 refresh_token 写入某文件或仅 stdout |
| `src/gmail-send.ts` | 无需改；脚本与发信共用同一 redirect_uri（`urn:ietf:wg:oauth:2.0:oob`）和 scope，保证生成的 refresh_token 可直接用于 getGmailClient |
| `README.md` 或 env.example | 补充「获取 refresh_token」小节，指向该脚本及用法 |

---

## 实现要点

- **redirect_uri**：与 `gmail-send.ts` 中一致，使用 `urn:ietf:wg:oauth:2.0:oob`（桌面应用「粘贴 code」流程）。
- **scope**：至少 `https://www.googleapis.com/auth/gmail.send`，与发信一致。
- 脚本逻辑：`oauth2.generateAuthUrl()` → 打印 URL → 读 stdin 或 prompt 得到 `code` → `oauth2.getToken({ code })` → 打印 `res.tokens.refresh_token`；无 refresh_token 时提示用户需在同意屏幕勾选并重新授权。
- 不把 refresh_token 写进 .env（每个发件人不同，应进 Notion 发件人库）。

---

## 风险与备注

- 依赖：已有 googleapis、dotenv；需先配好 GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET。
- 安全：refresh_token 仅打印到终端，提醒用户勿泄露、仅填到发件人库。
- 若 Google 返回无 refresh_token（如首次授权未勾选「离线访问」或同意屏幕未发布），需在 Cloud Console 的 OAuth 同意屏幕确保允许 refresh_token，并让用户重新授权。
