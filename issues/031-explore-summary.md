# Warmup Executor + 移除 Inbound/Reply — 探索结论与剩余确认

**目的**：在已收口字段名、枚举、依赖、BandWidth、Credential、Dry Run 口径的前提下，对需求与代码做一次完整复读，锁定实现边界，并标出**唯一仍需你确认**的点与若干**建议实现选择**（你可直接采纳或微调）。

---

## 一、已完全锁定的口径（可直接编码）

以下均按你给出的最终口径执行，不再分歧。

| 维度 | 结论 |
|------|------|
| **字段名** | Queue / Execution Log / Conversation Event Log 三张表的读写，严格使用你提供的列名与枚举值（含 `Platform (Legacy)` 括号、`Event Type` Title Case 与 `event_type` 小写下划线等）。 |
| **Queue Status** | 仅 `Pending` / `Sent` / `Failed` / `Cancelled`；Dry Run 成功也写 `Sent`（表示「该条已被执行器成功处理」）。 |
| **依赖满足** | 仅当「同库中 `Task ID = depends_on_task_id` 的那一行 `Status = Sent`」才视为依赖满足；上游 `Failed`/`Cancelled` 或找不到上游 → 当前任务写 `Failed` + 对应 `current_step`/`next_step_rule`。 |
| **Credential 可执行** | `executor_enabled = true` 且 `credential_status = "valid"`；仅此一种可执行。 |
| **BandWidth gate** | 优先走 Credential Registry → BandWidth Detail relation；无 relation 时 fallback：`account = actor_mailbox_id` + `platform = Email` + `action_type` 映射（仅 `Send`/`Reply` 做 action_type 强匹配；Open/Star/Add Contact/Wait 不按 action_type 做强 gate）。 |
| **Dry Run 幂等 ID** | `external_event_id` 必生成：`dryrun:<executor_run_id>:<queue_task_id>:<event_type>`；`message_id` 在 Send/Reply 用 `dryrun-msg:<queue_task_id>`，其余可空。 |
| **常量** | 代码中抽成常量：Status、audit_decision、依赖满足条件、Credential 条件、Dry Run ID 格式。 |

---

## 二、代码与配置现状（删除/替代范围）

### 2.1 将删除的链路（Inbound Listener + Reply Tasks）

- **进程与入口**：`src/inbound-listener.ts`、`src/reply-tasks-auto-sender.ts`
- **Dashboard runner**：`src/dashboard-inbound-listener-runner.ts`、`src/dashboard-reply-tasks-auto-sender-runner.ts`
- **Notion 读写**：`src/notion-inbound.ts`、`src/notion-reply-tasks.ts`
- **配置与发送**：`src/inbound-listener-config.ts`、`src/reply-tasks-config.ts`、`src/reply-tasks-send.ts`
- **配置文件**：`inbound-listener.json` / `.example`、`reply-tasks.json` / `.example`
- **Server**：移除所有 `/api/inbound-listener/*`、`/api/reply-tasks/*`、`/api/reply-tasks-auto-send/*` 及 shutdown/start 中对上述 runner 的引用；移除自动拉起 Inbound Listener 的 `setInterval` 与 listen 回调内启动逻辑
- **Dashboard HTML**：移除 Tab「Inbound Listener」「Reply Tasks」、主视图中的 Inbound 状态与「手动重启 Inbound Listener」、所有 Reply Tasks 配置/列表/发送/自动发送 UI 与弹窗、相关 JS 与 API 调用
- **README**：删除 Inbound Listener 与 Reply Tasks 的说明段落

**保留**：`src/gmail-read.ts`、`src/gmail-send.ts`、`src/zoho-mail.ts`、`src/m365-mail.ts` 保留；`gmail-read` 的 `InboundMessageParsed` 被 zoho/m365 复用，且后续 Warmup Receiver-side 可能用到读信，故不删。

### 2.2 将被完全替代的链路（Queue Sender → Warmup Executor）

- **进程入口**：`src/queue-sender.ts` 改为由 **Warmup Executor** 入口替代（例如 `src/warmup-executor.ts` 或保留路径但重写逻辑）。
- **Notion 层**：当前 `src/notion-queue.ts` 的「旧 Queue 模型」（Email Status、Planned Send At、Sender Account、发件人库凭据）不再使用；由新的 **Warmup Queue 读/写 + Credential Registry + BandWidth Detail + Execution Log + Conversation Event Log** 模块替代。旧 `fetchSenderCredentials` 与旧 `queryQueuePending`/`updateQueuePage*` 不再被 Warmup 使用。
- **配置**：`queue-sender.json` 升级为 Warmup Executor 配置，支持 6 个 Notion 数据层 URL（Email Warmup Queue、Credential Registry、Execution Log、Warmup Conversation Event Log、BandWidth Detail、Warmup Mailbox Pool）；`queue-sender-config.ts` 改为 Warmup 配置的校验与读写。
- **Dashboard**：Queue 发信 Tab 改为「Warmup Executor 配置」；启停与日志仍为「Warmup Executor」进程（原 Queue Sender 子进程位置）；主视图「启动」时仍可一并启动 Warmup Executor（与现有行为一致）。节流从 `schedule.queueThrottle` 注入可保留或改为 Warmup 专用配置，按你后续决定。

### 2.3 依赖与调用关系

- **Reply Tasks / Inbound** 使用过 `notion-queue.fetchSenderCredentials`；删除后该函数仅剩 Queue Sender 使用，而 Queue Sender 被整体替代，故 **`notion-queue.ts` 中发件人库相关逻辑可一并移除或替换**，由 Warmup 的 Credential Resolver（读 Registry）取代。
- **schedule.json** 中的 `queueThrottle` 目前被 Dashboard 在「启动」与 Queue Sender 启动时注入；Warmup 若不再按「每日上限」节流，可改为从 Warmup 配置读取或移除，实现时再定。

---

## 三、唯一仍需你确认的语义：Execute Window

消费条件中有「当前时间进入 `Execute Window`」，且字段名为 **`Execute Window`**。

Notion 的 Date 属性可能是：

- **仅开始日期（date start）**，或  
- **开始 + 结束（date range）**

需要你拍板一种解释，代码才能实现「进入窗口」的判断：

1. **若为日期区间（start + end）**  
   - 约定：`now` 落在 `[Execute Window.start, Execute Window.end]` 内（含边界）才算「进入窗口」。  
   - 若只有 start 无 end：视为「从 start 开始无截止」即 `now >= start`，或视为无效/不满足，请二选一。

2. **若为单一日期的「时刻」**  
   - 约定：例如「Execute Window 表示可执行的最早时间」，则 `now >= Execute Window` 即进入窗口；或「表示执行日期」，则「当天日期等于该日期」即进入窗口。  
   - 请明确：是「最早执行时间」还是「执行日」或其它。

**请回复**：Execute Window 在 Notion 中是「单日」「日期范围」还是「日期+时间」？以及「进入窗口」的精确规则（例如：`start <= now <= end` 或 `now >= start` 无 end）。确认后即可实现过滤逻辑，无其它依赖。

---

## 四、建议实现选择（可直接采纳或微调）

以下为在未再收到新约束前提下的建议，若你无异议即按此实现。

### 4.1 `planned_event_type = Wait` 的落库

- **Execution Log / Conversation Event Log** 的枚举中均无 “Wait”。
- **建议**：对 `Wait` 仅更新 Queue（`Status = Sent`、`executor_run_id`、`last_executor_sync_at`、`current_step`/`next_step_rule`），**不**写入 Execution Log 与 Conversation Event Log。
- 若你希望 Wait 也留一条「已等待」记录，再约定一个 event_type/Event Type 取值（例如复用某已有枚举或新增）。

### 4.2 `executor_run_id` 作用域

- 格式：`exec-YYYYMMDD-NNNN`。
- **建议**：**每轮轮询一个 run id**（即每次从 Notion 拉取候选并处理的一轮生成一个新 id）。这样同一轮内处理的多条 queue 共享同一 `executor_run_id`，便于排查与幂等；若你希望「进程生命周期内唯一」也可改为进程启动时生成一次。

### 4.3 Dry Run 的 `content_excerpt`

- Phase 1 不真实发信，无真实邮件内容。
- **建议**：写 Execution Log / Conversation Event Log 时，`content_excerpt` 使用固定占位，例如 `"(dry run)"` 或 `"(dry run: <planned_event_type>)"`，避免空或未定义。

### 4.4 Execution Log 的 `action_type` 与 `chain_step_no`

- `action_type`：Send → `Email Send`，Reply → `Email Reply Handling`；Open/Star/Add Contact/Wait 无直接对应。
- **建议**：Open/Star/Add Contact 暂写 `Email Reply Handling`（或 Notion 允许空则留空）；Wait 不写 Log（见上）。若 Notion 中 `action_type` 为必填且无更合适选项，再统一一个占位值。
- `chain_step_no`：Queue 无步号字段。
- **建议**：V1 写 `0` 或从 `chain_plan_json` 解析（若结构固定）；否则固定 `0`。

### 4.5 BandWidth Detail / Credential Registry 的 Notion 列名

- 你已给出 Queue、Execution Log、Conversation Event Log 的最终列名；Registry 与 BandWidth 引用的是文档 10.1 / 10.5。
- **建议**：代码按文档 10.1 / 10.5 的列名实现（如 `mailbox_id`、`account`、`executor_enabled`、`credential_status`、`allowed`、`risk_state`、`readiness_status`、`cooldown_until` 等）；若实际 Notion 中列名与文档不一致，再以「当前库显示名」为准做一次配置或常量替换。

### 4.6 Warmup Mailbox Pool 在 Phase 1 的角色

- 配置中有 6 个 DB，包含 Warmup Mailbox Pool。
- **建议**：Phase 1 Dry Run 中 Pool 为**可选**：若配置了 Pool URL，可读取 Provider / Health State 做额外检查；未配置则不读，不影响「拉取 Queue → 资格判断 → 凭据解析 → 模拟执行 → 回写」主流程。

### 4.7 幂等：事件去重

- 去重键：`queue_task_id + event_type + external_event_id`。
- **建议**：写 Execution Log / Conversation Event Log 前，用 Notion 查询「同库中是否已存在相同 `queue_task_id` + `external_event_id`（及 event_type/Event Type 若可查）」；若已存在则跳过写入，避免重复落库。

### 4.8 Direction 映射

- **建议**：Send / Reply（sender-side）→ `Outbound`；Open / Star / Add Contact（receiver-side）→ `Passive Interaction`；Wait 若写 Log 则用 `Outbound`，否则不写。

---

## 五、与现有代码的衔接点

- **Gmail/Zoho/M365 发信**：Phase 2 真实 Send/Reply 时，Warmup Executor 从 Credential Resolver 拿到的是「与当前 Registry 行一致的」provider、refresh_token/access_token 等；可继续复用 `gmail-send.ts`、`zoho-mail.ts`、`m365-mail.ts` 的既有接口，仅把「凭据来源」从发件人库改为 Registry 解析结果。
- **Dashboard 启停与日志**：沿用现有「子进程 + tree-kill + 最近 N 次 run logs」模式，仅把子进程入口从 `src/queue-sender.ts` 改为 Warmup Executor 入口；API 路径可保留 `/api/queue-sender/*` 或改为 `/api/warmup-executor/*`，前端文案改为「Warmup Executor」。
- **主视图「启动」**：当前会同时启动 Playwright 与 Queue Sender；改造后改为同时启动 Playwright 与 Warmup Executor，不再启动 Inbound / Reply Tasks。

---

## 六、结论与下一步

- **已收口**：三张表的字段与枚举、Status 与依赖规则、Credential/BandWidth/Dry Run 口径、失败与依赖阻塞的写回方式，均可直接按你的说明实现。
- **唯一待你拍板**：**Execute Window** 的 Notion 类型与「进入窗口」的精确定义（见第三节）。
- **建议选择**：第四节中的 Wait 不写 Log、executor_run_id 每轮一个、content_excerpt 占位、action_type/chain_step_no、Pool 可选、事件去重与 Direction 映射，均可在你无异议时按建议实现；若有不同偏好，直接说明即可替换。

你确认 Execute Window 语义后，我处将**不再保留其它需求层面的疑问**，可进入 `/create-plan` 输出「删除 Inbound/Reply + Warmup Executor 替代 Queue Sender」的完整实现计划（含配置升级、Dry Run Phase 1、Dashboard 与 README 清理）。
