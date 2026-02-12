# Feature Implementation Plan：等待输出期间可配置自动点击按钮（Issue 009）

**Overall Progress:** `100%`

## TLDR

在「发送对话后、等待 AI 输出结束」这段时间内，按用户配置的按钮名称列表（仅 name，role 固定为 button）顺序检测；若某按钮出现则自动点击，不改变总超时与「等发送按钮再次出现」的主流程。配置为 Schedule 顶层 `autoClickDuringOutputWait?: string[]`，示例：`["Delete pages"]`。

## Critical Decisions

- **配置形态**：`autoClickDuringOutputWait?: string[]`，只填按钮 name，role 在代码内固定为 `"button"`。
- **name 匹配**：精确匹配，用 `getByRole('button', { name: /^...$/ })`（对 name 做正则转义）。
- **等待实现**：用轮询替代单次 waitFor：在总超时内按固定间隔（如 1–2s）先查发送按钮可见则结束，再按顺序查配置按钮可见则点击，不重置总超时；点击失败仅打日志继续。
- **不扩大范围**：Dashboard UI 编辑与提示文案可后补，本次计划仅保证 JSON 配置 + 运行逻辑。

## Tasks

- [x] 🟩 **Step 1: Schedule 增加字段与校验**
  - [x] 🟩 在 `Schedule` 接口中增加 `autoClickDuringOutputWait?: string[]`。
  - [x] 🟩 `getDefaultSchedule()` 中不设该字段或设为 `undefined`（行为等同不点击）。
  - [x] 🟩 `mergeSchedule` 中合并该字段：若为数组则过滤并保留非空字符串项，否则为 `undefined`。
  - [x] 🟩 `validateSchedule` 中若存在该字段则校验为字符串数组且每项为非空字符串，否则抛错。

- [x] 🟩 **Step 2: 实现「带自动点击的等待」逻辑**
  - [x] 🟩 在 `index.ts` 中新增辅助：对 name 做正则转义（避免 `[ ] ( )` 等破坏正则），例如 `escapeRegex(s: string): string`。
  - [x] 🟩 新增函数 `waitForSendButtonWithAutoClick(page, buttonNames: string[], timeoutMs)`：在 `timeoutMs` 内循环（每轮间隔建议 1–2s），每轮先判断 `SEND_BUTTON` 可见则 resolve；否则按 `buttonNames` 顺序用 `getByRole('button', { name: new RegExp('^' + escapeRegex(name) + '$') }).first()` 检测，可见则 `click()`（catch 打日志），然后继续下一轮；超时则 reject（与现有 `WaitAfterSendTimeoutError` 一致）。
  - [x] 🟩 不改变 `WAIT_SUBMIT_READY_MS` 总超时，不因点击而重置计时。

- [x] 🟩 **Step 3: 接入 typeAndSend 与调用链**
  - [x] 🟩 `typeAndSend(page, text, buttonNames: string[])`：在 `send.click()` 后改为调用 `waitForSendButtonWithAutoClick(page, buttonNames ?? [], WAIT_SUBMIT_READY_MS)`，无配置时传 `[]` 行为与现有一致。
  - [x] 🟩 `tryTypeAndSend(page, prompt, max, buttonNames: string[])`：增加参数 `buttonNames`，调用 `typeAndSend(page, prompt, buttonNames)`。
  - [x] 🟩 三处调用 `tryTypeAndSend` 处传入 `schedule.autoClickDuringOutputWait ?? []`。

- [x] 🟩 **Step 4: 可选 — Dashboard UI**
  - [x] 🟩 已实现：全局设置卡片中增加「等待输出期间自动点击的按钮」列表（添加/删除行）、fillGlobal 渲染、collectSchedule 收集，并带提示「将按列表顺序依次检测并点击出现的按钮」。
