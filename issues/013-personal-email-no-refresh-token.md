# 个人邮箱 (Gmail/Outlook) 在 Warmup 场景下无法获取 refresh_token 导致 API 不可用

**类型:** bug / 限制  
**优先级:** normal  
**投入:** medium  

---

## TL;DR

当 Warmup 中「发件方」为个人 Gmail 或 Outlook 时，对应平台的 OAuth 流程往往不返回 `refresh_token`，而 Warmup Executor 依赖 Credential Registry 中的 `refresh_token` 调用 Gmail / Microsoft 365 API，导致该场景下无法使用 API 发信/回信。

---

## 当前状态 vs 期望

- **当前：** 个人邮箱做 OAuth 授权时拿不到 `refresh_token`（或首次之后不再返回）；Executor 在 `resolveWarmupCredential` 后若 `refresh_token` 为空或无效，会报错或跳过（如 `缺少 refresh_token`），该账号对应的 Warmup 任务无法执行。
- **期望：**  
  - 要么在文档/脚本中明确「个人邮箱如何拿到 refresh_token」的可行步骤（若平台支持）；  
  - 要么在文档中说明当前仅支持「能提供 refresh_token 的账号」（如 Workspace / 组织 M365），个人邮箱建议走 SMTP 等替代方式；  
  - 或（若产品范围允许）为个人邮箱提供替代认证/发信路径（如仅 SMTP 发信、不依赖 Gmail/M365 API）。

---

## 涉及文件

- `scripts/gmail-oauth-refresh-token.ts`：Gmail 授权拿 refresh_token；可补充「个人账号需撤销应用授权后重新授权」等说明。
- `docs/credential-registry-auth-config-templates.md`：Gmail / M365 必填 `refresh_token` 的说明；可增加「个人 vs 公司账号」限制与替代方案。
- `src/notion-warmup.ts`：`resolveWarmupCredential` 读取 `refresh_token`。
- `src/warmup-provider.ts`：`ensureRefreshToken`、Gmail/M365 调用前校验 refresh_token。
- （若有）M365 的 OAuth/refresh_token 获取脚本或文档。

---

## 风险与备注

- **平台策略**：Google / Microsoft 对个人账号的 refresh_token 发放策略可能随政策变化，文档需注明「以当前 OAuth 行为为准」。
- **SMTP 替代**：个人邮箱若仅需发信，可配置 `platform = SMTP` + `auth_config_json` 的 smtp 块，不依赖 refresh_token；但 Open/Star/Add Contact 等仍依赖 IMAP/CardDAV，需单独配置或接受部分动作不可用。
- 若后续增加「仅个人邮箱发信」的明确支持，可考虑在 Credential Registry 或 Executor 中区分账号类型并给出更明确的错误提示（如「个人 Gmail 未返回 refresh_token，请撤销授权后重新授权或改用 SMTP」）。
