# Reply Tasks 自动发送开关（按 Queue 节流）

## TL;DR

在 Reply Tasks 配置与 Task 列表区域增加「开启自动发送」开关。打开后，后台按当前选中的 Reply Tasks 库轮询 Todo 状态 Task，并**按 Dashboard 全局设置中的 Queue 发信节流**（按发送者、两封间隔、每小时/每天上限）逐条发送，发送成功后标为 Done。

## 当前状态 vs 期望

| 维度 | 当前 | 期望 |
|------|------|------|
| 发送方式 | 仅手动：单条「发送」或「批量发送」；批量发送为连续逐条无节流 | 增加**自动发送**：用户打开开关后，系统自动轮询 Todo 列表，按节流逐条发送 |
| 节流 | 批量发送无节流，易触发限流 | 自动发送复用「Queue 发信节流」配置（与 Queue Sender 同一套：min/max 间隔、每发送者每小时/每天上限） |
| UI | 无自动发送入口 | Reply Tasks 配置或 Task 列表旁有「开启/关闭自动发送」开关，状态可见（运行中/已停止） |

## 关键点

- **数据源**：当前选中的 Reply Tasks 配置项对应的库；只处理 **Status ≠ Done** 的 Task（与现有 list 筛选一致）。
- **节流**：与 Queue Sender 共用同一套节流配置（`schedule.queueThrottle` / 全局设置四项），按**发送者**（Sender Account → 同一发件人）独立节流，避免同一邮箱短时间多发。
- **发送逻辑**：复用现有 `sendOneReplyTask`（使用 Task 的 Suggested Reply 转 HTML，不开放编辑）；每轮可仿照 Queue Sender「每发送者至多发 1 条」或简化为「每轮至多发 1 条」再 sleep，具体实现时定。
- **启停**：由 Dashboard 开关控制；关闭后停止轮询，无待发时也可 sleep 较长再拉取，与 queue-sender 行为类似。

## 涉及文件（预估）

| 文件 | 改动概要 |
|------|----------|
| `src/server.ts` | 1）Reply Tasks  tab 增加自动发送开关 UI、状态展示；2）新增 API：如 `GET/POST /api/reply-tasks-auto-send/status`、`POST /api/reply-tasks-auto-send/start`、`POST /api/reply-tasks-auto-send/stop`；3）或采用 in-process 定时循环，或 spawn 独立进程（若采用 runner 则需新文件）。 |
| `src/reply-tasks-send.ts` 或新模块 | 若在进程内实现：需「轮询 Todo 列表 → 按节流选一条发送 → sleep」的循环，并读取 schedule 的 queueThrottle（或 env 注入的 QUEUE_THROTTLE_*）。若采用独立进程，则新建 `reply-tasks-auto-sender.ts` + runner，由 server 启停并注入节流 env。 |
| `src/schedule.ts` | 无改动（节流已存在）；若自动发送与 Queue Sender 共用 schedule 的 queueThrottle，则 server 在启动自动发送前同样将节流写入 env 或传入参数。 |

## 风险与备注

- **节流共用**：Reply Tasks 与 Queue Sender 若同时运行，会共用同一套「按发送者」节流计数还是分开？建议**共用**同一套节流状态（同一发件人两处一起限制），否则需维护两套状态且容易超出平台限制。若共用，自动发送循环需与 queue-sender 共享节流状态，实现上可能需在 server 侧维护 throttle state 或由单一进程统一发信。
- **实现形态**：In-process 循环（setInterval/while + 异步）vs 独立子进程（如 `dashboard-reply-tasks-auto-sender-runner.ts` spawn 一个常驻脚本）。独立进程更清晰、与 Queue Sender 对称，但节流状态若要与 Queue Sender 共用则需共享存储或都放在 server 侧；仅 Reply Tasks 自动发则可独立进程 + 独立节流状态（同一 schedule 配置即可）。
- **Todo 状态**：当前 list 接口已支持 `filterStatusNotDone: true`，自动发送只处理这些即可。

## 类型与优先级

- **Type**: feature  
- **Priority**: normal  
- **Effort**: medium（需节流逻辑复用或共享、轮询循环、API 与 UI）
