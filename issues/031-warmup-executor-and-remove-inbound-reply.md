## Issue: 移除 Inbound Listener / Reply Tasks；按新口径改造 Queue Sender 为 Warmup Executor

### TL;DR
当前项目仍包含 `Inbound Listener` 与 `Reply Tasks` 两条常驻链路，并且 `Queue Sender` 仍从“发件人库（password=refresh_token）”直接取凭据发信。需要按最新《Warmup Executor》口径：
- 删除 Inbound / Reply Tasks 相关代码与 Dashboard 配置入口
- 将 Queue 执行改为 **Warmup Executor**：只消费 `Keep` 的 warmup queue items，通过 `actor_mailbox_id` 命中 **Warmup Account Credential Registry** 解析凭据，并回写 **Queue + Execution Log + Warmup Conversation Event Log**（Queue 不再承载明文密码/refresh token/session）

---

### 类型 / 优先级 / 预估工作量
- **Type**: feature + cleanup
- **Priority**: normal（如 Warmup 已接入生产可上调为 high）
- **Effort**: medium ~ large（涉及 Dashboard、Notion schema、执行链路重构）

---

### 当前状态（As-Is）
#### 1) 仍存在 Inbound Listener / Reply Tasks
- 有独立配置文件：`inbound-listener.json`、`reply-tasks.json`
- 有 Dashboard runner：`src/dashboard-inbound-listener-runner.ts`、`src/dashboard-reply-tasks-auto-sender-runner.ts`
- 有 Notion 读写模块：`src/notion-inbound.ts`、`src/notion-reply-tasks.ts`

#### 2) Queue Sender 仍使用“发件人库 password=refresh_token”模式
（关键现状文件，供实现对照）
- `src/queue-sender.ts`：每分钟轮询 Notion Queue，按 `Sender Account` 查发件人库并发信，回写原 Queue 字段（Thread/MessageId/Done 等）
- `src/notion-queue.ts`：`fetchSenderCredentials()` 从发件人库读取 `Email + password + Provider`（password 被当作 refresh_token）
- `src/queue-sender-config.ts`：`queue-sender.json` 仅配置 `queue_database_url` + `sender_accounts_database_url`

---

### 目标状态（To-Be，按《Warmup Executor》正式口径）
#### 1) 删除不再需要的两条链路
- 移除 Inbound Listener 与 Reply Tasks 的：
  - 常驻进程入口、配置结构、Notion 读写、Dashboard UI/路由/runner
  - 文档与 README 中相关说明（避免误导）

#### 2) 引入 Warmup Executor（取代/重命名现有 Queue Sender）
Warmup Executor 必须：
- **只消费**满足条件的 `Email Warmup Queue` rows：
  - `Legacy Task Type = Warmup`
  - `Platform (Legacy) = Email`
  - `Status = Pending`
  - `audit_decision = Keep`
  - `audit_run_id` 非空、`audited_at` 非空
  - 当前时间进入 `Execute Window`
  - 若 `depends_on_task_id` 非空，则依赖任务已完成
- **凭据解析必须走 Registry**：
  - `Queue → actor_mailbox_id → Warmup Account Credential Registry`
  - 优先 `secret_ref / session_ref / auth_config_json`；仅过渡期允许读取 `password / refresh_token / access_token`
- **执行前保护**：读取 `BandWidth Detail`，出现任一即拒绝执行：
  - `allowed = false` 或 `readiness_status = Paused` 或 `risk_state = Red` 或 `cooldown_until` 未到
- **执行动作映射**（最小闭环建议先 Dry Run）：
  - `planned_event_type`: `Send / Reply / Wait / Open / Star / Add Contact`
  - Sender-side：`Send / Reply / Wait`
  - Receiver-side：`Open / Reply / Star / Add Contact`
- **回写三处 Notion**（写入优先级：Queue → Execution Log → Conversation Event Log）：
  - Queue：`Status`、`current_step`、`next_step_rule`、`executor_run_id`、`last_executor_sync_at`
  - Execution Log：粗粒度事实账本（success/failed 等）
  - Warmup Conversation Event Log：线程/互动级事件
- **幂等**：
  - Queue 主键：`Task ID`
  - 事件去重键：`queue_task_id + event_type + external_event_id`

---

### 范围边界（明确“不做什么”）
- 不负责 warmup 计划生成（Agent 4）
- 不负责审计裁决（Agent 4.5）
- 不做健康聚合与长期风险策略
- 不直接修改 `BandWidth Detail`（只读 gate）
- 不把明文凭据继续放在 Queue（安全边界）

---

### 建议实施顺序（最小可落地）
#### Phase 1：Dry Run（不真实发信）
- 拉取候选 queue items（仅 Keep + Pending + window + depends_on 满足）
- 做资格判断（含 BandWidth Detail gate）
- 解析 actor 凭据（Credential Registry）
- 按 planned_event_type 分派但不触发外部邮箱动作
- 回写 Queue（executor_run_id / last_executor_sync_at / current_step 等）与两张 log（写入结构先跑通）

#### Phase 2：打通 Sender-side（先 `Send` / `Reply`）
- 结合现有 `gmail-send.ts` / `zoho-mail.ts` / `m365-mail.ts`，改为从 Registry 的解析结果取 token/secret

#### Phase 3：Receiver-side（`Open` / `Add Contact` 等）
- 如暂时无法自动化 receiver 动作，可先落为“记录事件 + 状态推进”（但需要明确与审计/回放的契约）

#### Phase 4：幂等、重试与错误分层
- Notion API 临时失败可重试
- provider 超时可重试
- 不可重试：audit 非 Keep / cooldown 未到 / 凭据无效 / depends_on 未完成

---

### 风险与注意事项
- **Schema 风险**：现有 Queue Sender 读写字段与新 warmup queue（`planned_event_type`、`audit_*`、`Execute Window` 等）不是同一套字段；需要明确新库字段名与类型（Select/Status/Text/Date）一致性。
- **安全风险**：历史逻辑把 refresh_token 放在发件人库 `password` 字段；新口径要求从 Credential Registry 读取（并优先 secret_ref），迁移期要避免“同时读两处”造成混乱。
- **行为变更**：旧逻辑基于 `Planned Send At` 的 5 分钟窗口 + 每日上限节流；新 Executor 的窗口基于 `Execute Window` 且增加 BandWidth gate，吞吐会变化。

---

### 待澄清（请你一次性回答，避免来回）
1) **Warmup Executor 是“完全替代 Queue Sender”还是“新增一个并行进程”**？（推荐替代：减少两套执行器并存）
2) `queue-sender.json` 需要升级为 Warmup Executor 配置时，是否按文档的 6 个 Notion 数据层 **全部可配置**？
   - Email Warmup Queue
   - Warmup Account Credential Registry
   - Execution Log
   - Warmup Conversation Event Log
   - BandWidth Detail
   - Warmup Mailbox Pool
3) Phase 1 Dry Run 的“回写 Queue/Logs”是否允许落真实数据（用于校验链路），还是需要写到单独的 sandbox 数据库？

