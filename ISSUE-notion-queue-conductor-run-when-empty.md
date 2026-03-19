# ISSUE: Notion 队列空时自动执行 Conductor 生成新任务

## TL;DR
当前 `taskSource="notionQueue"` 模式下，如果队列里没有 `Queued` 任务，程序只会等待并重试抓取，不会触发“Conductor”生成新任务；当 Conductor 任务失败后更无法产生新任务，导致系统长期空转。需要在 Dashboard 的「Notion 任务队列」里新增 Conductor 配置（一个 Notion 链接 + 一个输入框内容），并在**队列没有待执行任务时**自动执行该 Conductor，以生成新的队列任务。

## 当前状态（现有实现）
- `src/index.ts`：队列模式循环中 `fetchOneQueuedTask()` 返回 `null` 时，只记录日志并 `sleep(60_000)` 重试。
- `src/notion-queue.ts`：仅支持从 Notion 数据源读取一条 `Queued` 任务并在执行后更新 `Done/Failed`；没有任何“生成新任务”的逻辑。
- `src/server.ts` / Dashboard：仅提供 `notionQueue` 数据库 URL、列名映射、状态值等配置；没有 Conductor 的配置入口。

## 期望结果
- 在 Dashboard 的「Notion 任务队列」配置区新增 Conductor 配置项：
  - **Notion 链接**：普通 Notion 页面链接（用于打开并执行 Conductor）
  - **输入内容**（Conductor 的 prompt / 指令文本）
- 新增一个可配置的“空队列持续时长阈值”（冷却/触发间隔）：
  - **持续 N 分钟没有 `Queued` 任务**才触发一次 Conductor；**默认 30 分钟**，Dashboard 可配置。
- 程序在检测到**队列没有待执行任务（Status=Queued）且空队列持续时间 ≥ 阈值**时：
  - 自动执行一次 Conductor（打开配置的 Notion 链接，输入配置的内容并发送）
  - Conductor 执行后：**固定等待 5 分钟**，再回到队列拉取逻辑 `fetchOneQueuedTask()`。
- Conductor 失败后不做额外处理（不重试、不退避）；下一轮仍按“空队列持续达到阈值”再次触发。

## 建议的验收标准（Acceptance Criteria）
- [ ] 当队列 `Queued` 为空且**持续达到配置的阈值（默认 30 分钟）**时，触发 Conductor；否则不触发。
- [ ] Conductor 配置（链接、发送内容、空队列阈值分钟数）可通过 Dashboard 保存到 `schedule.json`，并在下次启动/刷新时正确回显。
- [ ] Conductor 执行后固定等待 **5 分钟** 再抓队列；Conductor 失败后无额外处理，下一轮仍按空队列阈值再次触发。
- [ ] 日志清晰：触发原因（队列空且持续达阈值）、Conductor 执行开始/结束/失败、等待 5 分钟后抓队列。

## 已澄清（实现约束）
- **空队列持续时长阈值**：默认 **30 分钟**，Dashboard 可配置（实现时可允许 0 = 立刻触发）。
- **Conductor 失败后**：不单独处理（不重试、不退避），继续按空队列阈值循环。
- **Conductor 触发后**：**固定等待 5 分钟**再执行 `fetchOneQueuedTask()`。

## 涉及文件（预估）
- `src/index.ts`：队列空时记录“空队列起始时间”；达到阈值且配置了 Conductor 时执行 Conductor（打开链接→输入内容→发送），然后固定 sleep 5 分钟再继续抓队列；复用现有 `page.goto` + `tryTypeAndSend`。
- `src/server.ts`：在「Notion 任务队列」卡片增加：Conductor 页面 URL、Conductor 发送内容、空队列多少分钟后触发（分钟，默认 30）；与 `collectSchedule`/load 的 notionQueue 绑定。
- `src/schedule.ts`：`NotionQueueConfig` 增加可选字段 `conductorPageUrl?`、`conductorPrompt?`、`conductorEmptyQueueMinutes?`（默认 30）；校验：若填了任一 Conductor 项则 URL 与内容必填，分钟数 ≥ 0。
- `schedule.example.json`：补充 Conductor 示例（可选块）。

## 风险 / 注意事项
- Conductor 与普通队列任务都依赖 Notion 页面可交互、AI 可发送；需要复用现有 `waitSubmitReadyMs`、重试与恢复重启机制，避免引入新的卡死点。
- 需避免 Conductor 在队列短暂抖动时频繁触发，导致重复生成任务（建议加 cooldown 或“本次空队列已触发”标记）。

## Labels（建议）
- type: feature
- priority: normal
- effort: medium

