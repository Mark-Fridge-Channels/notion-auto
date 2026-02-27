# 018 Reply Tasks · Code Review

审查范围：`reply-tasks-config.ts`、`notion-reply-tasks.ts`、`gmail-send.ts`（sendInThread）、`reply-tasks-send.ts`、`server.ts`（Reply Tasks 相关 API 与 Dashboard 脚本）。

---

## ✅ Looks Good

- **Logging**：`reply-tasks-send.ts` 使用 `logger.warn` / `logger.info` 带 `[ReplyTasks]` 与 taskPageId，无 `console.log`。
- **Error handling**：`sendOneReplyTask` 用 try/catch 包裹发信与回写，失败返回 `{ ok: false, error }` 不抛错；配置校验与路径穿越防护与现有 inbound-listener-config 一致。
- **TypeScript**：无 `any`，接口清晰（`ReplyTasksEntry`、`ReplyTaskSendContext`、`SendOneResult` 等）；Notion 类型用 `Parameters<Client["pages"]["update"]>[0]["properties"]` 等约束。
- **Production readiness**：无 TODO、无硬编码密钥；NOTION_API_KEY 从 env 读取；配置路径支持 env 且做 `..` 校验。
- **Security**：配置路径防穿越；`taskPageId` 仅作 Notion API 的 page_id，不参与路径；前端 `escapeHtml`/`escapeAttr` 用于展示，正文提交经转义或按设计接受 HTML。
- **Architecture**：与现有 inbound-listener / schedule 配置、notion-queue 发件人凭据、gmail-send 风格一致；模块边界清晰（config / notion 适配 / 发信流程 / server 路由与 UI）。

---

## ⚠️ Issues Found

- **[MEDIUM]** [[server.ts:391-393](src/server.ts)] - Reply Tasks API（list / send / send-batch）中若 `listReplyTasks`、`getReplyTaskSendContext` 或 Notion API 抛错，会被最外层 catch 统一以 400 返回，无法区分客户端错误（如 taskPageId 无效）与服务端/Notion 错误。
  - Fix: 在 `/api/reply-tasks/list`、`/api/reply-tasks/send`、`/api/reply-tasks/send-batch` 的 handler 内对上述调用包 try/catch，对 Notion 的 404/403 等返回 404 或 400、对其它异常返回 500，或至少将 Notion 错误与校验错误区分（例如按 `e?.code === 'object_not_found'` 返回 404）。

- **[LOW]** [[server.ts:827-832](src/server.ts)] - 编辑 Reply Tasks 条目时，`modalReplyTasksEntrySave` 使用 `currentReplyTasksConfig.entries[editingReplyTasksEntryIndex]`；若因竞态或异常导致 `editingReplyTasksEntryIndex` 为 -1 或越界，会得到 `{}` 并对其赋值，不会更新到列表，用户可能误以为保存成功。
  - Fix: 保存前校验 `editingReplyTasksEntryIndex >= 0 && editingReplyTasksEntryIndex < currentReplyTasksConfig.entries.length`，否则不写回并可选 `closeReplyTasksEntryModal()` 或提示。

- **[LOW]** [[notion-reply-tasks.ts:86-89](src/notion-reply-tasks.ts)] - `listReplyTasks` 使用 `page_size: 100` 且未分页，Task 超过 100 条时只返回前 100 条。
  - Fix: 若需支持更多，可循环 `notion.databases.query` 的 `next_cursor` 合并结果，或文档中说明“当前最多 100 条”。

- **[LOW]** [[reply-tasks-send.ts:49](src/reply-tasks-send.ts)] - 当调用方传入的 `bodyHtml` 为空字符串 `""` 时，会走 `plainToHtml(ctx.suggestedReply)`，与“不传”行为一致；若希望空串表示“发空正文”，当前逻辑会忽略空串。
  - Fix: 若产品上需区分“不编辑”与“清空正文”，可改为 `bodyHtml === undefined ? plainToHtml(ctx.suggestedReply) : bodyHtml`（空串则发空正文）；否则保持现状并可在注释中说明“空串视为未提供，使用 Suggested Reply”。

---

## 📊 Summary

- **Files reviewed:** 5（reply-tasks-config.ts, notion-reply-tasks.ts, gmail-send.ts 新增部分, reply-tasks-send.ts, server.ts Reply Tasks 相关）
- **Critical issues:** 0
- **Warnings:** 1 MEDIUM（API 错误分类）, 3 LOW（编辑保存边界、列表分页、bodyHtml 空串语义）
