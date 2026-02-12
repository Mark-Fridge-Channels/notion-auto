# 等待输出期间自动点击「Delete pages」按钮

**类型**: improvement  
**优先级**: normal  
**预估**: medium

---

## TL;DR

发送对话后、在等待 AI 输出结束（即等待发送按钮再次出现）这段时间内，页面可能会弹出「Delete pages」按钮。需要在这段等待期间持续检测该按钮，一旦出现就点击，且不改变现有「等发送按钮出现」的主流程。

---

## 当前 vs 期望

| 当前 | 期望 |
|------|------|
| 只轮询/等待「发送按钮」再次可见，不处理其它弹窗 | 在同样这段时间内，若出现「Delete pages」按钮则自动点击，然后继续等待发送按钮 |
| 「Delete pages」若一直不点可能阻塞或影响后续操作 | 出现即点掉，流程照常进行 |

---

## 涉及文件

- **`src/index.ts`**：在 `typeAndSend()` 中，发送后等待 `SEND_BUTTON` 的逻辑（约 306–309 行）；需在「等待输出结束」这段里加入对 Delete pages 的检测与点击，且不替换、不破坏现有等待逻辑。
- **`src/selectors.ts`**：新增「Delete pages」按钮选择器（或常量），便于维护与复用。

---

## 实现要点

- **按钮识别**：用户提供的目标元素为  
  `div[role="button"]`，且文案为 "Delete pages"，样式含 `background: var(--c-redBacAccPri)` 等。优先用稳定属性（如 `role="button"` + 文本 "Delete pages"，或若有 `data-testid`/`aria-label` 则用其一）。
- **时机**：仅在「发送后、等待输出结束」这一段时间内做检测（即与 `waitFor(SEND_BUTTON..., timeout: WAIT_SUBMIT_READY_MS)` 同一时间窗口）。
- **不改变主流程**：仍以「发送按钮再次可见」作为等待结束条件；Delete pages 的检测/点击作为在此期间的后台或轮询逻辑，点击后不重置主等待、不延长总超时。
- **实现方式建议**：在等待发送按钮的循环/轮询中，每次轮询时先检查 Delete pages 是否可见，可见则点击并继续等待；或使用短间隔 setInterval/轮询在旁路只做「发现即点」，与现有 `waitFor` 并行（需注意不要与 Playwright 的 waitFor 冲突，避免重复点击或竞态）。

---

## 风险与备注

- **选择器稳定性**：若 Notion 仅用样式类/文案，可能随前端改版变化，后续可关注是否有 `data-testid` 或 `aria-label` 可用来加固选择器。
- **点击频率**：若用轮询，间隔不宜过密（如 1–2 秒一次即可），避免无谓的 DOM 查询。
- **一次还是多次**：同一轮等待期间，理论上可能多次出现 Delete pages（若 Notion 行为如此），逻辑上应支持「出现就点、点完继续等」直到发送按钮出现或超时。
