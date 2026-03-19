# Feature Implementation Plan: Conductor 队列空时自动触发

**Overall Progress:** `100%`

## TLDR
在 Notion 队列模式下，当队列持续 N 分钟（默认 30）无待执行任务时，自动执行一次 Conductor（打开配置的 Notion 页面并发送配置的内容），以生成新任务；执行后固定等待 5 分钟再抓队列。Dashboard 可配置 Conductor 链接、发送内容、空队列触发阈值。

## Critical Decisions
- **Conductor 配置挂载在 `NotionQueueConfig`**：与队列共用同一配置块，仅在「Notion 任务队列」卡片展示；未配置 URL+内容时不启用 Conductor，行为与现有一致。
- **5 分钟为代码常量**：Conductor 执行后等待时间不暴露为配置项。
- **空队列起始时间在循环内维护**：每次进入队列模式或取到任务时重置；仅当 `fetchOneQueuedTask()` 连续返回 null 且持续时间 ≥ 阈值时才触发 Conductor。

## Tasks

- [x] 🟩 **Step 1: Schedule 配置与校验**
  - [x] 🟩 在 `NotionQueueConfig`（`src/schedule.ts`）增加可选字段：`conductorPageUrl?: string`、`conductorPrompt?: string`、`conductorEmptyQueueMinutes?: number`（默认 30）。
  - [x] 🟩 在 `validateNotionQueue` 中：若存在任一 Conductor 字段则 `conductorPageUrl` 与 `conductorPrompt` 必填且非空；`conductorEmptyQueueMinutes` 若存在则 ≥ 0。
  - [x] 🟩 在 `mergeSchedule`/默认值中保证 `conductorEmptyQueueMinutes` 默认 30（当用户只填了 URL+内容时）。

- [x] 🟩 **Step 2: Dashboard UI 与绑定**
  - [x] 🟩 在「Notion 任务队列」卡片（`src/server.ts`）增加：Conductor 页面 URL（input url）、Conductor 发送内容（textarea 或 input）、空队列多少分钟后触发（number，placeholder 30）。
  - [x] 🟩 从 schedule 加载时：将 `notionQueue.conductorPageUrl`、`conductorPrompt`、`conductorEmptyQueueMinutes` 回填到上述控件；无则空串/默认 30。
  - [x] 🟩 `collectSchedule` 中构造 `notionQueue` 时，把这三个字段一并收集并写入 payload。

- [x] 🟩 **Step 3: 主流程——空队列计时与 Conductor 执行**
  - [x] 🟩 在 `src/index.ts` 队列模式 `for (;;)` 内，当 `fetchOneQueuedTask()` 返回 null 时：若尚未记录「空队列起始时间」则记录为当前时间；若已记录且 `(Date.now() - 起始时间) >= conductorEmptyQueueMinutes * 60_000` 且配置了 `conductorPageUrl` 与 `conductorPrompt`，则执行 Conductor 分支。
  - [x] 🟩 Conductor 分支：打日志「队列已空满 N 分钟，执行 Conductor」；`page.goto(conductorPageUrl)`；等待 AI 入口可见后点击进入输入；`tryTypeAndSend(page, conductorPrompt, ...)`；无论成功失败，打日志并重置「空队列起始时间」，然后 `sleep(5 * 60 * 1000)`，再 `continue`。
  - [x] 🟩 取到任务时：将「空队列起始时间」清空。未达阈值或未配置 Conductor 时仍为「60 秒后重试」并 `continue`。

- [x] 🟩 **Step 4: 示例与收尾**
  - [x] 🟩 在 `schedule.example.json` 的 `notionQueue` 下增加示例：`conductorPageUrl`、`conductorPrompt`、`conductorEmptyQueueMinutes`（可选）。
  - [x] 🟩 确认日志覆盖：触发原因、Conductor 开始/结束/失败、5 分钟等待后继续抓队列。
