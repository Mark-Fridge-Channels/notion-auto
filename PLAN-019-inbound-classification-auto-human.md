# Feature Implementation Plan: 019 入站分类优化（Auto vs Human + 扩展状态）

**Overall Progress:** `100%`

## TLDR

在 Inbound Listener 中按 issue 019 实现分层分类（Header → Bounce → Unsubscribe → Auto/Human/Other），扩展 Notion Classification 为 Human Reply、Auto Reply、Unsubscribe、Bounce Hard、Bounce Soft、Other；止损与分类解耦，始终执行 Unsubscribe/Bounce Hard 检测并写回 Touchpoint，Bounce Soft 不写 Touchpoint。

## Critical Decisions

- **分类与止损解耦**：先算 classification，再独立跑止损（Unsubscribe / Bounce Hard）；最终 classification 由「若命中止损则取 Unsubscribe/Bounce Hard，否则取分层分类结果」决定；创建 IM 时一次性写入该最终 classification，无需事后 update。
- **Precedence**：仅 `auto_reply` 作第一层 Auto 强信号；`bulk`/`list` 只写入 flags 供分析，不参与判 Auto。
- **X-Auto-Response-Suppress**：不参与判断，仅记录为 `flags.has_x_auto_response_suppress`。
- **Bounce Soft**：不写 Touchpoint，只写 IM Classification；Bounce Soft 判定依赖「退信候选 + 正文 Soft 特征、且非 Hard」。
- **兜底**：统一用 Other；Notion 不新增 unknown。

## Tasks

- [x] 🟩 **Step 1: gmail-read — 扩展解析与 InboundMessageParsed**
  - [x] 🟩 在 `getMessageAndParse` 中读取 Header：`Auto-Submitted`、`Precedence`、`X-Auto-Response-Suppress`；计算并暴露布尔/标志：`isMailerDaemonOrPostmaster`、`hasMultipartReport`（根或任意 part 的 mimeType === `multipart/report`）、`flags.has_x_auto_response_suppress`、`flags.precedence_bulk_or_list`（Precedence 为 bulk 或 list）。
  - [x] 🟩 扩展 `InboundMessageParsed` 类型：增加上述字段；保持对现有调用方的兼容（from_email 等不变）。

- [x] 🟩 **Step 2: inbound-listener — 退信候选与 Bounce Soft**
  - [x] 🟩 新增 `isBounceCandidate(parsed)`：From 含 mailer-daemon/postmaster，或 subject/body 现有 BOUNCE_CANDIDATE_*，或 `parsed.has_multipart_report === true`。
  - [x] 🟩 新增 `detectBounceSoft(parsed)`：仅当 `isBounceCandidate` 为 true 时，在 body 中查 BOUNCE_SOFT 特征；若命中且非 Hard（不命中 detectHardBounce）则返回 true。Hard 优先于 Soft。

- [x] 🟩 **Step 3: inbound-listener — 分层分类函数**
  - [x] 🟩 新增 `classifyInboundMessage(parsed): ContentClassification`，**不输出 Unsubscribe**（Unsubscribe 仅由 processOneMessage 的止损分支在 detectUnsubscribe 命中时设置）。顺序：  
    1) Header 确定性 Auto：Auto-Submitted 为 auto-replied/auto-generated，或 Precedence 为 auto_reply → **Auto Reply**。  
    2) 退信分支：若 `isMailerDaemonOrPostmaster` 或 `hasMultipartReport` 或现有 bounce 候选 → 若 `detectHardBounce` → **Bounce Hard**；else if `detectBounceSoft` → **Bounce Soft**；else 退信候选兜底 **Bounce Hard**。  
    3) 正文辅助：OOO 关键词（out of office, automatic reply, away until, currently unavailable, I will return on）→ **Auto Reply**；引用结构（如 On ... wrote:）→ **Human Reply**；否则 **Other**。  
  - [x] 🟩 类型 `ContentClassification = "Human Reply" | "Auto Reply" | "Bounce Hard" | "Bounce Soft" | "Other"`；最终写入 Notion 的 `InboundClassification` 在此基础上加 `"Unsubscribe"`（仅止损分支设置）。

- [x] 🟩 **Step 4: inbound-listener — processOneMessage 重组**
  - [x] 🟩 先算 `initialClassification = classifyInboundMessage(parsed)`。
  - [x] 🟩 独立跑止损：`unsub = detectUnsubscribe(...)`；`hardBounce = detectHardBounce(...)`；`bounceSoft = detectBounceSoft(...)`。  
    - 若 unsub 强/弱 → 写 Touchpoint Stop（Unsubscribe）、`finalClassification = "Unsubscribe"`、needsReview 若弱则设。  
    - 否则若 hardBounce → 写 Touchpoint Stop（Bounce Hard）、`finalClassification = "Bounce Hard"`。  
    - 否则若 bounceSoft → `finalClassification = "Bounce Soft"`（不写 Touchpoint）。  
    - 否则 `finalClassification = initialClassification`；若 touchpointPageId 存在且未止损则 `updateTouchpointOnReply`。
  - [x] 🟩 创建 IM：`createInboundMessageRow(..., classification: finalClassification)`；不再在创建后根据止损结果调用 `updateInboundMessageClassification`（创建即用最终值）。
  - [x] 🟩 保持现有 needsReview、logger 等行为。

- [x] 🟩 **Step 5: notion-inbound — Classification 类型与 API**
  - [x] 🟩 `createInboundMessageRow` 的 `classification` 参数类型扩展为：`"Human Reply" | "Auto Reply" | "Unsubscribe" | "Bounce Hard" | "Bounce Soft" | "Other"`，默认 `"Other"`。
  - [x] 🟩 `updateInboundMessageClassification` 的 `classification` 参数类型扩展为上述全集（便于后续若有别处需要更新 IM 分类）；若当前仅 processOneMessage 不再调用 update，可保留函数签名扩展供将来用。

- [x] 🟩 **Step 6: 文档与 Notion 说明**
  - [x] 🟩 在 README 与 issues/019 中注明：Notion 📥 RE Inbound Messages 的 Classification 列需包含 **Human Reply**、**Auto Reply**、**Unsubscribe**、**Bounce Hard**、**Bounce Soft**、**Other**（若表中尚无则需新增 Human Reply、Auto Reply、Bounce Soft）。
