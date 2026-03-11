# Queue Sender：Planned Send At 参与发送节奏 + 每分钟轮询 + 过期不处理 + 后台监听自动重启

**类型**：feature  
**优先级**：normal  
**预估**：medium  

---

## TL;DR

- 发送节奏改为**由程序控制且 Planned Send At 参与**：仅当 Planned Send At 落在「当前时间往前 5 分钟内」才发送；成功发过的（Sent At Last / Message ID Last 已有）不重复发；重启后超过该 5 分钟窗口的过期任务**不再处理**。
- 程序**每分钟轮询**任务，满足上述时间窗口的才进入发送逻辑。
- **Queue Sender 常驻**：增加监听逻辑，server listen 后每分钟检查一次，若进程为 idle 则**自动拉**（与 Inbound Listener 的 watcher 一致，不区分主启动）。

---

## 当前状态 vs 期望

| 维度 | 当前 | 期望 |
|------|------|------|
| Planned Send At | 不参与（`ignorePlannedSendAt: true`），所有 Pending 按节流发 | **参与**：仅当 `now - 5min ≤ plannedSendAt ≤ now` 才可发 |
| 轮询节奏 | 按节流/下次可发时间休眠，无待发时 1 分钟拉一次 | **固定每分钟**轮询一次，再按时间窗口筛选 |
| 已发送防重 | Sent At Last / Message ID Last 已有则 query 不纳入 | 保持，执行成功后不重复发送 |
| 重启后过期任务 | 当前会纳入（忽略 Planned Send At） | **过期不处理**：若 `now - plannedSendAt > 5min` 则跳过 |
| Queue Sender 进程 | 仅 Dashboard 启停，无自动恢复 | **后台监听**：listen 后每分钟检查，若 idle 则自动拉（与 Inbound 一致） |

---

## 涉及文件

- **`src/notion-queue.ts`**  
  - 查询/单条解析需支持「Planned Send At 窗口」：仅当 `plannedSendAt != null` 且 `now - 5min ≤ plannedSendAt ≤ now` 才纳入；**无 Planned Send At 的项一律不纳入**。需在 `pageToQueueItem` / `queryQueuePending` 增加窗口参数（如 `plannedSendWindowMs`），不再使用 `ignorePlannedSendAt`。
- **`src/queue-sender.ts`**  
  - 主循环改为**固定每分钟**轮询（例如 `SLEEP_NO_PENDING_MS = 60_000` 且每轮统一 sleep 1 分钟后再拉取）；调用 `queryQueuePending` 时传入「Planned Send At 窗口」条件（5 分钟），不再传 `ignorePlannedSendAt: true`。  
  - 过期逻辑：仅处理 `plannedSendAt` 在窗口内的项；窗口外（含过期 >5min）不拉入或拉入后丢弃。
- **`src/dashboard-queue-sender-runner.ts`**  
  - 无接口变更；仍由 server 启停。
- **`src/server.ts`**  
  - 在 listen 回调内为 Queue Sender 增加 **watcher**：`setInterval(60_000)` 若 `getQueueSenderStatus() === 'idle'` 则 `startQueueSender()`。  
  - **节流简化**：全局设置中 Queue 发信节流只保留「每个发件人每天最多发几封」一项；保存/拉取 schedule 时 `queueThrottle` 只读写 `maxPerDay`；启动 Queue Sender / Reply Tasks 自动发送时只注入 `QUEUE_THROTTLE_MAX_PER_DAY`。
- **`src/schedule.ts`**  
  - **节流简化**：`QueueThrottle` 改为只含 `maxPerDay`（或保留旧字段兼容读取，默认不限制间隔与每小时）；校验与默认值相应调整。
- **`src/reply-tasks-auto-sender.ts`**  
  - **节流简化**：节流逻辑只检查「每发件人每天上限」，与 queue-sender 一致。

---

## 行为约定（实现时遵守）

1. **发送窗口**：`plannedSendAt ≤ now` 且 `now - plannedSendAt ≤ 5 分钟` 才发送；**无 Planned Send At（字段为空）的 Queue 行一律不发送**。
2. **防重**：继续依赖 Notion 的 Sent At Last / Message ID Last，执行成功后不再发送。
3. **过期**：`now - plannedSendAt > 5 分钟` 的任务不处理（不发送、不回写失败，仅跳过）。
4. **轮询**：每分钟执行一轮：拉取 → 应用 5 分钟窗口过滤 → 按发送者至多 1 条，节流仅保留「每个发件人每天最多发几封」保底（见下条节流简化）。
5. **Watcher**：与 Inbound 一致——不区分主启动，只要 server 在 listen，每分钟若发现 Queue Sender 为 idle 则自动 `startQueueSender()`（不维护 mainStarted 标志）。

6. **节流简化**：取消「两封之间最少/最多间隔」和「每个发件人每小时最多几封」，**只保留「每个发件人每天最多发几封」**；Dashboard 全局设置只保留该项，queue-sender 与 reply-tasks-auto-sender 的节流逻辑同步简化（仅检查每日上限）。

---

## 风险与备注

- **时区**：Planned Send At 的解析仍依赖现有 `PLANNED_SEND_AT_TZ` / Notion 返回格式，需确保 5 分钟窗口与业务时区一致。
- **无 Planned Send At**：已约定为**一律不发送**，实现时在过滤逻辑中排除 `plannedSendAt == null` 的项。
- **与节流关系**：5 分钟窗口决定「是否有资格被发」；节流仅保留「每发件人每天上限」作保底，不再有两封间隔与每小时上限。
- **Watcher 与主停止**：主停止时先停 Queue Sender；watcher 每 60s 若 idle 就拉，故 stop 后下一轮 interval 仍可能再次拉起来。若期望「主停止后不再自动拉」，需后续加 mainStarted 等标志；当前采用与 Inbound 一致、不区分主启停。
