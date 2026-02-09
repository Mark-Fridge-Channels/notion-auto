# Feature Implementation Plan: 模型切换集成 + Task 文案参数化

**Overall Progress:** `100%`

## TLDR

将测试脚本中的「发送左侧 → 打开模型弹窗 → 点下一项」集成到主流程，每 N 轮（`--model-switch-interval`，默认 50，N=0 不切换）执行一次；失败时重试 3 次，仍失败则打日志并继续运行不退出。同时将三条 Task 文案改为 CLI 参数 `--task1`、`--task2`、`--task3`。

## Critical Decisions

- **模型切换间隔**：`--model-switch-interval` 默认 50；N=0 表示不切换，无需单独开关。
- **切换失败**：最多重试 3 次，仍失败则 `logger.warn` 后继续主流程，不抛错、不退出。
- **文案参数**：`--task1`、`--task2`、`--task3` 对应三条文案，默认值为当前 prompts.ts 中的常量；传入 `getPromptForRun` 使用。

## Tasks

- [x] 🟩 **Step 1: Config 与 CLI 新增参数**
  - [x] 🟩 Config 增加 `modelSwitchInterval`（默认 50）、`promptTask1`、`promptTask2`、`promptTask3`（默认与当前 TASK_1/2/3 一致）。
  - [x] 🟩 parseArgs 解析 `--model-switch-interval`、`--task1`、`--task2`、`--task3`。
  - [x] 🟩 printHelp 补充上述选项及说明。

- [x] 🟩 **Step 2: prompts 支持传入三条文案**
  - [x] 🟩 `getPromptForRun(runIndex, task1, task2, task3)` 或接收包含三条文案的 options，内部按 1～5 / 6～10 / 11+ 规则使用传入字符串；保留/导出常量仅作默认值用途。

- [x] 🟩 **Step 3: 模型切换逻辑抽成独立函数**
  - [x] 🟩 从测试脚本提炼：定位发送按钮左侧（先 preceding-sibling，再父级 preceding-sibling）、点击打开弹窗、获取 `role="menuitem"` 列表、识别当前选中项（如勾选）、点击下一项 `(current+1)%n`。
  - [x] 🟩 封装为 `switchToNextModel(page)`，内部重试最多 3 次；失败则 log 并 return，不 throw。
  - [x] 🟩 可选：将「发送左侧」locator 逻辑放入 selectors.ts 或与 switchToNextModel 同文件。

- [x] 🟩 **Step 4: 主循环中接入切换与文案参数**
  - [x] 🟩 当 `modelSwitchInterval > 0 && totalDone > 0 && totalDone % modelSwitchInterval === 0` 时，在当轮 `typeAndSend` 前调用 `switchToNextModel(page)`。
  - [x] 🟩 调用 `getPromptForRun(runIndex, config.promptTask1, config.promptTask2, config.promptTask3)` 传入三条文案。

- [x] 🟩 **Step 5: README / 帮助**
  - [x] 🟩 README 与 --help 中说明 `--model-switch-interval`（0=不切换）、`--task1`/`--task2`/`--task3` 的用法与默认值。
