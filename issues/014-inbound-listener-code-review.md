# Inbound Listener 代码审查报告

## ✅ Looks Good

- **Logging**：全程使用 `logger.info` / `logger.warn`，无 `console.log`，上下文清晰（mailbox、message_id、resolved_group 等）。
- **TypeScript**：无 `any`、无 `@ts-ignore`；接口（`InboundListenerConfig`、`InboundMessageParsed` 等）定义明确。
- **Error handling**：主循环 `main()` 有 try/catch 并打日志；单条 message 处理有 try/catch，失败不中断整轮；配置加载失败时 sleep 后重试。
- **架构**：与现有 Queue Sender / Dashboard runner 模式一致；配置独立 JSON、Notion 复用 parseDatabaseId、发件人库复用 fetchSenderCredentials。
- **生产就绪**：无调试语句、无 TODO、无硬编码密钥；凭据来自 env 与 Notion。
- **Notion 适配**：Body Plain 按 2000 字分块、幂等键与路由逻辑符合需求；Touchpoints 写回使用 Select 类型。

---

## ⚠️ Issues Found

### 已修复

- **[MEDIUM]** [server.ts:239–240] - `/api/inbound-listener/start` 收到的 `configPath` 未做路径校验，存在路径穿越风险。  
  **Fix**：已增加 `resolveInboundListenerConfigPath(configured)`，与 `resolveConfigPath` 一致：在 `process.cwd()` 下 resolve，禁止 `..`，非法则退回默认路径；start 时传入解析后的路径。

### 已按建议修复（LOW）

- **[LOW]** [gmail-read.ts] - 已删除未使用的 `GMAIL_READ_SCOPES`，在注释中说明需 gmail.readonly。
- **[LOW]** [inbound-listener-config.ts] - `getInboundListenerConfigPath()` 已对 env 相对路径做 `..` 校验，超出 cwd 则退回默认路径。
- **[LOW]** [notion-inbound.ts] - `From Email` / `To Email` 已改为 trim 后写入，空串写 `""`。

---

## 📊 Summary

- **Files reviewed**: 6（inbound-listener.ts, inbound-listener-config.ts, gmail-read.ts, notion-inbound.ts, dashboard-inbound-listener-runner.ts, server.ts 相关片段）
- **Critical issues**: 0
- **High issues**: 0
- **Medium issues**: 1（configPath 路径校验，已修复）
- **Low issues**: 3（均已修复）
