# 018 Reply Tasks · 同行评审复核

对《018-reply-tasks-code-review.md》中的 Findings 逐条核实并评估，决定采纳与否与修复优先级。

---

## Finding 1: [MEDIUM] Reply Tasks API 错误统一返回 400

**结论：成立。**

- **核实**：`/api/reply-tasks/list`、`/api/reply-tasks/send`、`/api/reply-tasks/send-batch` 内未对 `listReplyTasks`、`getReplyTaskSendContext`、`sendOneReplyTask` / `sendBatchReplyTasks` 做 try/catch，异常会冒泡到 handleRequest 最外层 catch（server.ts:391-393），统一 `sendJson(res, 400, { error: message })`。Notion 404/500 与客户端缺参均会变成 400。
- **评估**：与现有 Dashboard API（如 schedule POST、inbound-listener config POST）一致，均依赖同一外层 catch，属当前架构选择。从 REST 语义上区分 4xx/5xx 更利于前端或监控处理，但非必须。
- **采纳**：采纳为改进项；严重程度维持 **MEDIUM**，优先级可低于功能性问题。

---

## Finding 2: [LOW] modalReplyTasksEntrySave 未校验 editingReplyTasksEntryIndex

**结论：成立。**

- **核实**：server.ts:827-832 中 `const e = currentReplyTasksConfig.entries[editingReplyTasksEntryIndex]`；若 `editingReplyTasksEntryIndex` 为 -1 或越界，则 `e` 为 `undefined`，随后对 `e.reply_tasks_db_id` 赋值会抛错（或严格模式下报错）。正常流程下只有从「编辑」或「添加一条」打开弹窗时才会点「保存」，此时 index 由调用方传入，应为有效；唯一异常路径是弹窗关闭时已将 index 置为 -1，若存在未正确解绑的回调或竞态，可能误触保存。
- **评估**：实际发生概率低，但加一道防御性校验成本低，可避免难以复现的边界问题。
- **采纳**：采纳；**LOW**，建议在保存前校验 index 有效性，无效则关闭弹窗并 return。

---

## Finding 3: [LOW] listReplyTasks 仅 page_size: 100，无分页

**结论：成立。**

- **核实**：notion-reply-tasks.ts:92-96 中 `notion.databases.query` 仅传 `page_size: 100`，未使用 `start_cursor`/`next_cursor` 循环，超过 100 条的库只会返回前 100 条。
- **评估**：属实现范围与产品预期问题：若 Reply Tasks 单库常超过 100 条，应加分页或提高上限并文档化；若当前场景以「近期少量待办」为主，100 条可接受，在文档中说明即可。
- **采纳**：采纳为改进/文档项；**LOW**，优先在 README 或 issues/018 注明「当前列表最多返回 100 条」，后续若有需求再加分页。

---

## Finding 4: [LOW] bodyHtml 空串与「未传」行为一致

**结论：成立。**

- **核实**：reply-tasks-send.ts:50 条件为 `bodyHtml != null && bodyHtml !== ""`，故 `bodyHtml === ""` 时走 `plainToHtml(ctx.suggestedReply)`，与未传时行为一致；无法表达「清空正文发送」。
- **评估**：需求澄清为「用户可修改正文后发送」，未要求「支持清空正文」；当前语义（空串视为用默认正文）合理。若产品后续需要「发空正文」，再改语义即可。
- **采纳**：采纳为文档/注释项；**LOW**，在 `sendOneReplyTask` 或该行附近注释说明：空串视为未提供 body，使用 Suggested Reply 转 HTML。

---

## Summary

### 确认问题（需处理）

| # | 严重程度 | 描述 | 处理方式 |
|---|----------|------|----------|
| 1 | MEDIUM | API 错误统一 400，无法区分 4xx/5xx | 在 list / send / send-batch 内对 Notion 与业务调用做 try/catch，按错误类型返回 400/404/500 |
| 2 | LOW | 编辑条目保存时未校验 index | 保存前校验 `editingReplyTasksEntryIndex >= 0 && < entries.length`，否则 return 并关闭弹窗 |
| 3 | LOW | 列表最多 100 条无分页 | 文档说明「当前最多 100 条」；后续若有需求再加分页 |
| 4 | LOW | bodyHtml 空串语义未说明 | 在代码中增加注释：空串视为未提供，使用 Suggested Reply |

### 无效 / 已澄清

- 无。四条均在代码中核实存在，仅对严重程度与修复范围做了裁剪（如 #3、#4 先文档/注释，再视需求改实现）。

---

## 建议执行顺序

1. **立即**：Finding 2 — 在 `modalReplyTasksEntrySave` 中增加 index 校验并无效时关闭弹窗（改动小、防御明确）。 ✅ 已实现
2. **立即**：Finding 4 — 在 `reply-tasks-send.ts` 中为 `bodyHtml` 空串语义加注释。 ✅ 已实现
3. **短期**：Finding 3 — 在 README 或 issues/018 中注明列表最多 100 条。 ✅ 已实现（README）
4. **短期或迭代**：Finding 1 — 为 Reply Tasks 三个 API 增加细粒度错误处理（400/404/500）。 ✅ 已实现（list/send/send-batch 内 try/catch + isNotionNotFoundError → 404/500）
