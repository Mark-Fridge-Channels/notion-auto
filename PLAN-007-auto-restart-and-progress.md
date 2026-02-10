# Feature Implementation Plan: 运行中异常退出自动恢复与进度持久化

**Overall Progress:** `100%`

## TLDR

脚本在「运行」状态下若因异常退出，由 Dashboard 自动重启并从 progress.json 恢复 totalDone/conversationRuns，不影响计数。正常跑满不重启。CLI 支持 `--resume` 从 progress 恢复。连续自动重启超过 5 次时发一封 SMTP 邮件告警（配置在 env），只发一封；计数仅在使用者再次点击「启动」时归零。

## Critical Decisions

- **progress.json**：项目目录下，含 totalDone、conversationRuns、completed；正常结束时写 completed，用于区分是否自动重启。
- **自动重启**：仅当 userWantsRunning 且 progress 未 completed 时执行；重启时传 env NOTION_AUTO_RESUME=1，脚本据此恢复。
- **连续 5 次告警**：连续自动重启 > 5 次发一封邮件（SMTP，配置在 env），发后不再发；consecutiveRestartCount 仅在使用者点击「启动」时归零。
- **正常完成判定**：Dashboard 在决定是否自动重启前读 progress.json，若 completed === true 则不重启。

## Tasks

- [x] 🟩 **Step 1: 脚本侧进度持久化与 --resume**
  - [x] 🟩 定义 progress.json 结构（totalDone, conversationRuns, completed?），路径为项目目录 progress.json；加入 .gitignore。
  - [x] 🟩 Config 增加 resume 来源：CLI `--resume` 与 env NOTION_AUTO_RESUME=1；若未指定则不恢复。
  - [x] 🟩 index.ts 启动时：若为 resume 且 progress 存在且未 completed，则从 progress 读 totalDone、conversationRuns 作为初始值；否则从 0 开始。
  - [x] 🟩 每轮 totalDone++ 后写 progress；正常结束（totalDone >= totalRuns）时写 completed: true 再退出。

- [x] 🟩 **Step 2: Dashboard 自动重启与连续计数**
  - [x] 🟩 runner 维护 userWantsRunning（Start=true, Stop=false）与 consecutiveRestartCount（仅 Start 时置 0）。
  - [x] 🟩 子进程 exit 时：若 !userWantsRunning 则不重启；若 progress.json 存在且 completed === true 则不重启；否则自动 spawn 同一 params，并设 env NOTION_AUTO_RESUME=1；consecutiveRestartCount++。
  - [x] 🟩 若 consecutiveRestartCount > 5 且本周期尚未发过告警邮件，则调用发信一次并标记已发，之后不再发直到用户再次 Start。

- [x] 🟩 **Step 3: SMTP 邮件告警**
  - [x] 🟩 新增发信模块（或内联）：从 env 读 SMTP 配置（如 host/port/user/pass/to），连续 >5 次时发一封简短告警（主题/正文说明 notion-auto 连续自动重启超过 5 次）。
  - [x] 🟩 发信失败只打日志，不阻塞 runner；env 未配置时跳过发信并打日志。

- [x] 🟩 **Step 4: CLI --resume 与文档**
  - [x] 🟩 parseArgs 解析 --resume（无参数），设置 config.resume；printHelp 与 README 说明 --resume 从 progress.json 恢复。
  - [x] 🟩 README 或 SCRIPT-LOGIC 补充：progress.json、自动恢复、连续 5 次邮件告警及 env 配置说明。
