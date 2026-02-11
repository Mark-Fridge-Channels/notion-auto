# Feature Implementation Plan: Dashboard 行业列表 + 编辑弹窗 + 时间区间同步

**Overall Progress:** `100%`

## TLDR

将 Dashboard 行业区改为「列表行（名称 + URL + 编辑）」主视图，任务链与 N/M 移入编辑弹窗；时间区间下拉增加「+ 新建行业」并支持选后自动打开该行业编辑；行业 id 重命名或删除时同步更新所有引用该行业的时间区间。

## Critical Decisions

- **编辑入口**：采用弹窗（modal）或侧边栏；实现时二选一，与现有 `.card` 风格一致（如遮罩 + 固定宽度的浮层）。
- **数据源**：继续共用内存中同一 `schedule` 对象；所有变更后统一调用 `renderTimeSlots(schedule)` 和 `renderIndustries(schedule)`（或等价重绘）以保持时间区间下拉与行业列表一致。
- **删除行业**：删除时将所有 `timeSlots[].industryId === 该行业id` 改为当前行业列表第一项（若列表为空则清空或占位），再重绘时间区间。
- **新建行业**：占位 id 如 `new_` + Date.now()，notionUrl 空；新建后自动打开该行业的编辑弹窗并选中该 slot。

## Tasks

- [x] 🟩 **Step 1: 行业主视图改为列表行**
  - [x] 🟩 将当前「行业块」内联表单改为**列表行**：每行仅展示行业 **id（名称）**、**Notion URL**（可截断或省略显示）、**编辑** 按钮、**删除** 按钮。
  - [x] 🟩 移除主视图中每行业的 N/M、任务链展示与编辑；保留「添加行业」按钮，新行业仍追加到 `schedule.industries` 并重绘列表。

- [x] 🟩 **Step 2: 编辑弹窗（或侧边栏）**
  - [x] 🟩 增加一层编辑 UI（弹窗或侧栏）：标题为当前编辑的行业 id（或「新建行业」）；表单字段为 id、notionUrl、newChatEveryRuns、modelSwitchInterval、任务链（列表：每项 content + runCount，支持增删任务）；底部**保存**、**取消**。
  - [x] 🟩 打开方式：列表行点击「编辑」→ 传入该行业对象（或索引），打开弹窗并填充表单；取消则关闭弹窗不写回。
  - [x] 🟩 保存时：若行业 id 发生变更，遍历 `schedule.timeSlots`，将 `industryId === 旧id` 的项改为新 id；然后写回 `schedule.industries` 中对应项，关闭弹窗，调用 `renderTimeSlots(schedule)` 与 `renderIndustries(schedule)` 同步 UI。

- [x] 🟩 **Step 3: 时间区间下拉增加「+ 新建行业」**
  - [x] 🟩 时间区间行的行业下拉选项 = 当前 `schedule.industries` 的 id 列表 + 最后一项 **「+ 新建行业」**。
  - [x] 🟩 当用户选择「+ 新建行业」时：向 `schedule.industries` 追加一条新行业（占位 id、空 URL、默认 N/M、单条空任务）；将**当前时间区间行**的选中值设为该新行业 id；调用 `renderTimeSlots(schedule)`（使下拉显示新项并选中）；**自动打开**该新行业的编辑弹窗。

- [x] 🟩 **Step 4: 删除行业时同步时间区间**
  - [x] 🟩 在编辑弹窗或列表行执行「删除行业」时：从 `schedule.industries` 移除该行业；将所有 `schedule.timeSlots` 中 `industryId === 该id` 的项改为当前剩余行业列表的**第一项**（若已无行业则设为空或占位）；调用 `renderTimeSlots(schedule)` 与 `renderIndustries(schedule)`。

- [x] 🟩 **Step 5: 收尾与一致性**
  - [x] 🟩 确保所有修改 `schedule.industries` 或 `schedule.timeSlots` 的操作（新增/删除/重命名行业、选择「+ 新建行业」）后均触发时间区间与行业列表的重绘，避免下拉选项或选中值与数据不一致。
  - [x] 🟩 保留 `collectSchedule()` 从当前 DOM 收集数据的逻辑，确保列表行与弹窗内的编辑结果正确写入 schedule（列表行仅展示，实际提交仍以弹窗保存或 DOM 中隐藏/只读字段为准；若采用「编辑仅在弹窗内写回内存、列表只读展示」则 collectSchedule 时行业数据以内存中 schedule 为准）。
