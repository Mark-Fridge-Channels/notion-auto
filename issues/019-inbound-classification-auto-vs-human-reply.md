# 019 - 入站邮件分类优化：区分自动回复与人工回复（Header + 内容分层判断）

**类型:** feature  
**优先级:** normal  
**预估:** medium  

---

## TL;DR

在 Inbound Listener 中引入「自动回复 vs 人工回复」的可靠判断：**优先用邮件 Header（Auto-Submitted、Precedence: auto_reply、From mailer-daemon/postmaster 等）做分类**，正文/结构做辅助与兜底；扩展 Inbound Classification 为 Human Reply、Auto Reply、Unsubscribe、Bounce Hard、Bounce Soft、Other。**止损检测与分类解耦：无论分类结果如何都照常做 Unsubscribe/Bounce Hard 检测并写回 Touchpoint，分类不阻断止损。**

---

## 探索结论 / 产品决策（已确认）

| 问题 | 决策 |
|------|------|
| STOP 类 Classification | **Unsubscribe**（与现有一致）；不误判为 Auto Reply，止损逻辑不变。 |
| Bounce Soft 与 Touchpoint | **不写回** Touchpoint；只写 IM 的 Classification = "Bounce Soft"。 |
| Precedence | **auto_reply**：第一层强信号（高置信 Auto Reply）。**bulk / list**：不单独判 Auto，仅作弱信号记录（如 flags.precedence_bulk_or_list）供后续分析。 |
| X-Auto-Response-Suppress | **不参与** Auto Reply 判断；仅作辅助字段记录（如 `flags.has_x_auto_response_suppress`），用于分析邮件生态/对方系统类型。 |
| multipart/report | 根或**任意 part** 的 mimeType 命中即进入退信候选，再结合正文二次判 Hard/Soft。 |
| 兜底分类 | 统一用 **Other**（Notion 不新增 unknown）。 |
| 分类与止损 | **分类不阻断止损**。无论分类结果（含已判 Auto Reply），都照常做 Unsubscribe 与 Bounce Hard 检测；命中则写 Touchpoint 止损。止损是「安全阀」，永远执行。 |

---

## 当前状态 vs 期望

| 维度 | 当前 | 期望 |
|------|------|------|
| **Gmail 拉取** | 已用 `format: "full"`（gmail-read.ts） | 保持；需在解析时增加对 Auto-Submitted、Precedence、X-Auto-Response-Suppress、Content-Type 等 Header 的读取与透传 |
| **分类维度** | 仅 `Other` \| `Unsubscribe` \| `Bounce Hard` | 扩展为：**Human Reply**、**Auto Reply**、**Unsubscribe**、**Bounce Hard**、**Bounce Soft**、**Other**（兜底） |
| **自动/人工判断** | 无 | 第一层：Header 确定性（auto-replied / auto_reply / mailer-daemon 等）；第二层：正文规则（OOO 关键词、引用结构）；第三层：unknown |
| **退信识别** | 仅 from/subject/body 关键词 + Hard/Soft 区分 | 增加：Header `Content-Type: multipart/report` + 正文 "Delivery Status Notification (Failure)" 等，明确区分 Bounce Hard / Bounce Soft |
| **STOP 类回复** | 归入 Unsubscribe 并触发止损 | 保持 Classification = Unsubscribe + 止损；仅保证不误判为自动回复（Header/正文不因 STOP 判 Auto） |

---

## 判断逻辑（生产级）

### 第一层：Header 判断（确定性）

- **Auto-Submitted**: `auto-replied` / `auto-generated` → **Auto Reply**
- **Precedence**: 仅 `auto_reply` 作为第一层强信号 → **Auto Reply**；`bulk` / `list` 不单独判 Auto，只记录为弱信号（如 flags）
- **X-Auto-Response-Suppress**: 不参与 Auto 判断；仅记录为辅助字段（如 `flags.has_x_auto_response_suppress`）供后续分析
- **From**: `mailer-daemon@...` / `postmaster@...` → 进入退信分支（见下），**非人工**

### 第二层：退信（Bounce）识别

- Header：`Content-Type: multipart/report` → 系统级投递报告
- 正文典型：`Delivery Status Notification (Failure)`、`Undeliverable`、`Message could not be delivered`
- 根或**任意 part** 的 `mimeType === "multipart/report"` 即退信候选；再结合正文区分 **Bounce Hard** / **Bounce Soft**，与现有 Hard/Soft 逻辑对齐

### 第三层：正文/结构（概率判断）

- **自动回复**：内容极短、无引用、OOO 关键词（out of office、automatic reply、away until、currently unavailable、I will return on）、模板化
- **人工回复**：有引用块（如 "On ... wrote:"）、上下文对话、针对性内容、签名；**STOP 类**在语义上属人工/半人工回复，但 **Classification 仍为 Unsubscribe**（不误判为 Auto Reply）
- **兜底**：Classification 写 **Other**

### 与 Inbound 状态对应

| 分类结果 | Inbound 状态（Notion Classification） |
|----------|--------------------------------------|
| 人工回复（非退订/非 STOP） | **Human Reply** |
| 自动回复（Header 或 OOO 等） | **Auto Reply** |
| 退订/STOP 强弱命中（业务止损） | **Unsubscribe**（止损照常写回 Touchpoint） |
| 硬退信 | **Bounce Hard**（止损照常写回 Touchpoint） |
| 软退信 | **Bounce Soft**（仅写 IM，不写 Touchpoint） |
| 无法确定 | **Other** |

---

## 涉及文件

- **`src/gmail-read.ts`**  
  - 在 `getMessageAndParse` 中读取并返回：`Auto-Submitted`、`Precedence`、`X-Auto-Response-Suppress`（仅记录，不参与 Auto 判断）、根及 parts 的 `mimeType`（用于 multipart/report）；From 已存在，可增加 `isMailerDaemonOrPostmaster` 等布尔或 flags（如 `has_x_auto_response_suppress`、`precedence_bulk_or_list`）。
- **`src/inbound-listener.ts`**  
  - 分层分类：第一层 Header（Auto-Submitted、Precedence: auto_reply、mailer-daemon/postmaster）→ 第二层 Bounce（multipart/report + 正文 Hard/Soft）→ 第三层 Unsubscribe（STOP 等）→ 第四层 Auto/Human/Other（OOO、引用结构等）。  
  - **止损与分类解耦**：无论分类结果如何，都执行 Unsubscribe 检测与 Bounce Hard 检测；命中则写 Touchpoint 止损。  
  - 调用 `createInboundMessageRow` / `updateInboundMessageClassification` 时传入扩展后的分类枚举。
- **`src/notion-inbound.ts`**  
  - `createInboundMessageRow` 的 `classification` 类型扩展为：`"Human Reply" | "Auto Reply" | "Unsubscribe" | "Bounce Hard" | "Bounce Soft" | "Other"`；  
  - `updateInboundMessageClassification` 支持上述全部分类值；Notion 表 Classification 需新增选项：Human Reply、Auto Reply、Bounce Soft。

---

## 风险与依赖

- **部署前请在 Notion 中配置**：📥 RE Inbound Messages 表的 **Classification** 列（Select 类型）需包含以下选项，否则写入会报错：**Human Reply**、**Auto Reply**、**Unsubscribe**、**Bounce Hard**、**Bounce Soft**、**Other**。若表中仅有 Other / Unsubscribe / Bounce Hard，请手动新增 Human Reply、Auto Reply、Bounce Soft。
- **Notion 📥 RE Inbound Messages 表**：同上；需在文档或部署说明中注明。
- **Touchpoint 止损**：Unsubscribe / Bounce Hard 写回逻辑不变；**Bounce Soft 不写回 Touchpoint**（已确认）。分类不阻断止损：即使已判 Auto Reply，仍做 Unsubscribe/Bounce Hard 检测并写回。
- **向后兼容**：兜底统一用 "Other"；若 Notion 表未新增选项，需在文档中说明需新增 Human Reply、Auto Reply、Bounce Soft。

---

## 验收要点

1. 使用 `format=full` 拉取的邮件能正确解析并利用 Auto-Submitted、Precedence、X-Auto-Response-Suppress、Content-Type。
2. mailer-daemon/postmaster 与 multipart/report 退信被识别，并区分为 Bounce Hard / Bounce Soft。
3. OOO 类自动回复被标为 Auto Reply；含 "On ... wrote:" 或明确 CTA 回复（如 STOP）标为 Human Reply。
4. Inbound 状态与 Notion Classification 一致：Human Reply、Auto Reply、Unsubscribe、Bounce Hard、Bounce Soft、Other。
5. 止损与分类解耦：无论分类为何都执行 Unsubscribe/Bounce Hard 检测；现有 Unsubscribe / Bounce Hard 的 Touchpoint 止损行为不变；Bounce Soft 不写 Touchpoint。
