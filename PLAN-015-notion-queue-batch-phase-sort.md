# Feature Implementation Plan: Notion 队列按 batch_phase 排序

**Overall Progress:** `100%`

## TLDR

在 Notion 任务队列拉取任务时支持按可配置的 Batch Phase（Number）列排序：有值的任务优先且按该列升序、同 phase 内按创建时间升序；无该列或无值的记录排最后、按创建时间升序。列名在 Dashboard / schedule 中可配置，默认 `batch_phase`。

## Critical Decisions

- **列名可配置**：`NotionQueueConfig.columnBatchPhase`，默认 `"batch_phase"`；空串表示不启用批次排序。
- **本地排序兜底**：因 Notion API 未约定数字列空值在排序中的位置，实现为取一批候选（50 条）按 `created_time` 初筛，再在内存中按「有 phase 优先 → phase 升序 → created_time 升序」排序后取第一条。
- **兼容**：未配置或数据源中无该列时，仅按 `created_time` 升序取一条（与原有行为一致）。

## Tasks

- [x] 🟩 **Step 1: 配置与类型**
  - [x] 🟩 `NotionQueueConfig` 增加 `columnBatchPhase?: string`；`normalizeNotionQueue` 默认 `"batch_phase"`，`validateNotionQueue` 允许可选字符串。
  - [x] 🟩 `schedule.example.json` 中 `notionQueue` 增加 `columnBatchPhase: "batch_phase"` 示例。

- [x] 🟩 **Step 2: Dashboard**
  - [x] 🟩 Notion 任务队列区块增加「列名：Batch Phase（Number，可选）」输入框，fill/collect 读写 `columnBatchPhase`（空表示不启用）。

- [x] 🟩 **Step 3: notion-queue 排序逻辑**
  - [x] 🟩 `resolvePropertyIds` 可选解析 `columnBatchPhase`，返回 `batchPhaseId | null`；列不存在时打 log 并退回仅按创建时间。
  - [x] 🟩 新增 `getNumber`、`QueuedCandidate`、`compareCandidates`；有 `batchPhaseId` 时拉取 `QUEUE_FETCH_PAGE_SIZE` 条候选，本地排序后取第一条；否则保持原 `page_size: 1` 行为。
  - [x] 🟩 从候选页对象读取 `created_time` 与 Number 属性，按约定比较后返回一条 `QueuedTask`。

---

*Plan 对应 ISSUE-notion-queue-batch-phase-sort.md。*
