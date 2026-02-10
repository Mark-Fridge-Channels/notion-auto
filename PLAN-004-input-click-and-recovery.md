# Feature Implementation Plan: 输入框鼠标坐标点击 + 失败恢复（New AI chat → 刷新 Notion 并重试）

**Overall Progress:** `100%`

## TLDR

1. 编辑输入内容前用**鼠标坐标点击**输入框（取输入框中心，`page.mouse.click(x, y)`），再全选与输入。  
2. 主循环中「输入+发送」连续失败 3 次时不退出：先点 **New AI chat**，再对同一轮重试最多 3 次；若仍失败则**刷新页面 → 点击 AI 头像 → 点击 New AI chat → 再试 3 次**；若再次失败则重复「刷新 → AI 头像 → New AI chat → 再试 3 次」，直到成功或可设上限避免死循环。  
3. 「重新打开 Notion」= 刷新当前页，再点击 AI_FACE_IMG 打开 AI 面板，再点击 NEW_CHAT_BUTTON 开新会话，然后继续执行当轮的 typeAndSend。

## Critical Decisions

- **输入框点击**：用 `locator.boundingBox()` 取输入框中心，再 `page.mouse.click(center.x, center.y)`，替代原有 `input.click()`，再执行全选与输入。
- **恢复层级**：第一层 = 点 New AI chat 后重试 3 次；第二层 = 刷新页面 + 点 AI 头像 + 点 New AI chat 后重试 3 次；若仍失败则重复第二层（刷新 → AI 头像 → New AI chat → 再试 3 次），不因单轮失败而退出进程。
- **重复「重新打开 Notion」**：若「刷新 + AI 头像 + New AI chat」后仍 3 次失败，则再次执行同一流程（刷新 → AI 头像 → New AI chat → 再试 3 次）；实现时可设单轮最大「重新打开」次数（如 3～5 次）避免无限循环，超出后本轮跳过或计为失败并进入下一轮，由实现时选定。

## Tasks

- [x] 🟩 **Step 1: typeAndSend 改为鼠标坐标点击输入框**
  - [x] 🟩 定位输入框后取 `boundingBox()`，计算中心点，调用 `page.mouse.click(center.x, center.y)`。
  - [x] 🟩 点击后保留短暂 delay（如 100～200ms），再执行全选与输入、点击发送。

- [x] 🟩 **Step 2: 抽「重新打开 Notion」流程**
  - [x] 🟩 封装函数：`reopenNotionAndNewChat(page, config)`：`page.reload()`（或 `goto(NOTION_URL)`）→ 等待稳定 → 点击 AI_FACE_IMG 父级打开 AI 面板 → 等待弹窗 → 点击 NEW_CHAT_BUTTON → 等待；内部可复用现有选择器与 `MODAL_WAIT_MS`，失败可抛错供上层重试。

- [x] 🟩 **Step 3: 主循环单轮「输入+发送」带恢复**
  - [x] 🟩 将当前「runWithRetry(3, () => typeAndSend(...))」改为内层「尝试最多 3 次 typeAndSend」；若 3 次均失败则点 New AI chat（调用现有 clickNewAIChat），再对同一轮再试最多 3 次 typeAndSend。
  - [x] 🟩 若仍 3 次失败则调用 `reopenNotionAndNewChat`，再对同一轮再试最多 3 次 typeAndSend；若仍失败则循环：再次 `reopenNotionAndNewChat` → 再试 3 次，直到成功或达到单轮「重新打开」上限（如 3 次）；达上限后本轮跳过（totalDone 是否 +1 与现有策略一致，建议 +1 避免死循环）并继续下一轮。
  - [x] 🟩 全程不向 main 抛错，单轮内仅 log 与恢复，主流程不退出。

- [x] 🟩 **Step 4: 文档与注释**
  - [x] 🟩 README 或代码注释中简述：输入前鼠标点击、失败先 New AI chat 再刷新 Notion 并重复的恢复策略及「重新打开」上限（若已实现）。
