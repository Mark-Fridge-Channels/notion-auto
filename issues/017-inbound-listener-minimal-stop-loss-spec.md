# 017 - 增强 Inbound Listener 最小止损：Unsubscribe/Hard Bounce 规则与 Touchpoint 写回

**Type:** improvement  
**Priority:** normal  
**Effort:** medium  

---

## TL;DR

按新规范增强 Listener 侧「最小止损」：对 Unsubscribe 与 Hard Bounce 使用更精确的判定（body 归一化、强/弱规则、Hard vs Soft 区分），并补全 Touchpoint 写回字段（Unsubscribe Flag、Bounce Flag、Bounce Type、Last Inbound At），一旦命中立即写回 Touchpoints 停掉自动跟进。

---

## Current state

- **Unsubscribe**：整段 `body_plain` 转小写 + 简单去 `>...` 后做包含匹配，关键词：`unsubscribe`, `remove me`, `do not contact`, `opt out`, `stop`，及中文 `退订` / `不要再发` / `别再联系`。无「新内容片段」（如 `On ... wrote:` 前）、无强/弱规则、无 `^\s*stop\s*$` 整段匹配。
- **Hard Bounce**：from + subject + body 拼成一段做包含匹配，仅少数 marker（mailer-daemon, postmaster, delivery status notification, undelivered, mailbox not found, user unknown）。无「候选筛选 + Hard 特征」两步、无排除 soft（mailbox full、4.x.x、temporarily deferred 等）。
- **Touchpoint 写回**：只写 `Stop Flag`、`Stop Reason`、`Email Status = Stopped`、`Next Send At = null`。**未写**：`Unsubscribe Flag`、`Bounce Flag`、`Bounce Type`、`Last Inbound At`。
- **优先级**：已是 Unsubscribe 优先、再 Bounce Hard，符合预期。

---

## Expected outcome

1. **前置条件**（已满足）：幂等按 Message ID 跳过；仅当已归属唯一 Touchpoint 时执行止损写回。
2. **Unsubscribe**  
   - 引入 `body_plain_normalized`：小写、去多余空白、**去掉引用历史**（推荐：取 `On ... wrote:` 等分隔符之前的新内容片段）。  
   - **强命中**：新内容片段满足任一条：`^\s*stop\s*$`；或包含英文关键词 `unsubscribe`, `remove me`, `do not contact`, `don't contact`, `stop emailing`, `stop sending`；或包含中文关键词 `退订`, `取消订阅`, `不要再(联系|跟进|发)`, `别再发`, `停止发送`, `拉黑我`。  
   - **弱命中**（可选）：同时包含 `not interested`/`no longer interested` 与 `stop`/`don't`/`do not`/`remove`；弱命中时 IM 可设 `Needs Review=true`，Touchpoint 仍止损。  
   - 写回 Touchpoint：`Unsubscribe Flag = true`，`Stop Flag = true`，`Email Status = Stopped`，`Stop Reason = Unsubscribe`，`Next Send At = null`，`Last Inbound At = received_at`。
3. **Hard Bounce**  
   - **候选筛选**（任一）：from 含 mailer-daemon/postmaster；subject 含 delivery status notification / undelivered mail / mail delivery failed / returned mail / failure notice；body 含 diagnostic-code / status: / final-recipient: / action: failed。  
   - **Hard 判定**：在 body_plain_normalized 中命中 A（user unknown, no such user, mailbox not found, 550 5.1.1/5.1.0, status: 5.1.1/5.1.0 等）或 B（domain not found, host not found, nxdomain, unrouteable address）。**排除** soft：mailbox full、temporarily deferred、try again later、4.x.x、status: 4. 等。  
   - 写回 Touchpoint：`Bounce Flag = true`，`Bounce Type = Hard`，`Stop Flag = true`，`Email Status = Stopped`，`Stop Reason = Bounce Hard`，`Next Send At = null`，`Last Inbound At = received_at`。
4. **冲突优先级**：同封邮件多信号时只写最高优先级：1) Unsubscribe，2) Bounce Hard。

---

## Relevant files

- `src/inbound-listener.ts` — `detectUnsubscribe` / `detectHardBounce` 重写；`processOneMessage` 中调用顺序与传参（如 received_at 用于 Last Inbound At）。
- `src/notion-inbound.ts` — `updateTouchpointStop` 扩展：支持 Unsubscribe 时写 `Unsubscribe Flag`，Bounce 时写 `Bounce Flag` + `Bounce Type`，以及可选 `Last Inbound At`；若表结构暂无这些列需在 Notion 中先加。

---

## Risks / Notes

- **Notion 表结构**：Touchpoints 表需存在 `Unsubscribe Flag`（checkbox）、`Bounce Flag`（checkbox）；Queue 过滤已使用，必填。`Bounce Type`（select，如 Hard）、`Last Inbound At`（date）为可选：若表中暂无这两列，程序会打日志并继续，不中断；若需写入这两项，请在 Notion 中预先加列。
- **引用块分割**：`On ... wrote:` 等分隔符在不同邮件客户端中格式不一，实现时用简单正则（如 `/\n\s*On\s+.+wrote:\s*$/i` 取之前部分）即可，避免过度复杂。
- **验证**：入站内容开头为 `STOP`（引用前）应命中 Unsubscribe，并写回 Touchpoints：Stopped + Unsubscribe。
