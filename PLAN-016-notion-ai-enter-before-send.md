# Feature Implementation Plan: Notion AI 输入后先按 Enter 再发送

**Overall Progress:** `100%`

## TLDR
在统一发送入口 `typeAndSend()` 中，将发送前动作调整为：输入完成后先按一次 `Enter`（触发 Notion 的候选/文件选中机制），再点击发送按钮，避免“未选中就发送”的不稳定情况。

## Critical Decisions
- **只按一次 Enter**：依据已确认的行为（第一次 Enter 选中、第二次才发送），本次仅按一次 Enter，避免脚本误触发“额外发送”。
- **不检测 UI 状态**：按约束不引入候选项/选中态的 DOM 检测，仅做顺序调整与等待（输入后等待 1s，再按 Enter）。
- **入口唯一性**：当前代码库中“输入 + 发送”汇聚在 `src/index.ts` 的 `typeAndSend()`，修改此处覆盖全部发送路径。

## Tasks:

- [x] 🟩 **Step 1: 调整发送顺序（type -> Enter -> click send）**
  - [x] 🟩 在 `src/index.ts` 的 `typeAndSend()` 中，`keyboard.type(text)` 后插入 `keyboard.press("Enter")`
  - [x] 🟩 保留原有发送按钮等待与点击逻辑

- [ ] 🟥 **Step 2: 自检与回归**
  - [x] 🟩 TypeScript 语法/类型自检（确保无编译错误）
  - [x] 🟩 最小手工回归：验证单条任务不双发，且需要 Enter 选中的场景更稳定

---

## 最小回归建议（手工）
1. 选一个你已知“需要先 Enter 选中候选/文件”的输入样例。
2. 跑一次 `npm run run`，观察该条任务：
   - 发送前会按一次 Enter（用于选中）
   - 仅发送一次（无双发）
3. 连续重复 3 次，确认稳定性。

