# 优化：Notion 队列支持 `batch_phase` 排序（可配置列名）

**类型:** Improvement  
**优先级:** Normal  
**工作量:** Small ~ Medium  

---

## TL;DR

当前 Notion 队列读取待执行任务时，固定按 `created_time` 升序取第一条。希望改为：

- **`batch_phase` 列名可配置**（在 Dashboard / `schedule.json` 的 `notionQueue` 下配置）。
- **存在 `batch_phase` 的任务优先执行**：按 `batch_phase`（Number）**正序**，同一 `batch_phase` 内按 `created_time` **正序**。
- **没有 `batch_phase` 的任务放到最后处理**：按 `created_time` **正序**。

这样可以让队列支持显式批次顺序，同时兼容未配置 `batch_phase` 的旧数据。

---

## 当前状态 vs 期望

| 项目 | 当前 | 期望 |
|------|------|------|
| 队列排序 | 固定按 Notion 内置 `created_time` 升序 | 有 `batch_phase`：按 `batch_phase` 升序、再按 `created_time` 升序；无 `batch_phase`：排最后并按 `created_time` 升序 |
| 兼容性 | 不识别额外排序字段 | 兼容已有无 `batch_phase` 的记录，不破坏旧行为 |
| 取任务方式 | `fetchOneQueuedTask()` 查询 `Status=Queued` 后直接取第一条 | `fetchOneQueuedTask()` 需先应用新的排序策略，再取第一条 |
| 配置 | notionQueue 仅可配 Action/FileUrl/Status 等列 | notionQueue 增加 `columnBatchPhase`（列名，默认 `batch_phase`） |

---

## 需求说明

1. 从 `notion-queue` 读取待执行任务时，需要支持基于 `batch_phase` 的排序。
2. 排序规则：
   - 若存在 `batch_phase`（Number）值：按其值从小到大排序；
   - 若 `batch_phase` 缺失/空：放到最后，再按 `created_time` 从早到晚排序。
3. 需要保证对当前仅依赖创建时间排序的队列保持兼容。
4. `batch_phase` 的列名以用户在 Notion 页面上看到的列名为准（默认就是 `batch_phase`），并做成可配置项。

---

## 涉及文件

- `src/notion-queue.ts`
  - 当前 `fetchOneQueuedTask()` 在查询时固定使用 `created_time` 升序排序。
- `src/schedule.ts`
  - 扩展 `NotionQueueConfig`（新增 `columnBatchPhase?: string` 或等价字段），并在 merge/normalize/validate 中处理默认值与校验。
- `src/server.ts`
  - Dashboard 的「Notion 任务队列」配置区块增加 `batch_phase` 列名输入框，并在 collect/fill 时读写到 `schedule.notionQueue`。
- 如需补充说明或示例：
  - `README.md`
  - `schedule.example.json`（建议加入 `columnBatchPhase: "batch_phase"` 示例）

---

## 风险与注意事项

- **Notion API 空值排序不确定**：官方文档支持多字段 sort，但未明确 Number 列为空时在升序中的位置；为了稳定满足“无 `batch_phase` 放最后”，实现上需要本地排序/选择兜底。
- **字段类型**：本需求约定 `batch_phase` 为 **Number**；若用户在 Notion 里用成 Text，需要额外转换/校验（可选择在校验阶段就报错或回退策略）。

---

## 建议实现方向

1. 扩展配置：
   - `NotionQueueConfig` 增加 `columnBatchPhase`（默认 `batch_phase`），并在 Dashboard / `schedule.example.json` 提供入口与示例。
2. 在 `fetchOneQueuedTask()` 中读取每条记录的 `batch_phase` 数值（Number property）。
3. 为保证空值放最后，建议实现为：
   - 查询时不再 `page_size: 1`，而是取一小批候选（例如 20~100，按 `created_time` 升序做初筛），然后在本地按规则排序后取第一条；
   - 若后续要优化，可尝试 API 层先按 `batch_phase` + `created_time` sort，但仍保留本地兜底，以规避空值顺序不确定。
4. 增加最小验证，覆盖：
   - 有 `batch_phase` 的记录按阶段顺序执行；
   - 无 `batch_phase` 的旧记录排在所有有 `batch_phase` 的记录之后，且内部仍按创建时间执行；
   - 缺失/空值场景不会导致队列中断。

---

## 已记录的需求约定

- 来源：`notion-queue`
- 当前行为：按创建时间排序
- 目标行为：
  - `batch_phase` 列名可配置（默认 `batch_phase`），列类型为 **Number**
  - 有 `batch_phase`：按 `batch_phase` 正序，再按 `created_time` 正序
  - 无 `batch_phase`：放到最后，按 `created_time` 正序
- 默认判断：这是对现有队列调度逻辑的增强，不涉及执行动作、状态流转或 Playwright 行为变更
