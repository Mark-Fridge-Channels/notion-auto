# Plan 017：Inbound Listener 最小止损增强（Unsubscribe / Hard Bounce）

**Overall Progress:** `100%`

## TLDR

按 issue 017 规范增强最小止损：对 body 做归一化与引用块截断，实现 Unsubscribe 强/弱规则与 Hard Bounce 两步判定（候选 + Hard 特征、排除 soft），并扩展 Touchpoint 写回字段（Unsubscribe Flag、Bounce Flag、Bounce Type、Last Inbound At）；弱命中 Unsubscribe 时 IM 设 Needs Review。优先级保持 Unsubscribe > Bounce Hard。

## Critical Decisions

- **Body 归一化**：小写、合并空白、取「引用分隔符」之前为新内容片段（简单正则如 `On ... wrote:`），仅用该片段做 Unsubscribe/Hard Bounce 判定，降低误判。
- **Touchpoint 写回**：Unsubscribe Flag、Bounce Flag 表已存在（Queue 过滤用）；Bounce Type、Last Inbound At 采用「有则写、无则 catch 打日志」避免表未加列时整次更新失败。
- **弱命中 Unsubscribe**：Touchpoint 仍按 Unsubscribe 止损；IM 通过新增「更新 Needs Review」接口设为 true，便于人工复核。

## Tasks

- [x] 🟩 **Step 1：Body 归一化与引用块截断**
  - [x] 🟩 在 `inbound-listener.ts` 中新增 `normalizeBodyPlain(bodyPlain: string): string`：小写、`\s+` → 单空格、trim。
  - [x] 🟩 新增 `getNewContentBeforeQuote(bodyPlain: string): string`：用简单正则取「第一个引用分隔符」之前内容（如 `\n\s*On\s+.+wrote\s*:/i` 或 `\n-{3,}\s*Original Message` 等 1～2 种），无则返回全文；再对该结果做 normalizeBodyPlain，得到 `body_plain_normalized` 供后续检测使用。

- [x] 🟩 **Step 2：Unsubscribe 检测（强 + 弱）**
  - [x] 🟩 重写 `detectUnsubscribe`：入参改为 `bodyPlain: string`，内部先得到 `body_plain_normalized`（Step 1）。
  - [x] 🟩 **强命中**：新内容片段任一条即 true：整段匹配 `^\s*stop\s*$`；或包含英文关键词 `unsubscribe`, `remove me`, `do not contact`, `don't contact`, `stop emailing`, `stop sending`；或包含中文关键词（退订、取消订阅、不要再联系/跟进/发、别再发、停止发送、拉黑我）。
  - [x] 🟩 **弱命中**：不满足强命中时，若同时包含 `not interested`/`no longer interested` 与 `stop`/`don't`/`do not`/`remove` 则返回「弱命中」；否则未命中。函数返回类型改为 `false | "strong" | "weak"`（或等价结构），供主流程区分是否设置 IM Needs Review。

- [x] 🟩 **Step 3：Hard Bounce 检测（候选 + Hard 特征、排除 soft）**
  - [x] 🟩 重写 `detectHardBounce(from, subject, bodyPlain)`：先得到 `body_plain_normalized`（Step 1）。
  - [x] 🟩 **候选筛选**：任一满足才进入 Hard 判定——from 含 mailer-daemon/postmaster；subject 含 delivery status notification / undelivered mail / mail delivery failed / returned mail / failure notice；body 含 diagnostic-code / status: / final-recipient: / action: failed。
  - [x] 🟩 **Hard 判定**：在 body_plain_normalized 中命中 A（user unknown, no such user, unknown user, recipient address rejected, mailbox not found, address not found, invalid recipient, 550 5.1.1, 550 5.1.0, status: 5.1.1, status: 5.1.0）或 B（domain not found, host not found, nxdomain, unrouteable address）。
  - [x] 🟩 **排除 soft**：若 body 含 mailbox full、temporarily deferred、try again later、4.x.x、status: 4. 等则**不**判为 Hard，返回 false。

- [x] 🟩 **Step 4：扩展 Touchpoint 止损写回（notion-inbound）**
  - [x] 🟩 扩展 `updateTouchpointStop` 的 payload：保留 `stopReason`、`nextSendAtNull`；新增可选 `receivedAt?: Date`（用于 Last Inbound At）。
  - [x] 🟩 Unsubscribe 时写入：`Unsubscribe Flag = true`，现有 Stop Flag / Stop Reason / Email Status / Next Send At；若有 `receivedAt` 则写 `Last Inbound At`（写失败则 catch 打 warn，不抛）。
  - [x] 🟩 Bounce Hard 时写入：`Bounce Flag = true`，`Bounce Type = Hard`（select），现有 Stop Flag / Stop Reason / Email Status / Next Send At；若有 `receivedAt` 则写 `Last Inbound At`（同上，可选写 + 容错）。

- [x] 🟩 **Step 5：IM Needs Review 更新（弱命中 Unsubscribe）**
  - [x] 🟩 在 `notion-inbound.ts` 新增 `updateInboundMessageNeedsReview(notion, pageId, needsReview: boolean)`，只更新 IM 行的 `Needs Review` checkbox。
  - [x] 🟩 在 `inbound-listener.ts` 的 `processOneMessage` 中：当 `detectUnsubscribe` 返回 `"weak"` 时，在写回 Touchpoint 后调用 `updateInboundMessageNeedsReview(notion, imPageId, true)`。

- [x] 🟩 **Step 6：主流程接好新检测与写回**
  - [x] 🟩 `processOneMessage`：用 Step 1 得到 normalized body；先调用新 `detectUnsubscribe`，若为 strong 或 weak 则 `updateTouchpointStop(..., "Unsubscribe", nextSendAtNull: true, receivedAt: parsed.received_at)`，并写 IM Classification = Unsubscribe；若为 weak 再调 `updateInboundMessageNeedsReview(notion, imPageId, true)`。
  - [x] 🟩 若未命中 Unsubscribe，再调用新 `detectHardBounce`；命中则 `updateTouchpointStop(..., "Bounce Hard", nextSendAtNull: true, receivedAt: parsed.received_at)`，并写 IM Classification = Bounce Hard。
  - [x] 🟩 保持现有优先级与分支顺序（Unsubscribe > Bounce Hard > updateTouchpointOnReply），仅替换检测函数与传参。

- [x] 🟩 **Step 7：验证与文档**
  - [x] 🟩 验证：正文开头为 `STOP`（引用前）的入站应判 Unsubscribe 并写回 Touchpoints（Stopped + Unsubscribe）；可选用含 DSN 的退信样本验证 Hard Bounce。
  - [x] 🟩 在 README 或 issues/017 中注明：Touchpoints 表若需 Last Inbound At、Bounce Type，请在 Notion 中预先加列；未加时程序仅打日志不中断。
