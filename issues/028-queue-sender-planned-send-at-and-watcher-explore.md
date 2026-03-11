# 探索：028 Queue Sender Planned Send At + Watcher

## 已确认

- **无 Planned Send At**：字段为空的 Queue 行**一律不发送**（已写入 issue 028 行为约定与风险备注）。

---

## 与现有实现的对接

- **`src/notion-queue.ts`**  
  - 当前 `pageToQueueItem` 在 `ignorePlannedSendAt` 时完全不看 `plannedSendAt`；不传时要求 `now >= plannedSendAt`，且未处理「过期 >5min 不纳入」。  
  - 需新增：在「不忽略」前提下，仅当 `plannedSendAt != null` 且 `now - 5min ≤ plannedSendAt ≤ now` 才返回 ok；`plannedSendAt == null` 直接 skip（一律不发送）；`now - plannedSendAt > 5min` 也 skip（过期不处理）。可通过 `QueryQueuePendingOptions` 增加如 `plannedSendWindowMs: number`（5 * 60 * 1000），不再使用 `ignorePlannedSendAt`。

- **`src/queue-sender.ts`**  
  - 主循环当前：先 `getIndustryForNow`，仅当当前为 Queue 行业时才 `runOneRound`，否则 sleep 1 分钟；`runOneRound` 内用 `ignorePlannedSendAt: true` 拉取，再按发送者节流「每发送者至多发 1 条」，最后按 `nextSendAt` 或 1 分钟休眠。  
  - 改为：每轮固定按 1 分钟间隔（每轮末尾统一 sleep 1 分钟）；调用 `queryQueuePending` 时传入 5 分钟窗口、不再传 `ignorePlannedSendAt`；仍仅在「当前时段为 Queue 行业」时执行发送（**时段逻辑保留**）。节流见下条「节流简化」。

- **`src/server.ts`**  
  - 为 Queue Sender 增加与 Inbound 相同的 watcher：在 `listen` 回调内 `setInterval(60_000, () => { if getQueueSenderStatus() === 'idle' then startQueueSender() })`，不维护 mainStarted。

---

## 已拍板

### Watcher 触发条件：**B**

- 与 Inbound 一致：不区分主启动，只要 server 在 listen，每分钟若 Queue Sender 为 `idle` 就拉。
- 实现：在 `listen` 回调里像 Inbound 一样加 `setInterval(60_000, () => { if getQueueSenderStatus() === 'idle' then startQueueSender() })`，不维护 `mainStarted`。

---

## 节流简化（已拍板）

- **理解**：028 下发送节奏已由「Planned Send At 5 分钟窗口 + 每分钟轮询」控制，节流主要作**保底**，避免单发件人单日爆量。
- **约定**：取消「两封之间最少/最多间隔」和「每个发件人每小时最多几封」，**只保留「每个发件人每天最多发几封」**。
- **影响**：
  - **Schedule**：`QueueThrottle` 可简化为只含 `maxPerDay`（或保留旧字段做兼容、UI 只展示一项）；默认值仅需每日上限（如 50）。
  - **Dashboard 全局设置**：Queue 发信节流区域只保留一项——「每个发件人每天最多发几封」；去掉两封间隔、每小时上限的输入框与保存逻辑。
  - **queue-sender**：节流只检查 `countThisDay < maxPerDay`（不再用 `nextSendAt`、不再用 `countThisHour`）；每轮仍「每发送者至多 1 条」。
  - **reply-tasks-auto-sender**：同样只保留「每天上限」的节流逻辑，与 queue-sender 一致。
  - **server**：启动 Queue Sender / Reply Tasks 自动发送时只注入 `QUEUE_THROTTLE_MAX_PER_DAY`（或保留 env 名但只读 maxPerDay）。
- **是否并入 028**：**是**，与 028 一起做（用户已确认）。

---

## 其余结论（无歧义，按此实现即可）

- **时段**：保留现状，仅在 schedule 的 **Queue 行业时段内**才执行轮询与发送；非 Queue 时段只 sleep 不拉 Notion。
- **5 分钟**：首版用固定 5 分钟，不配置项；若以后要可配再加 env。
- **防重 / 过期**：逻辑已在 issue 中写清，按 028 行为约定实现即可。

---

## 实现注意（兼容）

- **旧 schedule 含四项 queueThrottle**：实现时 `QueueThrottle` 仅保留 `maxPerDay`；读取旧 JSON 时从 `queueThrottle` 取 `maxPerDay`（缺省 50），其余字段忽略；保存时只写 `maxPerDay`。旧配置文件无需迁移即可用。

---

## 无其他问题

- 028（Planned Send At 窗口 + 每分钟轮询 + 过期不处理 + Watcher）+ 节流简化（只保留每日上限）范围已闭合，可直接进入 **create-plan** 或实现。
