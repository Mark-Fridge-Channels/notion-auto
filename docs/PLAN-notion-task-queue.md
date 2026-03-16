# Feature Implementation Plan: Notion 任务队列

**Overall Progress:** `100%`

## TLDR

在现有「时间区间 + 行业任务链」上增加 **Notion 数据库任务队列**：用 Notion API 读取 Status=Queued 的行，Playwright 打开 File URL 并输入 `"@"+Action Name` 执行，成功后按配置更新为 Done 或删除、失败则更新为 Failed；队列配置全局一份、列名可配置；行业可二选一使用「任务链」或「Notion 队列」；使用队列时到点只跑完当前任务即停。

## Critical Decisions

- **队列配置存于 schedule.json**：顶层 `notionQueue` 一份，所有选用队列的行业共用；行业增加 `taskSource: "schedule" | "notionQueue"`，与现有 `industries[].tasks` 二选一。
- **Notion 读写只用 API**：使用 `@notionhq/client`，鉴权用环境变量 `NOTION_API_KEY`（Integration Token）；列用「用户在页面上看到的列名」配置，运行时通过 database 的 schema 解析列名 → 列 ID。
- **队列模式下的入口页**：首次打开仍用行业的 `notionUrl` 做登录与打开 Notion；取到队列任务后对该任务的 **File URL** 做 `page.goto(fileUrl)` 再 typeAndSend，不再用行业 notionUrl 做每轮跳转。
- **taskSource=notionQueue 时 tasks 可为空**：校验允许该行业 `tasks.length === 0`，避免强制写占位任务。

## Tasks

- [x] 🟩 **Step 1: 队列配置结构与 schedule 扩展**
  - [x] 🟩 在 `src/schedule.ts` 中定义 `NotionQueueConfig`：`databaseUrl`、`columnActionName`、`columnFileUrl`、`columnStatus`、`statusQueued`、`statusDone`、`statusFailed`、`onSuccess: "update" | "delete"`；在 `Schedule` 上增加可选 `notionQueue?: NotionQueueConfig`。
  - [x] 🟩 在 `ScheduleIndustry` 上增加可选 `taskSource?: "schedule" | "notionQueue"`，默认 `"schedule"`。
  - [x] 🟩 `validateSchedule`：若存在 `notionQueue`，校验其必填字段与列名为非空字符串；`validateIndustry`：当 `taskSource === "notionQueue"` 时允许 `tasks` 为空，否则仍要求 `tasks.length >= 1`。
  - [x] 🟩 `mergeSchedule` / `normalizeIndustry` 中合并默认值（`taskSource` 默认 `"schedule"`，`notionQueue` 各字段默认或可选）。
  - [x] 🟩 在 `env.example` 中增加 `NOTION_API_KEY=` 说明（Integration Token，用于 Notion 任务队列读写）。

- [x] 🟩 **Step 2: Notion API 与队列读写模块**
  - [x] 🟩 安装依赖：`@notionhq/client`。
  - [x] 🟩 新增 `src/notion-queue.ts`：从环境变量读取 `NOTION_API_KEY`；实现「从 database URL 解析 database_id」、「查询 DB schema 并按列名解析出 Action Name / File URL / Status 的 property id」；实现 `fetchOneQueuedTask(config): Promise<{ pageId, actionName, fileUrl } | null>`（筛选 Status = config.statusQueued，取一条）；实现 `markTaskDone(config, pageId)`（更新 Status 为 statusDone 或按 onSuccess 删除）、`markTaskFailed(config, pageId)`（更新 Status 为 statusFailed）。使用 logger，错误抛错或返回 null 由调用方处理。
  - [x] 🟩 无 `NOTION_API_KEY` 或未配置 `notionQueue` 时，队列相关逻辑不执行（主循环仅走 schedule 分支）。

- [x] 🟩 **Step 3: Dashboard 队列配置 UI 与行业 taskSource**
  - [x] 🟩 在 `src/server.ts` 的 HTML 中增加「Notion 任务队列」配置区块：数据库 URL 输入框、列名（Action Name / File URL / Status）三个输入框、待执行状态（默认 Queued）、完成后状态（默认 Done）、失败状态（默认 Failed）、成功后「更新状态」/「删除记录」单选；与全局设置同屏或折叠展示，随 schedule 一起 GET/POST。
  - [x] 🟩 行业编辑弹窗中增加「任务来源」：下拉或单选 `schedule` / `notionQueue`；选 `notionQueue` 时可不展示或禁用任务链表格（tasks），并提示依赖上方全局队列配置。
  - [x] 🟩 `collectSchedule` 将队列表单字段写入 `currentSchedule.notionQueue`；`mergeSchedule` 已支持该结构；保存后 GET 拉取最新 schedule 含 `notionQueue` 与各行业 `taskSource`。

- [x] 🟩 **Step 4: 主循环分支与队列执行逻辑**
  - [x] 🟩 在 `src/index.ts` 主循环中，根据 `currentIndustry.taskSource === "notionQueue"` 分支：若为队列模式且 `schedule.notionQueue` 存在且有效，进入「队列循环」；否则保持现有任务链循环。
  - [x] 🟩 队列循环：循环内先 `getIndustryForNow(schedule)`，若已离开当前时段（null 或 industryId 变化），则本轮不再取新任务；在时段内则调用 `fetchOneQueuedTask`，无任务则 sleep 60s 再重试；取到任务后 `page.goto(fileUrl)`，再复用现有 `tryTypeAndSend(page, "@" + actionName, ...)`；成功则 `markTaskDone`，失败则 `markTaskFailed`；单条完成后按 `schedule.intervalMinMs/Max` 随机间隔，再检查时间，若已离开时段则停止取新任务。
  - [x] 🟩 队列模式下首次进入仍用 `currentIndustry.notionUrl` 做登录与首次打开；之后每条任务用该任务的 `fileUrl` 做 `page.goto` 再打开 AI 并执行 typeAndSend。
  - [x] 🟩 行业切换逻辑：当 `getIndustryForNow` 返回另一行业时按现有逻辑切 URL；若新行业为 `taskSource === "notionQueue"` 则进入队列循环。队列模式下到点只跑完当前任务即停，不再取新任务。

- [x] 🟩 **Step 5: 文档与默认配置**
  - [x] 🟩 在 `README.md` 中增加「Notion 任务队列」小节：说明需配置 `NOTION_API_KEY`、在 Dashboard 配置队列（DB 地址与列名）、行业选择「Notion 队列」、Status 为 Select（Queued/Done/Failed）、到点只跑完当前任务即停。
  - [x] 🟩 `schedule.example.json` 中增加 `notionQueue` 与示例行业 `taskSource: "notionQueue"`，便于用户拷贝。

---

*Plan 基于 ISSUE-notion-task-queue.md 与探索阶段约定。*
