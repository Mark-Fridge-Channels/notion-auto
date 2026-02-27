# Reply Tasks / Inbound Listener 各自「最近运行日志」— 探索结论

## 需求理解

- **Reply Tasks tab** 和 **Inbound Listener tab** 下应各有自己的「最近运行日志」区块。
- 日志需**按 tab 区分**：不同 tab 只展示与该 tab 相关的日志。

---

## 当前实现

| 项目 | 现状 |
|------|------|
| 日志区块位置 | 仅在 **tab-main**（主视图）有一块「最近运行日志」：`logTabs` + `logContent`。 |
| 数据来源 | **GET /api/logs**：合并三种 run 后返回一条列表。 |
| Run 类型 | `playRuns`（kind: `playwright`）、`queueRuns`（kind: `queue-sender`）、`inboundRuns`（kind: `inbound-listener`），各取最近 10 条，合并后按 `startTime` 倒序取前 20 条。 |
| 前端 | 单一 `runs` 数组、单一 `renderLogTabs()`、单一 `refreshLogs()`；按钮文案按 `r.kind` 显示为「Playwright #x」「Queue #x」「Inbound #x」。 |
| Reply Tasks | **没有**对应的 runner 或 run log。Reply Tasks 通过 API 单条/批量发送，无长期子进程，也没有「Reply Tasks 运行日志」的存储与接口。 |

---

## 实现思路（按 tab 区分日志）

### 1. Inbound Listener tab — 本 tab 专属「最近运行日志」

- **数据**：只展示 `kind === 'inbound-listener'` 的 runs。
- **实现**：
  - **方案 A**：沿用现有 **GET /api/logs**，前端在 Reply Tasks / Inbound Listener tab 内只渲染**过滤后的** runs（Inbound tab 只取 `r.kind === 'inbound-listener'`），主视图可继续用「全部」或只 Playwright+Queue（见下）。
  - **方案 B**：新增 **GET /api/logs?kind=inbound-listener**（及可选的 `kind=playwright`、`kind=queue-sender`），后端按 `kind` 过滤后返回，前端各 tab 只请求自己需要的 kind。
- **UI**：在 **tab-inbound** 内增加一块与主视图同结构的「最近运行日志」卡片（标题 + tabs 按钮 + 日志内容区），使用**独立的 DOM id**（如 `inboundLogTabs`、`inboundLogContent`）和独立的状态/渲染函数，只填充 inbound-listener 的 runs。

### 2. Reply Tasks tab — 本 tab 专属「最近运行日志」

- **数据**：当前**没有** Reply Tasks 的 run 概念；只有「单条发送」「批量发送」的 API 调用，无子进程、无 stdout/stderr 采集。
- **实现选项**：
  - **选项 A（仅 UI 占位）**：在 Reply Tasks tab 内增加「最近运行日志」卡片，仅显示「（暂无运行记录）」或「发送记录（待实现）」；后续若要做「发送历史」，再单独加后端存储 + API。
  - **选项 B（发送历史）**：在本需求内增加「Reply Tasks 发送历史」：后端在内存中保留最近 N 次「单条发送 / 批量发送」记录（时间、结果摘要、条数等），并新增例如 **GET /api/reply-tasks/logs** 或 **GET /api/logs?kind=reply-tasks**，返回这些记录；前端在 Reply Tasks tab 的日志区展示。需要约定记录结构（如 id、startTime、type: 'single'|'batch'、ok/failed 数、摘要一行等）。

### 3. 主视图（tab-main）的「最近运行日志」

- **可选**：
  - 保持现状：仍显示**全部** runs（Playwright + Queue + Inbound），或
  - 只显示**与主视图相关**的：例如仅 Playwright + Queue（不显示 Inbound），以便主视图对应「任务链 + Queue 出站」，Inbound 只在 Inbound tab 看。

---

## 需要你拍板的两点

1. **主视图的日志范围**  
   主视图的「最近运行日志」是继续**全部**（Playwright + Queue + Inbound），还是改为**仅 Playwright + Queue**（Inbound 只在 Inbound tab 看）？

2. **Reply Tasks 日志的数据来源**  
   - 若选**仅占位**：Reply Tasks tab 只加一块「最近运行日志」UI，文案为「暂无运行记录」或「待实现」，不做后端。  
   - 若选**发送历史**：需要在本需求内设计并实现「Reply Tasks 发送历史」的存储（内存即可）、记录写入时机（单条/批量发送成功后）、以及返回接口（如 GET /api/logs?kind=reply-tasks 或 GET /api/reply-tasks/logs），并约定每条记录包含的字段（时间、类型、成功/失败数等）。

---

## 涉及文件（按上述方案会动到的）

| 文件 | 改动 |
|------|------|
| `src/server.ts` | 1）在 tab-inbound 增加「最近运行日志」卡片（inboundLogTabs / inboundLogContent）；2）在 tab-reply-tasks 增加「最近运行日志」卡片（replyTasksLogTabs / replyTasksLogContent）；3）前端：按 tab 过滤 runs 或调用带 kind 的 API，并分别渲染主视图 / Inbound / Reply Tasks 三块日志；4）若做 Reply Tasks 发送历史：在 POST /api/reply-tasks/send 与 send-batch 成功后写入内存列表，并新增 GET 接口返回。 |
| 可选：`src/server.ts` 或 API 层 | 若采用 **GET /api/logs?kind=xxx**：在现有 /api/logs 中解析 query.kind，按 kind 过滤后再返回。 |

---

## 小结

- **Inbound Listener tab**：可以明确为「本 tab 只显示 inbound-listener 的 runs」，用过滤或专用 API 即可。
- **Reply Tasks tab**：需要你先定是「仅占位」还是「发送历史」；若选发送历史，再定主视图是否仍显示「全部」或仅 Playwright+Queue。  
确认后即可写实现计划（create-plan）或直接实现（execute）。
