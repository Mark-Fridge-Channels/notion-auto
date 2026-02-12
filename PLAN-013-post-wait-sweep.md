# Feature Implementation Plan：事后清扫（Post-Wait Sweep）

**Overall Progress:** `100%`

## TLDR

在「等待输出结束」成功返回后，再执行一段 **5 秒** 的事后清扫：只检测并点击配置的按钮（如 Delete pages），覆盖「对话已结束、按钮稍后才弹出」的情况。参数写死，不暴露配置。

## Critical Decisions

- **方案**：方案 A —— 等待结束后单独跑 `sweepAutoClickButtons`，与 `waitForSendButtonWithAutoClick` 职责分离。
- **时长与间隔**：写死 `durationMs = 5000`、`intervalMs = 1000`（5 秒内约 5 轮清扫）。
- **不抛错**：清扫阶段点击失败只打日志，不抛错、不延长主超时。

## Tasks

- [x] 🟩 **Step 1: 新增 sweepAutoClickButtons 与常量**
  - [x] 🟩 在 `index.ts` 中新增常量 `SWEEP_DURATION_MS = 5000`、`SWEEP_INTERVAL_MS = 1000`。
  - [x] 🟩 新增函数 `sweepAutoClickButtons(page, buttonNames: string[])`：在 `SWEEP_DURATION_MS` 内按 `SWEEP_INTERVAL_MS` 轮询，每轮按配置顺序用 `getByRole('button', { name: /^...$/ })` 检测，可见则点击（catch 打日志）；不查发送按钮、不抛错。

- [x] 🟩 **Step 2: typeAndSend 中接入事后清扫**
  - [x] 🟩 在 `await waitForSendButtonWithAutoClick(...)` 成功后，若 `buttonNames.length > 0`，再 `await sweepAutoClickButtons(page, buttonNames)`，然后结束。
