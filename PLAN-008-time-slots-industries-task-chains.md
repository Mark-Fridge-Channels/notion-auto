# Feature Implementation Plan: 时间区间切换行业 + 行业任务链

**Overall Progress:** `100%`

## TLDR

按时间区间（左闭右开、本地时区）选择当前行业，每个行业有独立 Notion URL 与任务链；任务仅「输入内容 + 执行次数」，新会话/换模型为行业级「每 N/M 次」。7×24 无限跑直到用户停止；同一区间内任务链跑完立刻循环；恢复按当前时间对应行业从任务 1 开始。仅保留此一种模式，配置替代现有扁平 params。

## Critical Decisions

- **时间区间**：左闭右开、系统本地时区；未配置时段不跑（等待至落入某区间）；时间区间列表为空则报错退出。
- **行业级 N/M**：每跑 N 次后新会话、每跑 M 次后换模型（M=0 不换模型）；「次数」为任务链每次执行的累计；首轮 runCount=0 不触发。
- **结束与恢复**：无 totalRuns，仅用户停止退出；恢复不存任务进度，按当前时间重算行业并从任务 1 开始；progress 仅保留 `completed: false` 等以配合 Dashboard 自动重启。
- **配置形态**：单文件（如 schedule.json）承载时间区间、行业列表、每行业 URL/任务链/N/M；全局 intervalMs、loginWaitMs、maxRetries 等仍为顶层或同文件。
- **入口**：脚本通过 `--config` 或默认路径读 schedule 配置；Dashboard 启动子进程时传配置路径或由脚本读固定路径，不再拼扁平 argv。

## Tasks

- [x] 🟩 **Step 1: 配置结构与加载**
  - [x] 🟩 定义 Schedule 类型：时间区间列表（startHour/endHour 或等价，左闭右开）、行业列表（id、notionUrl、newChatEveryRuns、modelSwitchInterval、tasks[]）；任务类型为 { content, runCount }。顶层含 intervalMs、loginWaitMs、maxRetries 等。
  - [x] 🟩 实现从 JSON 文件加载与校验：至少一个时间区间、每区间绑定有效行业、每行业至少一个任务、URL 非空；N≥1 或约定 N=0 不新会话，M≥0。
  - [x] 🟩 提供默认或示例 schedule 配置（便于首跑与迁移）。

- [x] 🟩 **Step 2: 时间区间解析**
  - [x] 🟩 实现「当前时间 → 当前行业」：用本地时间、左闭右开判断所在区间，返回对应行业或 null（未落入任何区间）。
  - [x] 🟩 实现「等待直至落入某区间」：若当前无区间则 sleep 到下一整点（或固定间隔）再解析，直到有区间或配置错误；时间区间列表为空时直接报错退出。

- [x] 🟩 **Step 3: 主循环重写（index.ts）**
  - [x] 🟩 启动时先解析配置；若当前时间无区间则进入等待循环，有区间后再启动浏览器并 goto(行业 URL)；首次做一次 loginWait。
  - [x] 🟩 主循环：无 totalRuns，改为「永远跑」；每轮任务链开始前根据当前时间解析当前行业，若与当前运行行业不一致则切换（goto 新 URL、换任务链与 N/M、重置累计执行次数），从该行业任务 1 开始。
  - [x] 🟩 任务链执行：顺序执行每个任务，每任务按 runCount 次 typeAndSend；每次执行前若 runCount>0 且 runCount%N===0 则 New chat，若 runCount>0 且 runCount%M===0 则 switch model，再 typeAndSend，runCount++，interval 等待。任务链跑完后立刻从任务 1 再跑（同区间内循环）。
  - [x] 🟩 openNotionAI / 所有 goto 使用当前行业 notionUrl，不再使用单一 config.notionUrl。
  - [x] 🟩 保留现有单轮重试与恢复重启逻辑（tryTypeAndSend、reopenNotionAndNewChat、EXIT_RECOVERY_RESTART）。

- [x] 🟩 **Step 4: 进度与恢复**
  - [x] 🟩 新模式下 progress 仅用于「运行中」标记以支持 Dashboard 自动重启（如 `completed: false`）；不持久化 totalDone/conversationRuns 或任务进度。Resume 时按当前时间解析行业并从任务 1 开始。
  - [x] 🟩 确保 Dashboard 的 maybeAutoRestart 在新配置启动方式下仍有效（子进程读 schedule 路径或通过 env 传入）。

- [x] 🟩 **Step 5: Dashboard API 与配置读写**
  - [x] 🟩 新增或扩展 API：GET/POST schedule 配置（读/写 schedule.json 或约定路径）；保留 GET 运行状态、POST 停止、POST 启动。启动时传入当前配置路径或由子进程读固定路径。
  - [x] 🟩 子进程启动方式改为：`tsx src/index.ts --config <path>` 或从固定路径读配置，不再使用 paramsToArgv(扁平 params)；Dashboard 保存时写 schedule 文件。

- [x] 🟩 **Step 6: Dashboard 前端（布局与分块）**
  - [x] 🟩 保留 Header（状态、启动、停止、保存）与底部「最近运行日志」全宽卡。
  - [x] 🟩 中间配置区：一卡「全局设置」（每轮间隔秒、登录等待秒、最大重试）；一卡「时间区间」（区间列表 + 绑定行业，增删改）；一卡「行业与任务链」（行业列表 + 选中行业的 URL、N/M、任务链增删改与输入内容/执行次数）。与现有 .card / .layout 风格一致。
  - [x] 🟩 表单与 schedule 结构绑定，保存时校验并写入 schedule 文件，启动时用当前配置。

- [x] 🟩 **Step 7: CLI 与入口**
  - [x] 🟩 CLI 支持 `--config <path>`（默认如 `schedule.json`），移除或废弃扁平参数（total、notion-url、task1/2/3 等），由 schedule 文件提供全部运行配置。
  - [x] 🟩 README 或帮助中说明新配置方式与示例 schedule 结构。
