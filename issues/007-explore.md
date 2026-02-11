# Issue 007 探索结论与待确认问题

## 1. 与现有实现的对接理解

### 1.1 数据流与作用点

- **配置来源**：主流程只用 `schedule.json` → `loadSchedule()` → `Schedule`（`src/schedule.ts`）。`src/config.ts`、`src/dashboard-params.ts` 的 interval/newChatEveryRuns/modelSwitchInterval 是旧/其他入口，本次不改。
- **intervalMs**：仅在 `src/index.ts` 第 151 行使用，每次「发送完成并 saveProgress 后」固定 `sleep(schedule.intervalMs)`。改为区间后，这里改为在 `[intervalMinMs, intervalMaxMs]` 内随机取一次再 sleep。
- **newChatEveryRuns / modelSwitchInterval**：在 `index.ts` 第 114、117 行使用，判断条件是「本行业累计 `runCount`」：`runCount > 0 && runCount % N === 0` 时先 new chat，再 `runCount % M === 0` 时换模型，然后才执行当次的 typeAndSend，最后 `runCount++`。即：**当前是按「行业总次数」计，不是按「当前会话内次数」**。

### 1.2 行为变更要点（N/M 改为区间 + 按会话计数）

- Issue 要求 **N、M 按「当前会话」计数**：每次**开新会话时**从区间随机得到本会话的 N、M，本会话内用「会话内已跑次数」判断是否该 new chat / 换模型；下次开新会话再重新随机 N、M。
- **哪些算「开新会话」**（需重置 sessionRuns 并重抽 currentN/currentM）：
  - 进入行业时点的 New AI chat（首次打开 Notion 后、或切换行业后）；
  - 按策略「每 currentN 次」主动点的 New AI chat。
  - **不算**：失败重试时的 `clickNewAIChat`、`reopenNotionAndNewChat` 触发的 New chat —— 不重置 sessionRuns，不重抽 N/M。
- 因此需要：
  - **会话内计数**（如 `sessionRuns`）：仅在上述「算开新会话」的 clickNewAIChat 时置 0，每次成功执行一轮后 +1。
  - **当前会话的 N、M**（如 `currentN`, `currentM`）：仅在上述「算开新会话」时从行业区间内随机赋值。
- 判断逻辑：每轮执行前，用 `sessionRuns` 与 `currentN`/`currentM` 比较。当 `currentN > 0 && sessionRuns > 0 && sessionRuns % currentN === 0` 时 new chat，并重置 sessionRuns、重新随机 currentN/currentM；当 `currentN === 0` 时本会话**不按次数主动新建会话**。当 `sessionRuns > 0 && currentM > 0 && sessionRuns % currentM === 0` 时换模型。`runCount` 保留为行业总次数，用于日志和 saveProgress。

### 1.3 涉及文件（与 issue 一致）

| 文件 | 变更要点 |
|------|----------|
| `src/schedule.ts` | Schedule 增加 intervalMinMs/intervalMaxMs；ScheduleIndustry 增加 newChatEveryRunsMin/Max、modelSwitchIntervalMin/Max；校验 min≤max、非负；mergeSchedule 与 getDefaultSchedule 默认值；**向后兼容**：若仅有旧单数字段则转为 min=max=该值 |
| `src/index.ts` | 引入 sessionRuns、currentN、currentM；仅在「进入/切换行业后的 New chat」与「按 currentN 主动 new chat」时重置 sessionRuns 并重抽 currentN/currentM（失败重试的 new chat 不重置不重抽）；判断用 sessionRuns 与 currentN/currentM，currentN===0 时不主动新建；sleep 用区间随机；行业切换时从新行业区间抽 N、M |
| `src/server.ts` | 全局：单输入改为「最小」「最大」两输入；行业弹窗：N、M 各两输入；fillGlobal、collectSchedule、openEditModal、saveEditModal 读写新区间字段；新建行业默认值（如 N 1~1，M 0~0） |

未在 issue 中列出但会受影响：`schedule.example.json`、`README.md`（若仍描述旧字段需同步更新）。

---

## 2. 依赖与约束

- **无新依赖**：随机数用 `Math.random()` 或 `crypto.getRandomValues` 即可，无需新包。
- **校验**：interval 区间两值均应为正数；行业 N、M 的区间允许 [0,0] 或 min≤max 非负整数；N 允许 [0, max]（随机到 0 表示本会话不主动新建）；M 随机到 0 表示本会话不换模型。
- **mergeSchedule**：在 `loadSchedule` 的解析路径中，必须在 validate 之前把「仅有旧单数字段」的情况规范成区间（min=max=原值），这样校验和运行时只看到一种形态。

---

## 3. 决策记录（已确认）

### 3.1 失败重试时的 New AI chat 是否算「开新会话」？

- **决策：不算。** 失败重试 / reopen 触发的 New AI chat **不**重置 sessionRuns、**不**重抽 currentN/currentM。仅「按 currentN 主动 new chat」和「进入/切换行业时的 new chat」算开新会话。

### 3.2 「每 N 次新会话」的区间是否允许随机到 0？

- **决策：支持随机到 0。** N 的区间允许 min=0 且 max≥0（如 [0, 5]）。随机到 **currentN === 0** 时，语义为「本会话内不主动新建会话」——本会话一直用当前聊天，直到失败触发的 new chat 或行业切换。实现时判断用 `currentN > 0 && sessionRuns % currentN === 0` 即可。

### 3.3 区间与单位

- 整数闭区间 [min, max]（含两端）；间隔用毫秒存、UI 用秒展示。行业切换时从**新行业**的区间重抽 currentN、currentM。

---

## 4. 小结

上述歧义已全部确认，无剩余待决问题。实现时按本文与 issue 007 的约定执行即可。
