# 探索：为什么 Queue Sender 显示「本批无待发项」

## 1. 代码逻辑摘要

### 1.1 API 查询条件（queryQueuePending）

Notion API 的 filter 要求**同时**满足：

| 条件 | 代码中的字段 | 你 CSV 中的对应值 |
|------|--------------|-------------------|
| Email Status = Pending | `Email Status` | Pending ✓ |
| Stop Flag = false | `Stop Flag` | 空/No ✓ |
| Unsubscribe Flag = false | `Unsubscribe Flag` | No ✓ |
| Bounce Flag = false | `Bounce Flag` | No ✓ |
| Needs Review = false | `Needs Review` | No ✓ |
| Email 非空 | `Email` | oh.duang@gmail.com ✓ |
| Email Subject 非空 | `Email Subject` | "Quick question, Tyrone" 等 ✓ |
| Email Body 非空 | `Email Body` | 有正文 ✓ |

只要**属性名或类型**在 Notion 里和代码不一致（例如多了空格、或某 Flag 不是 checkbox），API 可能报错或返回 0 条，也会导致「本批无待发项」。

### 1.2 应用内再过滤（pageToQueueItem）

即使用户的库能通过上面所有 filter，每条被返回的 page 还会在内存里再筛一次，**任一不满足即被丢弃**（返回 null，不进入待发列表）：

| 条件 | 含义 | 你 CSV 中的对应值 |
|------|------|-------------------|
| Email Status === "Pending" | 再次确认状态 | Pending ✓ |
| Sent At Last 为空 **且** Message ID Last 为空 | 未发过、幂等 | 均为空 ✓ |
| Email / Email Subject / Email Body 均非空 | 必填内容 | 均有 ✓ |
| **Planned Send At 若存在，则 当前时间 ≥ Planned Send At** | **仅到点或已过点的才发** | 见下 |

也就是说：**只要「当前时间」早于某条的 Planned Send At，这条就不会被纳入本批**。

---

## 2. 你 CSV 里的 Planned Send At

从你导出的 CSV 里，这 5 条的 **Planned Send At** 为（按行）：

- `February 25, 2026 3:01 PM (GMT+8)`
- `February 25, 2026 2:43 PM (GMT+8)`
- `February 25, 2026 2:35 PM (GMT+8)`
- `February 25, 2026 2:52 PM (GMT+8)`
- `February 25, 2026 2:28 PM (GMT+8)`（最早）

代码里用的是 **运行 Queue Sender 时的服务器/本机时间** `now`，与 Notion 里存的 **Planned Send At**（API 返回的 date 会带时区/ISO）做比较：  
`if (plannedSendAt != null && now < plannedSendAt) return null`。

因此：

- 若你**跑 Queue Sender 的时间早于**上述最早时间（例如早于 2026-02-25 14:28 GMT+8），这 5 条**全部**会在 `pageToQueueItem` 里被过滤掉 → 最终 `items.length === 0` → 日志里就会是「本批无待发项」。
- 若跑的时候已经晚于**所有**这些时间，则至少最早那条（2:28 PM）应能通过；若仍显示「本批无待发项」，就说明要么 API 没返回任何一条（见下），要么还有别的原因（例如属性名/类型）。

---

## 3. 结论与可能原因排序

### 最可能原因：Planned Send At 未到点

- 当前逻辑：**只有「当前时间 ≥ Planned Send At」的项才会被纳入本批**。
- 你 CSV 里每条都有未来的 Planned Send At；若运行时间早于这些时间，就会全部被过滤 → 「本批无待发项」。
- **建议**：在「已到或已过 Planned Send At」的时间再跑一次（例如服务器时间 ≥ 2026-02-25 14:28 GMT+8），或临时把某条的 Planned Send At 改成过去时间做验证。

### 次可能原因：API 查询就返回 0 条

- Notion 里**属性名**必须与代码完全一致（含大小写、空格），例如：  
  `Email Status`、`Stop Flag`、`Unsubscribe Flag`、`Bounce Flag`、`Needs Review`、`Email`、`Email Subject`、`Email Body`、`Planned Send At`、`Queued At`。
- 四个 Flag 在 Notion 里必须是 **Checkbox** 类型；Email Status 已支持 Status/Select。
- 若任一 filter 对应的属性名或类型不一致，API 可能报错或返回 0 条 → 同样会「本批无待发项」。
- **建议**：在 Notion 数据库属性里逐项对照上述名称和类型；若有报错，看 Queue Sender 日志里的 Notion API 错误信息。

### 其他

- **Queued At**：只用于排序，不用于「是否待发」；有值即可。
- **Sender Account**：在查询阶段不参与过滤，只影响发信时去发件人库匹配；不会导致「本批无待发项」。

---

## 4. 建议的下一步（不实现，仅排查）

1. **确认运行时间与 Planned Send At**  
   - 在计划发送时间**之后**再跑一次 Queue Sender（或把一条的 Planned Send At 改为过去时间），看是否仍「本批无待发项」。
2. **确认 Notion 属性名与类型**  
   - 在 Notion 里检查：Email Status、四个 Flag、Email、Email Subject、Email Body、Planned Send At、Queued At 的名称和类型是否与代码一致。
3. **可选：加临时日志**  
   - 在 `queryQueuePending` 里打日志：`response.results.length`（API 返回条数）以及 `pageToQueueItem` 为 null 时的原因（例如 `plannedSendAt` 与 `now`），便于区分是「API 返回 0」还是「全部被 Planned Send At 筛掉」。

如你愿意，我可以根据当前代码结构写一段「临时调试日志」的具体改法（只加日志、不改变业务逻辑）。
