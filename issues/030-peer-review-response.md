# Peer Review 回应：PLAN-030 邮件 Zoho/M365 兼容

以下对 code review（issues/030-email-zoho-m365-code-review.md）中每条 finding 的核实与处理结论。

---

## 逐条核实

### 1. **[MEDIUM] Zoho 发信 API 若未返回 messageId 会抛错**（zoho-mail.ts:152–156）

- **核实**：代码存在。`sendZohoCold1` 中 `const messageId = res.data?.messageId; if (!messageId) throw new Error("Zoho 发信未返回 messageId");`。Zoho 官方文档未明确发信接口响应是否含 `messageId`，若实际不返回或结构不同，会导致整条 Queue 回写失败。
- **结论**：**成立**，严重程度 MEDIUM 合理。
- **处理**：修改实现：当 `res.data?.messageId` 为空时不再抛错，返回占位 `{ messageId: "", threadId: "zoho-sent" }`，与 M365 Cold1 行为一致，避免因 API 响应差异导致误伤。

---

### 2. **[MEDIUM] M365 Cold1 回写 Notion 的 messageId 为占位**（m365-mail.ts:109）

- **核实**：存在。`sendM365Cold1` 返回 `messageId: ""`、`threadId: "m365-cold1"`；queue-sender 使用 `result.messageId || result.threadId` 回写，故 Message ID Last 会写入 `"m365-cold1"`。若该行后续被当作 Followup 发送，会调用 `sendM365Reply(accessToken, "m365-cold1", htmlBody)`，Graph 会因 id 非法而失败。
- **结论**：**成立**。M365 新邮件本身不返回 messageId（202 无 body），当前为设计上的简化；影响范围仅限于「由 M365 Cold1 发出的那行再发 Followup」的场景。
- **处理**：不在本阶段改架构。在 `sendM365Cold1` 上方注释中明确说明：M365 新邮件不返回 messageId，返回值为占位；若需 M365 Followup，需从已发送文件夹查最近一条取 id 或后续迭代实现。可选在 README 中简述 M365 Cold1 的 Message ID 为占位。

---

### 3. **[LOW] Token 失败时错误信息含 API 响应全文**（zoho-mail / m365-mail）

- **核实**：存在。`throw new Error(\`Zoho token 请求失败: ${res.status} ${t}\`)` 等将 `res.text()` 完整带入异常；queue-sender 将 `msg.slice(0, 2000)` 写入 Notion stopReason。
- **结论**：**成立**，风险为 LOW。OAuth token 接口通常只返回 `error` / `error_description`，不含 token；保留全文有利于排查。
- **处理**：当前保留实现；不在本次改动中截断或脱敏。若后续有合规要求，再改为只保留 status 或 `error_description` 前 N 字符。

---

### 4. **[LOW] Provider 与 Notion Select 选项必须完全一致**（notion-inbound.ts:110）

- **核实**：存在。`"Provider": { select: { name: providerName } }` 要求 Notion 中该列已有同名选项，否则会失败或创建新选项（视工作区设置而定）。
- **结论**：**成立**，属使用约定问题。
- **处理**：在 README 多厂商说明中补充一句：Provider 列 Select 选项须为 **Gmail**、**Zoho**、**Microsoft 365**（拼写与空格与 Notion 中一致）。

---

### 5. **[LOW] Zoho/M365 无网络重试**

- **核实**：存在。gmail-read 有 `withRetry`，zoho-mail、m365-mail 的 fetch 无重试。
- **结论**：**成立**，行为与 Gmail 不一致，偶发网络问题时更容易失败。
- **处理**：不在此次实现。列为后续优化：若需要可与 Gmail 对齐，为 Zoho/M365 的 token 与 API 请求增加简单重试（次数与间隔可参考 gmail-read）。

---

## 总结

| 类型 | 数量 | 说明 |
|------|------|------|
| **确认需修复** | 1 | Zoho Cold1 在无 messageId 时改为返回占位，不抛错。 |
| **确认成立、仅文档/注释** | 2 | M365 Cold1 占位语义在注释与可选 README 中说明；Provider 选项命名在 README 中约定。 |
| **确认成立、本次不改** | 2 | Token 错误信息含全文（保留便于排查）；Zoho/M365 无重试（后续优化）。 |
| **不成立** | 0 | 无。 |

---

## 优先处理清单

1. **立即做**：修改 `sendZohoCold1`，当 `res.data?.messageId` 为空时返回 `{ messageId: "", threadId: "zoho-sent" }`，不再抛错。
2. **建议做**：在 `sendM365Cold1` 注释中明确「M365 新邮件不返回 messageId，返回值为占位」；在 README 多厂商段落中补充 Provider Select 选项须为 Gmail / Zoho / Microsoft 365（拼写与空格一致）。
3. **后续**：考虑为 Zoho/M365 增加网络重试；若有合规需求再收敛 token 错误信息内容。
