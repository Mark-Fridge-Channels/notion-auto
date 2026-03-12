# Feature Implementation Plan

**Overall Progress:** `92%`

## TLDR
移除当前项目中不再需要的 `Inbound Listener` 与 `Reply Tasks` 全链路；将现有 `Queue Sender` 完全替换为新的 `Warmup Executor`。V1 先在真实 Notion 库上跑通 Dry Run：严格按当前 Notion 显示字段名读取 `Email Warmup Queue`、解析 `Credential Registry` 与 `BandWidth Detail`、执行资格判断、推进 Queue 状态，并回写 `Execution Log` 与 `Warmup Conversation Event Log`，但不真实发送邮件。

## Critical Decisions
- Decision 1: `Warmup Executor` 完全替代 `Queue Sender` - 避免两套执行器并存，统一 Queue 消费、凭据解析和日志回写边界。
- Decision 2: 以当前 Notion **显示字段名**为唯一真值 - 现有代码本就按字符串硬编码读写，V1 不引入额外字段映射层，降低迁移复杂度。
- Decision 3: V1 Dry Run 在**真实库**执行且成功写 `Status = Sent` - Queue 的状态语义定义为“该 item 已被执行器成功处理”，而不是“邮件一定已真实发出”。
- Decision 4: 依赖满足唯一口径为“上游 `Task ID = depends_on_task_id` 且 `Status = Sent`” - `Failed` / `Cancelled` / 缺失依赖都视为当前任务不可执行并写失败。
- Decision 5: `Execute Window` 规则固定为：有 `start + end` 时 `start <= now <= end`；仅有 `start` 时 `now >= start` - 与当前 Queue 的 date 字段语义一致。
- Decision 6: Credential 可执行条件固定为 `executor_enabled = true && credential_status = "valid"`；BandWidth gate 优先走 Registry relation，fallback 到文本匹配 - 优先安全与确定性。
- Decision 7: Dry Run 必须生成 synthetic `external_event_id`，`Send/Reply` 生成 synthetic `message_id` - 满足幂等、真实落库和后续排障需求。
- Decision 8: Provider 执行采用 adapter 边界；V1 先确保 Dry Run 全链路跑通，未支持的 provider/action 组合 fail closed - 避免在能力未落地时伪造真实执行。

## Tasks:

- [x] 🟩 **Step 1: 清理旧链路与入口**
  - [x] 🟩 识别并移除 `Inbound Listener` 与 `Reply Tasks` 的源码、配置、runner、Dashboard API 与前端 UI。
  - [x] 🟩 从 `server` 启停与 watcher 逻辑中删除 Inbound / Reply Tasks 的自动拉起与状态轮询。
  - [x] 🟩 清理旧配置文件与示例文件的引用，保留仍被 Warmup 复用的邮件 provider 基础能力文件。

- [x] 🟩 **Step 2: 定义 Warmup Executor 配置与常量**
  - [x] 🟩 将 `queue-sender.json` 升级为 Warmup Executor 配置，支持 6 个 Notion 数据层 URL。
  - [x] 🟩 抽取 Queue Status、Audit Decision、Event Type、Direction、Credential Eligibility、Dry Run ID 规则等常量。
  - [x] 🟩 明确 `subject`、`body`、`reply_to_message_id`、`Execute Window`、依赖状态等输入契约。

- [x] 🟩 **Step 3: 重写 Notion 访问层**
  - [x] 🟩 新建/重构 Queue Reader：读取 `Email Warmup Queue`，按 `Pending + Keep + Warmup + Email + Execute Window + depends_on` 过滤候选。
  - [x] 🟩 新建 Credential Resolver：通过 `actor_mailbox_id` 命中 `Warmup Account Credential Registry`，并优先 relation/secret-style 字段解析凭据。
  - [x] 🟩 新建 BandWidth Guard：优先从 Registry relation 命中 `BandWidth Detail`，必要时 fallback 到文本匹配。
  - [x] 🟩 新建 Queue Writer / Execution Log Writer / Conversation Event Log Writer，并内置幂等查询。

- [x] 🟩 **Step 4: 实现 Dry Run 执行器主流程**
  - [x] 🟩 建立常驻轮询主循环，替代现有 `Queue Sender` 进程入口与轮询逻辑。
  - [x] 🟩 实现资格判断：审计、状态、执行窗口、依赖、credential、BandWidth、重复执行保护。
  - [x] 🟩 实现动作分派：`Send` / `Reply` / `Wait` / `Open` / `Star` / `Add Contact` 在 Dry Run 下的统一状态推进。
  - [x] 🟩 对成功项回写 Queue（至少 `Status`、`current_step`、`next_step_rule`、`executor_run_id`、`last_executor_sync_at`），并写入两张 log。
  - [x] 🟩 对失败项回写可复盘的失败原因与阻塞状态（例如缺失依赖、凭据无效、窗口未到、unsupported provider 等）。

- [ ] 🟨 **Step 5: 保留真实执行扩展边界**
  - [x] 🟩 为 Gmail / Zoho / M365 建立 provider adapter 接口，复用现有发信基础能力文件，但本步不打开真实发送。
  - [x] 🟩 将 `reply_to_message_id` 纳入真实 `Reply` 的统一输入契约，为后续 Phase 2 执行做准备。
  - [ ] 🟨 明确未支持 provider 或未落地动作的 fail-closed 分支，避免假执行。

- [x] 🟩 **Step 6: 改造 Dashboard 与文档**
  - [x] 🟩 将 Dashboard 中的 `Queue 发信配置` 改为 `Warmup Executor 配置`，同步更新状态展示、日志 tab 与启停文案。
  - [x] 🟩 删除 `Inbound Listener` / `Reply Tasks` 的 tab、按钮、弹窗、API 调用与相关前端状态管理代码。
  - [x] 🟩 更新 `README.md`、`env.example`、示例配置说明，去掉旧链路说明并写清 Warmup Executor 的 V1 口径。

- [ ] 🟨 **Step 7: 执行前自检与回归验证**
  - [x] 🟩 校验新配置文件、Dashboard API、Warmup 主循环、Notion 读写路径在本地可启动。
  - [ ] 🟨 覆盖关键场景：可执行、窗口未到、依赖未满足、依赖失败、credential 不可用、BandWidth 拦截、重复执行。
  - [x] 🟩 确认 recently edited files 无新增 lint/type 问题，并确保删除旧链路后无残留引用。

