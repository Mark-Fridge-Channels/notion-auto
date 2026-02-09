# Feature Implementation Plan: 三条文案 + 全局计数 + 第 11 轮起随机

**Overall Progress:** `100%`

## TLDR

将文案从 2 条改为 3 条，按全局轮数选择：第 1～5 轮 Task 1，第 6～10 轮 Task 2，第 11 轮起在三条中随机；选文案只看 totalDone，与 New AI chat 无关。

## Critical Decisions

- **文案来源**：三条文案在代码中写死，不通过 CLI 传入，以简化并满足固定需求。
- **选文案依据**：使用「即将执行的是第几轮」= `totalDone + 1` 判断阶段（≤5 / 6～10 / ≥11），不依赖 conversationRuns。
- **随机实现**：第 11 轮起用 `Math.random()` 或 `crypto.randomInt(3)` 在三句间均匀随机，无种子要求。

## Tasks

- [x] 🟩 **Step 1: 文案常量与 config 调整**
  - [x] 🟩 在合适位置（如 `selectors.ts` 旁新增 `prompts.ts`，或直接写在 `index.ts`）定义三条文案常量。
  - [x] 🟩 从 `config.ts` 移除 `promptFirst3`、`promptRest` 及默认值；从 `Config` 类型中删除这两项。
  - [x] 🟩 从 `parseArgs` 和 `printHelp` 中移除 `--prompt-first`、`--prompt-rest` 的解析与说明。

- [x] 🟩 **Step 2: 主循环按全局轮数选文案**
  - [x] 🟩 在主循环内，根据 `totalDone + 1` 判断：≤5 用 Task 1，6～10 用 Task 2，≥11 从三条中随机选一条。
  - [x] 🟩 保留 `conversationRuns` 与「满 10 点 New AI chat 并置 0」逻辑，不再用 conversationRuns 参与选文案。
  - [x] 🟩 将当前「promptFirst3 / promptRest」的调用改为上述新逻辑得到的 `prompt`。

- [x] 🟩 **Step 3: 文档与帮助**
  - [x] 🟩 更新 `README.md` 中与文案/参数相关的描述，说明新行为（三条、按轮数、随机）。
  - [x] 🟩 确保 `--help` 中已无 `--prompt-first` / `--prompt-rest`，必要时补充一句「文案按轮数固定/随机，不可配置」。
