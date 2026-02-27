# 017 探索：新增最小止损逻辑与项目原有逻辑的关系

**结论：与现有逻辑兼容，无冲突；需注意表结构约定与一处 IM 更新能力。**

---

## 1. 现有逻辑要点

### 1.1 同一张表：Queue = Touchpoints

- **Queue Sender**（`notion-queue.ts` + `queue-sender.ts`）：按「待发」条件查库，发信后把该行更新为 Done。
- **Inbound Listener**（`notion-inbound.ts` + `inbound-listener.ts`）：按 Thread ID 查同一张表做路由，命中后写 IM，并对 Unsubscribe/Hard Bounce 写回该行（止损）或对普通回复写 Replied。

即：**出队发信** 和 **入站路由/止损** 共用同一张 Notion 表（Queue/Touchpoints）。

### 1.2 Queue Sender 的过滤条件（不能发的那几类）

`notion-queue.ts` 里 `QUEUE_BASE_FILTER` 已包含：

- `Email Status` = Pending（再结合应用内过滤）
- `Stop Flag` = false
- **`Unsubscribe Flag` = false**
- **`Bounce Flag` = false**
- `Needs Review` = false
- Email / Email Subject / Email Body 非空

因此：**表中已默认存在 `Unsubscribe Flag`、`Bounce Flag` 列**，Queue Sender 依赖它们排除「已退订/已退信」的行。当前 Listener 只写 `Stop Flag` + `Email Status = Stopped`，未写这两个 Flag，但靠 `Email Status = Stopped` 和 `Stop Flag = true` 已经能让该行不再被发出。新增 017 后**补写** `Unsubscribe Flag` / `Bounce Flag`，与现有过滤逻辑一致，且更清晰。

### 1.3 当前 Listener 止损写回（notion-inbound.updateTouchpointStop）

只写：

- `Stop Flag` = true  
- `Stop Reason` = "Unsubscribe" | "Bounce Hard"  
- `Email Status` = Stopped（Select）  
- `Next Send At` = null（可选）

不写：Unsubscribe Flag、Bounce Flag、Bounce Type、Last Inbound At。

### 1.4 当前流程顺序（inbound-listener.processOneMessage）

1. 无 Touchpoint → 直接 return，不写 IM。  
2. 有 Touchpoint → 幂等查 IM（Message ID）→ 已存在则 return。  
3. 创建 IM（classification=Other）→ 再根据 body/from/subject 判断：  
   - Unsubscribe → `updateTouchpointStop(Unsubscribe)` + `updateInboundMessageClassification(Unsubscribe)`  
   - 否则 Hard Bounce → `updateTouchpointStop(Bounce Hard)` + `updateInboundMessageClassification(Bounce Hard)`  
   - 否则 → `updateTouchpointOnReply`（Email Status = Replied）  
4. 优先级已是：Unsubscribe > Bounce Hard > 普通回复。

---

## 2. 017 新增逻辑与原有逻辑的对接

| 点 | 结论 |
|----|------|
| **Queue Sender 过滤** | 已按 Unsubscribe Flag / Bounce Flag = false 过滤；017 只是把 Listener 侧「止损时」这两个 Flag 设为 true，**与现有过滤完全兼容**，不会导致误发。 |
| **同一表写 Replied vs Stopped** | 普通回复写 `Email Status = Replied`，止损写 `Email Status = Stopped`；017 不改变谁写 Replied/Stopped，只增加止损时多写几个字段，**无冲突**。 |
| **优先级** | 017 要求 Unsubscribe > Bounce Hard；当前实现已是先判 Unsubscribe 再判 Bounce，**一致**。 |
| **幂等 / 只对有 Touchpoint 的写回** | 017 前置条件（Message ID 幂等、仅对已归属 Touchpoint 写回）当前已满足，**无需改流程**。 |

---

## 3. 需要特别注意的点

### 3.1 Touchpoints 表结构（新增/可选字段）

- **已有且必用**：`Stop Flag`、`Stop Reason`、`Email Status`、`Next Send At`；以及 Queue 侧已在用的 **`Unsubscribe Flag`、`Bounce Flag`**（017 只需在止损时写入 true）。
- **017 新增写回、可能表里暂无的**：  
  - `Bounce Type`（Select，如 Hard）  
  - `Last Inbound At`（Date）

若表中尚无这两列，需在 Notion 中先加，或在 017 里做成「有则写、无则跳过」（例如按属性存在性/API 错误做 try-catch），避免整次更新失败。建议在实现前确认表结构或采用「可选写」并打日志。

### 3.2 弱命中 Unsubscribe 时给 IM 设 Needs Review

017 要求：弱命中（not interested + stop/don't/remove）时，Touchpoint 仍止损，且 **Inbound Message 的 `Needs Review = true`**。

当前：  
- 创建 IM 时 `needsReview` 来自 `routeToGroup`，只有「未命中唯一 Touchpoint」才为 true；  
- 有 Touchpoint 时创建 IM 时 needsReview 为 false，且**没有**「事后只改 IM 的 Needs Review」的接口。

因此需要：  
- 要么在 **notion-inbound** 增加「只更新 IM 的 Needs Review」的接口（例如 `updateInboundMessageNeedsReview(notion, imPageId, true)`），  
- 要么在现有某次 update 时顺带写 Needs Review（例如扩展 `updateInboundMessageClassification` 的调用处，多传一个 needsReview 并在 IM 上更新）。  
否则弱命中无法满足「Touchpoint 止损 + IM 标 Needs Review」的预期。

### 3.3 body_plain_normalized 与引用块

017 要求对 body 做归一化并优先看「新内容片段」（如 `On ... wrote:` 之前）。  
这部分是 **纯检测逻辑**：在 `inbound-listener` 里先算出一段 normalized / 新内容，再传给 `detectUnsubscribe` / `detectHardBounce`。  
不改变「何时写 IM、何时调 updateTouchpointStop/OnReply」的顺序，也不改 Notion 表结构，**对原有流程无破坏性**。

### 3.4 updateTouchpointStop 的扩展方式

当前 `updateTouchpointStop` 只接受 `stopReason` 和 `nextSendAtNull`。  
017 要在此基础上按类型写：

- Unsubscribe：`Unsubscribe Flag = true`，`Last Inbound At = received_at`（及现有 Stop/Email Status/Next Send At）。  
- Bounce Hard：`Bounce Flag = true`，`Bounce Type = Hard`，`Last Inbound At = received_at`（及现有字段）。

建议：  
- 扩展 payload，例如 `reason: "Unsubscribe" | "Bounce Hard"`，再加可选 `receivedAt?: Date`；  
- 在函数内部根据 reason 决定写哪些 checkbox/select/date；  
- 若某属性写入报错（例如列不存在），可 catch 后打 warn，不抛错，保证至少 Stop Flag + Email Status + Stop Reason 已写入（与现有行为一致）。

这样既满足 017，又不在表未准备好时拖垮现有止损。

---

## 4. 小结

- **与原有逻辑无冲突**：Queue Sender 已按 Unsubscribe/Bounce Flag 过滤；Listener 只增加更细的判定和更多写回字段，不改变「谁可以发、谁被停发」的语义。  
- **必须落地的**：  
  - 在 `updateTouchpointStop` 中按 017 写 Unsubscribe Flag / Bounce Flag / 可选 Bounce Type / 可选 Last Inbound At；  
  - 弱命中 Unsubscribe 时，为 IM 设 Needs Review（需新增或扩展 IM 更新接口）。  
- **建议事先确认或做兼容**：Touchpoints 表是否有 Bounce Type、Last Inbound At；若无则 Notion 加列或在代码里做可选写 + 容错。
