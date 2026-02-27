# Inbound Listener（事实落库版）

**类型**：feature  
**优先级**：normal  
**预估**：medium（多组 + 路由 + Gmail 读权限，非 trivial）

---

## TL;DR

实现「多邮箱 + 实时监听回复 + 按回复内容自动判定状态 + 回写 Notion」的**事实落库**部分：程序只负责把 Gmail 入站邮件可靠、幂等地写入 Notion 📥 RE Inbound Messages，并尽力关联 📬 Touchpoint；可选对 Unsubscribe/Hard Bounce 做最小止损写回 Touchpoints。分类、推进、任务生成交给 Notion AI/Notion 自动化。

---

## 当前状态 vs 预期

| 维度 | 当前 | 预期 |
|------|------|------|
| Gmail | 仅发信（`gmail.send`），无读邮件 | 需拉取入站（push 或轮询），解析 message/thread/body |
| Notion | Queue + 发件人库（写 Queue、读发件人） | 新增 📥 Inbound Messages 写入、📬 Touchpoints 查询/可选更新 |
| 多邮箱/多组 | 无 | 同一 mailbox 可属多组；按「组配置」决定写哪张 IM 表，多组时用「路由到唯一 Touchpoint 的 group 优先，否则落默认 group」 |
| 幂等 | 无入站流 | 以 Gmail `message.id` 为幂等键，存在则 skip 全流程 |
| 路由 | 无 | Thread ID 精确匹配（必须）；from_email + 14 天 + subject 弱匹配（可选兜底） |
| 止损 | 无 | 可选：Unsubscribe / Hard Bounce 时写回 Touchpoints（Stop Flag、Email Status=Stopped 等） |

---

## 需求要点（工程必须遵守）

1. **落库第一**：每封新入站先尝试写入 📥 Inbound Messages（幂等保证不重复）。
2. **幂等键**：`Message ID = Gmail message.id` 全局唯一；存在则 **skip 全流程**。
3. **尽力路由 Touchpoint**：能唯一归属就写 relation；不能归属也必须落库，并标记 `Needs Review=true`（若启用）。
4. **可选最小止损**：仅对已归属 Touchpoint 且确定性信号（Unsubscribe、Bounce Hard）立即写回 Touchpoints。
5. **多组写入策略（MVP）**：按配置顺序遍历 group → 哪个 group 路由到**唯一** Touchpoint，就把 IM 写入该 group 的 IM 表并停止；若全部路由失败 → 写入「第一个 group」的 IM 表，Touchpoint 为空，`Needs Review=true`。**同一封 message 不写入多张 IM 表。**

---

## 输入 / 输出

- **输入（每封 Gmail）**：`gmail_message_id`, `thread_id`, headers（From/To/Subject/Delivered-To）, `internalDate`, `snippet`, `body_plain`（可截断 20k–50k，超长保留开头+结尾）。
- **输出**：1 条 📥 Inbound Messages（幂等创建）；可选更新 1 条 📬 Touchpoints（止损）。

---

## 多组配置（必须）

每个 Group：

- `inbound_messages_db_id`
- `touchpoints_db_id`
- `notion_token`（或统一 token）
- `mailboxes[]`（该组监听的收件箱）

同一 mailbox 属多组时，按 2.1 写入策略决定落库到哪一张 IM 表（见上）。

---

## 实现清单（最小模块）

1. **配置加载**：groups + mailboxes + notion token + db ids（新 config 或 env，与现有 Queue 配置可并存）。
2. **Gmail 拉取增量**：push（watch+history）或轮询时间窗口 + 入站方向过滤；message 解析（含 body_plain 解码与截断）。
3. **Notion Adapter**：
   - query IM by Message ID（幂等）；
   - query Touchpoints by Thread ID；
   - create IM row（含 relation）；
   - (optional) update Touchpoint stop fields。
4. **多组路由策略**：2.1 + Step 3（Thread 优先，可选兜底）。
5. **运行日志**：每条 message 输出 `mailbox / message_id / resolved_group / touchpoint_found / wrote_im / stop_written`。

---

## 路由 Touchpoint 最小可实现算法

- **必须**：Thread ID 精确匹配 → 在该 group 的 📬 Touchpoints 查 `Thread ID == thread_id`；命中唯一则路由成功；0 则走兜底或失败；>1 当作失败（不自动绑定）。
- **可选兜底**：thread 不命中时，`from_email + 14 天窗口 + subject 弱匹配` 找候选；MVP 可不做，直接路由失败落默认 group。

---

## 可选最小止损（Step 5）

- **Unsubscribe/STOP**：body 命中关键字（unsubscribe, remove me, 退订 等）→ 写 Touchpoints：Stop Flag=true, Stop Reason=Unsubscribe, Email Status=Stopped, Next Send At=null；IM 可选 Classification=Unsubscribe。
- **Hard Bounce**：from/subject/body 命中（mailer-daemon, Delivery Status Notification, mailbox not found 等）→ 写 Touchpoints：Stop Flag=true, Stop Reason=Bounce Hard, Email Status=Stopped 等；IM 可选 Classification=Bounce Hard。

---

## 相关文件（需动或新增）

- **新增**：Inbound Listener 入口（如 `src/inbound-listener.ts` 或 `scripts/inbound-listener.ts`）、Gmail 拉取与解析（需 `gmail.readonly` 或 `gmail.modify`）、Notion 写入 IM/查询 TP 的 adapter、多组配置 schema 与加载。
- **可复用/参考**：`src/notion-queue.ts`（parseDatabaseId、Notion 查询/更新模式）、`src/gmail-send.ts`（Gmail 客户端与 OAuth；Listener 需额外 scope）。
- **配置/环境**：`env.example` 或新配置文件（group 的 db id、mailboxes、token）；Gmail OAuth 需增加读邮件 scope。

---

## 风险与备注

- **Gmail 权限**：当前仅 `gmail.send`；Listener 需 `gmail.readonly`（或 `gmail.modify` 若做 label），用户需重新授权。
- **多组 + 幂等**：查幂等时需确定「先查哪个 IM 表」—— 先做路由再查目标 group 的 IM 表可避免重复写；若先在默认 group 查一次可省 Notion 调用但需与 2.1 策略一致。
- **Body 截断**：建议 max 20k–50k 字符；超长保留开头+结尾（结尾常有 STOP/签名/DSN）。
- **不要因路由失败而不落库**：路由失败只影响 Touchpoint relation，不影响 IM 写入。

---

## 参考

- 工程任务说明：用户提供的《Inbound Listener（事实落库版）开发说明 v1.0》全文（本 issue 为其精简与追踪版）。
