# 探索：Queue Sender 配置改为独立页面配置（类 Reply Tasks）、可配置多条

## 当前状态

- **配置来源**：Queue 的「用哪个库发」来自 **schedule.json**：
  - `schedule.industries[]` 里 `type === "queue"` 的行业，字段：`id`、`queueDatabaseUrl`、`senderAccountsDatabaseUrl`、`batchSize`（可选，默认 20）。
  - `schedule.timeSlots[]` 通过 `industryId` 绑定到某个行业；**当前落在哪个时段，就由 `getIndustryForNow(schedule)` 得到该时段对应的行业**。
- **Queue Sender 进程**：每轮调用 `getIndustryForNow(schedule)`，若返回行业且 `type === "queue"`，则用该行业的 `queueDatabaseUrl`、`senderAccountsDatabaseUrl`、`batchSize` 拉取并发送；否则本轮回空转 sleep。
- **结果**：「当前用哪个 Queue」= 当前时间所在时段绑定的那个 queue 行业。要配置多个 Queue 且不同时段用不同库，需要建多个 queue 行业并在时间区间里绑定不同 industryId。

## 期望（你的描述）

1. **配置来源**：和 Reply Tasks 一样，**在页面进行配置**（即独立于 schedule 的配置入口与存储）。
2. **配置内容**：与现在的 queue 类型一致——即每条包含：Queue 数据库 URL、发件人库 URL、每批条数（可选）等。
3. **可配置多个**：支持多条 Queue 配置（类似 Reply Tasks 的 entries 列表）。

## Reply Tasks 的对照（便于对齐）

- **存储**：独立 JSON 文件 `reply-tasks.json`（路径可 env `REPLY_TASKS_CONFIG`）。
- **结构**：`{ entries: [ { reply_tasks_db_id, sender_accounts_database_url } ], selected_index: number }`。
- **API**：`GET/POST /api/reply-tasks/config`；列表/发送等用 `selected_index` 指「当前选中的库」。
- **UI**：Reply Tasks 独立 tab，列表展示 entries，可「选中 / 编辑 / 删除 / 添加」；自动发送进程用 `loadReplyTasksConfigOrDefault()` 取配置，按 `selected_index` 取当前库。

## 已拍板

1. **多条时用哪条**：**每轮跑所有**——每轮按顺序对每条配置执行一轮拉取+发送（共用同一套按发送者的每日节流）。
2. **时段**：**完全不再看 schedule 时段**；Queue Sender 启停仅由进程开/关控制，有配置就按固定间隔轮询。
3. **字段**：在现有内容基础上**增加显示名**；每条：显示名、Queue 数据库 URL、发件人库 URL、每批条数（可选）。
4. **存储与 API**：**queue-sender.json** + **GET/POST /api/queue-sender/config**。
5. **schedule 中的 queue 行业**：**废除**——Queue Sender 只读新配置；schedule 不再支持 type=queue 行业（从 schema/校验/UI 移除）。

---

## 实现要点

### 配置结构与模块

- **文件**：`queue-sender.json`（路径可 env `QUEUE_SENDER_CONFIG`，默认项目目录下）。
- **结构**：`{ entries: [ { name: string, queue_database_url: string, sender_accounts_database_url: string, batch_size?: number } ] }`（字段名 snake_case，与 reply-tasks 一致）。
- **新模块**：`src/queue-sender-config.ts`——`QueueSenderEntry`、`QueueSenderConfig`、`loadQueueSenderConfigOrDefault`、`saveQueueSenderConfig`、`validateQueueSenderConfig`，形态对齐 `reply-tasks-config.ts`。

### Queue Sender 进程

- **不再**依赖 `schedule` 与 `getIndustryForNow`；启动时及每轮读取 `loadQueueSenderConfigOrDefault()`。
- **主循环**：固定间隔（如 1 分钟）一轮；若 `entries.length === 0` 则 sleep 后继续；否则**按顺序**对每条 entry 执行一次「拉取该 Queue 库 + 按发送者至多 1 条 + 每日节流」；多条 entry 共用同一 `senderStates`（同一发件人跨多条配置共享每日上限）。
- **runOneRound** 入参由「ScheduleIndustry」改为「QueueSenderEntry」（或含 `queueDatabaseUrl`、`senderAccountsDatabaseUrl`、`batchSize` 的最小接口），不再传 schedule/industry。

### Schedule 废除 queue 行业

- **schedule.ts**：从 `ScheduleIndustry` 移除 `queueDatabaseUrl`、`senderAccountsDatabaseUrl`、`batchSize`；`type` 仅保留 `playwright`（或移除 `queue` 枚举）；`validateIndustry` 不再处理 `type === "queue"`；`mergeSchedule`/normalize 不再读写 queue 字段。
- **兼容**：若现有 schedule.json 仍含 queue 行业，**忽略并继续**——加载时 strip 或跳过 `type === "queue"` 的行业（或将其当无效 industryId 处理），不报错，保证旧文件可加载。

### API 与 Dashboard

- **API**：`GET /api/queue-sender/config`、`POST /api/queue-sender/config`（body 为完整 config）；与现有 `status`/`start`/`stop` 并列。
- **UI**：新增「Queue 发信配置」卡片或独立 tab（与 Reply Tasks 类似）：列表展示 entries（显示名、Queue 库 URL、发件人库 URL、batchSize），支持添加/编辑/删除；**表单项需描述清楚**（显示名、Queue 数据库 URL、发件人库 URL、每批条数及默认值），避免误填。保存时调用 `POST /api/queue-sender/config`。Queue Sender 状态/启停/日志可保留在主视图或移入同一 tab。

### 其他

- **index.ts / 主流程**：若仍有根据 `getIndustryForNow` 判断「当前是否 queue 时段」的逻辑，需删除或改为仅 playwright；Queue Sender 独立进程不再与 schedule 时段绑定。
- **节流**：仍从 schedule 的 `queueThrottle.maxPerDay` 注入 env（或后续改为从 queue-sender 配置/全局设置读取），逻辑不变。

---

## 已拍板（补充）

- **配置字段命名**：与 reply-tasks **一致**，使用 **snake_case**（`name`、`queue_database_url`、`sender_accounts_database_url`、`batch_size`）；**页面上配置时要描述清楚**各字段含义（如：显示名、Queue 数据库 URL、发件人库 URL、每批条数），避免用户填错。
- **已有 schedule 含 queue 行业**：**忽略 queue 行业并继续**——加载 schedule 时若存在 `type === "queue"` 的行业，不报错，将其忽略或 strip 后按仅含 playwright 行业处理，保证旧 schedule.json 仍可加载。
