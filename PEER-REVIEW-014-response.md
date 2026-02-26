# Peer Review 回应：Queue Sender (PLAN-014)

以下为「另一位团队负责人」（对项目历史与决策了解较少）可能提出的若干条意见，逐条核实后的结论与修复计划。

---

## 模拟的同行评审意见及核实

### Finding 1  
**“代码里用 Notion 属性 `password`（小写）；Notion 里列名常为 `Password`，可能导致取不到值。”**

1. **核实**：`src/notion-queue.ts` 第 183 行使用 `props["password"]`。Notion API 返回的 property key 与数据库内属性名一致，若建库时命名为 "Password"，key 通常为 "Password"，小写 "password" 会取不到。
2. **结论**：**成立**。与 REVIEW-014 中的「建议」一致。
3. **严重性**：MEDIUM（配置/文档问题，可能导致所有发件人“未找到凭据”）。

---

### Finding 2  
**“若 `updateQueuePageFailure` 或 `updateQueuePageSuccess` 抛错（如 Notion API 超时），`runBatch` 只 catch 并打日志，该行会一直保持 Pending，可能被反复拉取并重复发送。”**

1. **核实**：`runBatch` 中对 `processOne` 有 try/catch，仅 `logger.warn`；`processOne` 内成功/失败分支都会调用 `updateQueuePage*`，若这些 Notion 调用抛错，异常会向上抛出并被上述 catch 捕获，不会写回 Queue，该 page 仍为 Pending。
2. **结论**：**成立**。
3. **严重性**：MEDIUM。实际发生概率依赖网络与 Notion 可用性；一旦发生，同一条可能被多次发送或反复失败。

---

### Finding 3  
**“没有多进程/分布式锁，若同时跑两个 Queue Sender 实例，可能同时处理同一条 Pending 并重复发信。”**

1. **核实**：当前设计为「单 Dashboard 单进程」启停 Queue Sender，无文件锁或分布式锁；若用户手动起两个进程或多机部署，`queryQueuePending` 可能返回相同项，两条发送逻辑都会执行，存在重复发送窗口。
2. **结论**：**成立**，属于设计取舍（当前假定单实例）。
3. **严重性**：LOW。在约定单实例下可接受；若未来多实例需在文档或实现中说明/加锁。

---

### Finding 4  
**“MIME 里 From/To 未像 Subject 一样做换行符过滤，若 Notion 中 From/To 含换行可能造成头注入。”**

1. **核实**：`gmail-send.ts` 中 `buildCold1Mime` / `buildFollowupMime` 仅对 `subject` 做 `subject.replace(/\r?\n/g, " ")`，From/To 直接拼接进 MIME 头。
2. **结论**：**成立**。与 REVIEW-014 的「邮件头安全」建议一致。
3. **严重性**：LOW。发件人/收件人多为受控 Notion 字段；若后续有不可信输入，应加固。

---

### Finding 5  
**“发件人库中匹配到行但 password 或 email 为空时，`fetchSenderCredentials` 返回 null，前端只看到‘未找到发件人凭据’，无法区分‘无匹配行’和‘匹配到但凭据不完整’。”**

1. **核实**：`fetchSenderCredentials` 在 `!email || !password` 时统一返回 null；`processOne` 中统一写回「未找到发件人凭据: Sender Account=xxx」。
2. **结论**：**成立**。
3. **严重性**：LOW。可改进错误信息便于排查（如“发件人凭据不完整（缺 Email 或 password）”）。

---

## 汇总

### 确认成立的问题（需处理）

| # | 描述 | 严重性 |
|---|------|--------|
| 1 | Notion 发件人库属性名 `password` 大小写与 Notion 实际列名可能不一致 | MEDIUM |
| 2 | Notion 回写抛错时该行保持 Pending，可能重复发送或反复失败 | MEDIUM |
| 3 | 多实例无锁，可能重复发送（设计假定单实例） | LOW |
| 4 | From/To 未做换行符过滤，存在头注入理论风险 | LOW |
| 5 | “未找到凭据”未区分“无匹配行”与“凭据不完整” | LOW |

### 不成立或已覆盖的项

- 无。上述 5 条均存在；其中 3、4、5 为 LOW，且 4 已在 REVIEW-014 中记录。

---

## 建议的修复优先级与动作

1. **P0（建议尽快）**
   - **Finding 1**：在 README/配置说明中明确：发件人库中用于 refresh token 的属性名需与代码一致（当前为小写 `password`）；或在代码中兼容 `password` / `Password`（例如先取 `props["password"]`，为空再取 `props["Password"]`）。
   - **Finding 2**：在 `runBatch` 的 catch 中，对「已发送但回写失败」做一次尽力而为的失败回写（例如用 `updateQueuePageFailure` 写上 “回写 Notion 失败，请人工核对发送状态”），并打日志；若该回写再失败则仅日志。这样可降低“已发信但行仍 Pending”导致的重复发送概率。

2. **P1（可排期优化）**
   - **Finding 5**：在 `fetchSenderCredentials` 中区分「无匹配行」与「匹配到但 email/password 为空」，返回不同结果或错误类型，`processOne` 据此写回更具体的 Stop Reason（如“发件人凭据不完整（缺 Email 或 password）”）。

3. **P2（文档/后续）**
   - **Finding 3**：在 README 或运维说明中写明：当前仅支持单实例 Queue Sender，多实例可能重复发信。
   - **Finding 4**：若后续 From/To 接受不可信输入，对 From/To 做与 Subject 类似的换行符过滤或更严格校验。

---

## 小结

- **有效意见**：5 条均成立；2 条 MEDIUM（属性名、回写失败后 Pending），3 条 LOW（多实例、头注入、错误信息）。
- **无效意见**：0 条。
- **建议**：优先处理 P0（属性名文档/兼容 + 回写失败时的补救与日志），再按需做 P1/P2。
