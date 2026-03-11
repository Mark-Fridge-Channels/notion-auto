# 027 Inbound 日志入 tab、Reply Tasks 多配置执行、Priority 列与排序 — 探索结论

## 1. 需求理解

- **需求 1**：Inbound 的日志也需要放在 Inbound Listener（即 Inbound Listener tab 内应有专属「最近运行日志」区块，与 Reply Tasks tab 的自动发送日志类似）。
- **需求 2**：澄清：若 Reply Tasks 配置有多条，自动发送是否都会执行？当前实现只执行「当前选中」的一条。
- **需求 3**：当前库 Task 列表增加列 **Priority**（Select 类型，High / Medium / Low）；自动执行时除时间顺序外，还需按 Priority 排序（理解为 High 优先，再 Medium，再 Low）。

---

## 2. 现有实现简要

### 2.1 日志与 tab

- **GET /api/logs**：合并 Playwright、Queue Sender、Inbound Listener 三种 run（各取最近 10 条），按 `startTime` 倒序取前 20 条返回；无按 kind 过滤的 query 参数。
- **主视图（tab-main）**：唯一有「最近运行日志」的 tab，使用 `logTabs` + `logContent`，数据来自 `/api/logs`，按钮按 `r.kind` 显示「Playwright #x」「Queue #x」「Inbound #x」。
- **Inbound Listener tab（tab-inbound）**：仅有配置卡片（轮询间隔、Body Plain 最大字符、监听组），**没有**任何日志区块。
- **Reply Tasks tab**：已有「Reply Tasks 自动发送 · 最近运行日志」区块，数据来自 **GET /api/reply-tasks-auto-send/logs**。

### 2.2 Reply Tasks 自动发送与配置

- **配置**：`reply-tasks.json` 含 `entries[]`（多条）与 `selected_index`（当前选中）。
- **自动发送**：`reply-tasks-auto-sender.ts` 每轮只使用 **当前选中的一条**：`const idx = config.selected_index >= 0 ? config.selected_index : 0; const entry = config.entries[idx];`，只对该 entry 的库做 `listReplyTasks` 与发送。**多条配置不会同时执行**。

### 2.3 Task 列表与排序

- **listReplyTasks**：返回 `ReplyTaskListItem[]`，字段为 `pageId, taskSummary, status, suggestedReply`；**无 Priority**。排序仅支持 `sortLastEdited: 'asc'|'desc'`（单维度）。
- **Dashboard 列表**：`renderReplyTasksList()` 展示 summary、status、snippet、操作；**无 Priority 列**。
- **自动发送**：调用 `listReplyTasks(..., { filterStatusNotDone: true, sortLastEdited: 'asc' })`，取列表第一条发送，**无按 Priority 的排序**。

---

## 3. 需求 1：Inbound 日志放在 Inbound Listener tab

### 3.1 结论

- 在 **tab-inbound** 内增加「Inbound Listener · 最近运行日志」区块（标题 + 运行 tabs + 日志内容区），与 Reply Tasks tab 的日志区结构一致。
- 数据来源二选一：
  - **方案 A**：新增 **GET /api/inbound-listener/logs?n=10**，仅返回 `inboundListenerRunner.getInboundListenerRunLogs(n)`，前端 Inbound tab 只请求该接口。
  - **方案 B**：沿用 **GET /api/logs**，增加 query 参数 **kind**（如 `kind=inbound-listener`），后端按 kind 过滤后返回；前端 Inbound tab 请求 `/api/logs?kind=inbound-listener`。
- **推荐方案 A**：与 Reply Tasks 的 `/api/reply-tasks-auto-send/logs` 对称，实现简单，无需改现有 `/api/logs` 的合并逻辑。
- **前端**：Inbound tab 内使用独立 DOM（如 `inboundListenerLogTabs`、`inboundListenerLogContent`），独立状态与 `renderInboundListenerLogTabs`、`refreshInboundListenerLogs`，初始化与定时刷新（如 5s）或切到该 tab 时刷新。

### 3.2 涉及文件（预估）

- `src/server.ts`：新增 `GET /api/inbound-listener/logs`（n 默认 10）；tab-inbound 内增加日志卡片 HTML；前端增加上述渲染与刷新逻辑。

---

## 4. 需求 2：Reply Tasks 配置有多条是否都会执行？

### 4.1 当前行为

- **仅执行当前选中的一条**（`selected_index` 对应的 entry）；其他条目不参与自动发送。

### 4.2 需你确认

- **选项 A**：保持现状，自动发送只跑「当前选中」的那一条；用户切换选中即切换自动发送的库。
- **选项 B**：自动发送对**所有**配置条目都执行：每轮依次（或按某种顺序）处理每个 entry，例如先拉取 entry0 的待发列表、发一条，再 entry1、再 entry2…；节流仍按「发送者」维度，可跨库共用（同一发件人在不同库发信也受同一套节流限制）。
- 若选 **B**，需约定：
  - 多库之间的轮次顺序（固定顺序 / 按 selected 优先等）；
  - 每轮每库是否仍为「至多 1 条」还是可配置。

---

## 5. 需求 3：Priority 列 + 自动执行按 Priority 排序

### 5.1 数据与 Notion

- Notion 中 Reply Tasks 库需有 **Priority** 列，类型为 **Select**，选项名建议为 **High**、**Medium**、**Low**（若你库中命名不同，需在代码里做映射或配置）。
- 若某行未设 Priority，视为最低优先级（等价于「Low」或单独一类「无」）。

### 5.2 列表展示（当前库 Task 列表）

- **ReplyTaskListItem** 增加可选字段 `priority: string | null`（Select 的 option name，如 `"High"` / `"Medium"` / `"Low"`）。
- **listReplyTasks**：在解析每页时读取 Priority 列（Select 类型，取 `select?.name`），写入 list 项。
- **Dashboard**：`renderReplyTasksList()` 增加一列显示 Priority（可放在 Status 前或后）。

### 5.3 自动执行排序规则

- 期望顺序：**先按 Priority（High > Medium > Low），再按时间（最早编辑优先）**。
- Notion API 的 `sorts` 可多段，但 Select 的排序顺序取决于 Notion 里该属性选项的先后顺序，不一定与 High/Medium/Low 语义一致；因此**推荐**：
  - 查询时仍用 `sortLastEdited: 'asc'`（或仅按时间），拿到列表后在**内存**中按 Priority 再排：  
    - 优先级权重：High=0, Medium=1, Low=2, 空/其他=3；  
    - 先按该权重升序，再按原有列表顺序（即 last_edited_time 升序）稳定排序。
- **listReplyTasks**：返回的列表已含 `priority`；**reply-tasks-auto-sender** 在取到 `tasks` 后，先按 priority 权重排序，再取第一条发送。

### 5.4 涉及文件（预估）

- `src/notion-reply-tasks.ts`：`ReplyTaskListItem` 增加 `priority`；解析时读 Priority（Select）；可选导出 `sortTasksByPriorityThenTime(tasks)` 或在内层排序。
- `src/reply-tasks-auto-sender.ts`：获取列表后按 Priority 再排，再取第一条。
- `src/server.ts`：`renderReplyTasksList()` 增加 Priority 列；若 API 返回的 list 已带 `priority`，无需改后端 list 接口（除非当前 list 来自别的路径需对齐）。

### 5.5 需你确认

- Priority 在 Notion 中的**列名**是否就是 **"Priority"**？若为其他（如「优先级」），需在代码里用该名读属性。
- 除 High / Medium / Low 外是否还有其它选项（如「无」）；若有，希望排在 High/Medium/Low 的哪里（例如与 Low 同档或更低）。

---

## 6. 小结

| 需求 | 结论 / 待确认 |
|------|----------------|
| **1. Inbound 日志放在 Inbound Listener** | 在 tab-inbound 增加「Inbound Listener · 最近运行日志」区块；推荐新增 GET /api/inbound-listener/logs，前端独立 DOM 与刷新逻辑。 |
| **2. 多条 Reply Tasks 配置是否都执行** | 当前只执行选中的一条。需你确认：保持只跑选中（A）还是改为跑全部条目（B）；若 B，需约定多库顺序与每库每轮条数。 |
| **3. Priority 列 + 自动按 Priority 排序** | 列表增加 Priority 列（Select：High/Medium/Low）；listReplyTasks 返回 priority；自动发送在内存中先按 Priority（High>Medium>Low）再按时间排序后取第一条。需确认 Notion 列名与选项名。 |

确认上述选择后即可进入 create-plan / 实现。
