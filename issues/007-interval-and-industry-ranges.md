# 将「对话结束检查间隔」「每 N 次新会话」「每 M 次换模型」改为区间配置

**类型**: improvement  
**优先级**: normal  
**预估**: medium

---

## TL;DR

把当前三个单值配置改成「最小～最大」区间，并在运行时从区间内随机取值使用，使行为更随机、可调，避免固定节奏被识别。

---

## 当前 vs 期望

| 配置项 | 当前 | 期望 |
|--------|------|------|
| 每隔多少秒 check 一次是否对话结束 | 全局单值 `intervalMs`，每次发送后固定 sleep 该值 | 全局区间 `intervalMinMs`～`intervalMaxMs`，**每次发送完成后**在区间内随机取一个毫秒数再 sleep，保证在区间内 |
| 每 N 次新会话 | 行业单值 `newChatEveryRuns`，每跑满 N 次就新建会话 | 行业区间 `newChatEveryRunsMin`～`newChatEveryRunsMax`，**每次跑任务链时**从区间随机取 N；**每次开新会话时**再重新从区间随机取一个新的 N 使用 |
| 每 M 次换模型 (0=不换) | 行业单值 `modelSwitchInterval`，每跑满 M 次换模型 | 行业区间 `modelSwitchIntervalMin`～`modelSwitchIntervalMax`，**每次开新会话时**从区间随机取 M（0 表示不换，可用 [0,0] 表示）；下次新会话再重新随机取 M |

---

## 行为细节

- **对话结束检查间隔**：全局配置，例如 30～120 秒；每次发送完后从区间随机取一个数（秒或毫秒），再等待，不固定。
- **每 N 次新会话**：例如 3～10；开一个新会话时随机得到 N（如 5），本会话内跑满 5 次后再开新会话，再随机得到新的 N（如 7），依此类推。
- **每 M 次换模型**：每次开新会话时随机得到 M；本会话内按该 M 决定何时换模型；下次新会话再随机一次 M。区间为 [0,0] 或 min=max=0 表示不换模型。

---

## 需修改的文件

- `src/schedule.ts` — 类型定义（Schedule、ScheduleIndustry）、校验、默认值、merge；区间校验（min ≤ max，且均为非负整数）
- `src/index.ts` — 发送后 sleep 用随机区间；新会话/换模型逻辑改为「本会话内」的 N/M 从区间随机，并在每次新会话时重新随机
- `src/server.ts` — 全局设置：单输入改为「最小」「最大」两个输入；行业弹窗：每 N 次新会话、每 M 次换模型各改为两个输入；collectSchedule / fillGlobal / openEditModal / saveEditModal 读写新区间字段
- `schedule.json` — 若需示例或迁移，可保留对旧单数字段的兼容（读取时转为区间 min=max=原值）

---

## 风险与备注

- **向后兼容**：现有 `schedule.json` 和 API 传参为单值；建议读取时若只有单值则视为 min=max=该值，写入时统一用区间字段，避免旧配置失效。
- **0=不换模型**：区间为 `[0, 0]` 或 min=max=0 表示不换；若 min=0、max>0 则可能随机到 0（本次会话不换），需在逻辑里明确「随机到 0 视为本会话不换」。
- 随机数：使用 `Math.random()` 或 `crypto.getRandomValues` 在 `[min, max]` 闭区间取整数即可（注意 max 是否包含：若配置为 3～10，通常包含 10）。
