# 文案改为 3 条 + 全局计数 + 第 11 轮起随机

**类型**: feature  
**优先级**: normal  
**预估工时**: medium  

---

## TL;DR

- 文案从 2 条改为 3 条，按**全局轮数**选择：第 1～5 轮固定 Task 1，第 6～10 轮固定 Task 2，第 11 轮起在 3 条文案中**随机**选一条。
- 不再按「每次会话」区分前几条；点击 New AI chat 不重置文案计数，整次脚本运行内统一按总轮数算。

---

## 当前状态 vs 期望结果

| 当前 | 期望 |
|------|------|
| 两条文案：每个对话内前 3 次用 promptFirst3，第 4～10 次用 promptRest | 三条文案：全局第 1～5 次用 Task 1，第 6～10 次用 Task 2，第 11 次起在 Task 1 / 2 / 3 中随机 |
| 点击 New AI chat 后重置「对话内次数」，新对话内 again 前 3 用 A、后 7 用 B | 点击 New AI chat 只重置「本对话轮数」（用于满 10 点 New chat），**不**重置文案阶段；文案只看全局 totalDone |

---

## 需求细节

### 1. 三条文案与阶段

- **第 1～5 轮**（totalDone 1～5）：固定 `"@Task 1 — Add new DTC companies"`
- **第 6～10 轮**（totalDone 6～10）：固定 `"@Task 2 — Find high-priority contacts"`
- **第 11 轮起**（totalDone ≥ 11）：每次在以下三条中**随机**选一条：
  - `"@Task 1 — Add new DTC companies"`
  - `"@Task 3 — Find people contact (LinkedIn / Email / X)"`
  - `"@Task 2 — Find high-priority contacts"`

### 2. 计数逻辑

- **总轮数** `totalDone`：不变，仍为「输入+发送」次数，达到 `config.totalRuns` 退出。
- **对话内轮数** `conversationRuns`：仅用于「满 10 点 New AI chat」并置 0，**不**参与选文案。
- 选文案时只看 **totalDone**（或等价于「当前是第几轮」的全局计数），与是否点过 New AI chat 无关。

---

## 涉及文件

- `src/config.ts` — 移除/替换 `promptFirst3`、`promptRest`；可改为三条文案配置或固定写死三条；若需 CLI 可只暴露总轮数等，文案按需求写死。
- `src/index.ts` — 主循环里：根据 `totalDone` 选择阶段（1～5 / 6～10 / 11+），第 11 轮起从三条中随机取一条；保留 `conversationRuns` 仅用于 New AI chat 逻辑。

---

## 风险与注意

- **随机**：用 `Math.random()` 或 `crypto.randomInt` 在三者中选一即可；若需可复现可后续加种子，当前未要求。
- **兼容旧参数**：现有 `--prompt-first` / `--prompt-rest` 将废弃或改为其他用途，需在帮助/README 中说明新行为。

---

## 验收要点

- [ ] 第 1～5 轮发送的文案为 `"@Task 1 — Add new DTC companies"`
- [ ] 第 6～10 轮发送的文案为 `"@Task 2 — Find high-priority contacts"`
- [ ] 第 11 轮起每次发送的文案为上述三条之一且随机
- [ ] 点击 New AI chat 后，下一轮仍按全局 totalDone 选文案（例如第 11 轮仍是随机，不会回到 Task 1）
