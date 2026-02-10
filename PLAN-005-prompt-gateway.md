# Feature Implementation Plan: --prompt-gateway 参数

**Overall Progress:** `100%`

## TLDR

新增 CLI 参数 `--prompt-gateway <text>`。传值时：所有轮均使用该文案，不再使用 task1/task2/task3，也不按 runIndex 做 1～5 / 6～10 / 11+ 的规则判断。若传入空字符串则程序直接报错提示为必填项，不做回退到 task1/2/3。不传时行为与当前完全一致。

## Critical Decisions

- **空字符串**：`--prompt-gateway ""` 非法；解析后若值为空，直接报错（例如「--prompt-gateway 为必填项」），不回退到 task1/2/3。
- **默认行为**：不传 `--prompt-gateway` 时，保持现有逻辑（仅用 task1/2/3 + getPromptForRun）。
- **帮助与文档**：`--help` 与 README 中增加 `--prompt-gateway` 说明，提示为「使用 Prompt 网关内容」；并在 PLAN 或 README 中记录本能力。

## Tasks

- [x] 🟩 **Step 1: Config 新增 promptGateway 与解析**
  - [x] 🟩 在 `Config` 中增加 `promptGateway: string | null`（或可选字段），默认 `null`。
  - [x] 🟩 在 `parseArgs` 中解析 `--prompt-gateway`，用 `next()` 取下一参数为值；若取到空字符串（或仅空白），抛出明确错误（如「--prompt-gateway 为必填项，不能为空」），不设默认、不回退 task1/2/3。
  - [x] 🟩 有值时写入 `config.promptGateway`，无 `--prompt-gateway` 时保持 `null`。

- [x] 🟩 **Step 2: 主循环按 promptGateway 分支取文案**
  - [x] 🟩 在 `index.ts` 中，取 prompt 处：若 `config.promptGateway != null`（或已定义），则 `prompt = config.promptGateway`；否则 `prompt = getPromptForRun(runIndex, config.promptTask1, config.promptTask2, config.promptTask3)`。
  - [x] 🟩 不修改 `prompts.ts` 的 `getPromptForRun` 签名或逻辑（由调用方分支即可）。

- [x] 🟩 **Step 3: --help 与 README 文档**
  - [x] 🟩 在 `printHelp()` 中增加一行：`--prompt-gateway <text>`，说明为「使用 Prompt 网关内容，每轮均使用该文案，忽略 --task1/2/3」或类似表述。
  - [x] 🟩 在 README「参数说明」表中增加 `--prompt-gateway` 行；在「运行命令」或「行为简述」中简要说明：使用 `--prompt-gateway` 时每轮均使用网关内容，不再按 task1/2/3 与轮数选择。

- [x] 🟩 **Step 4: PLAN 文档记录**
  - [x] 🟩 在本 PLAN（PLAN-005-prompt-gateway.md）与 README 中已保留「支持 --prompt-gateway，使用后忽略 task1/2/3 与 runIndex 规则；空字符串报错」的说明，便于后续查阅。
