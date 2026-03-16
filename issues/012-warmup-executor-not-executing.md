# Warmup Executor 配置正常、Notion 有数据但不执行任务

**类型:** bug  
**优先级:** normal  
**投入:** medium  

---

## TL;DR

Warmup Executor 在 Dashboard 中配置正确，Notion 里 Queue / 凭据等数据也存在，但任务没有被实际执行。需要排查「候选过滤条件」与「单条处理跳过逻辑」是否导致所有数据被过滤或跳过。

---

## 当前现象 vs 期望

- **当前：** 配置正常、Notion 有数据，Executor 显示运行中，但无任务被执行（无执行日志/状态更新）。
- **期望：** 符合条件的 Queue 行应被消费并执行（发信/回信等），并回写 Queue 状态与 Execution Log。

---

## 可能原因（代码侧）

1. **Queue 候选过滤**（`queryWarmupQueueCandidates`，`src/notion-warmup.ts`）  
   以下任一不满足即不会进入候选列表：  
   - `Status` = `Pending`  
   - `Audit Decision` = `Keep`  
   - 已审计：`audit_run_id`、`audited_at` 有值  
   - **执行时间窗**：`Execute Window` 已开始且（若设了结束时间）未结束；若只有开始无结束，当前实现会认为窗口有效；若未设开始时间则 `isExecuteWindowActive` 返回 `false`，整行被跳过  
   - （已放宽：不再要求 `Task Type` / `Platform (Legacy)`，与当前 Notion 库无该字段的用法一致）  

2. **processOne 内跳过/失败**（`src/queue-sender.ts`）  
   - 已同步过：`executor_run_id` 或 `last_executor_sync_at` 已有值 → 直接 skip  
   - 依赖任务未就绪：`depends_on_task_id` 对应任务状态非 `Sent` → skip 或 fail  
   - 凭据：Credential Registry 中找不到对应 mailbox/account，或 `executor_enabled`/`credential_status` 不符合  
   - 动作要求：缺 subject/body/reply_to_message_id（按事件类型）→ fail  
   - 不支持的 provider / 不支持的 action → fail  
   - BandWidth Detail 缺失或带宽守卫（如 cooldown、allowed=false）→ fail  

3. **环境/进程**  
   - 子进程未真正跑在预期环境：如 `NOTION_API_KEY` 在 Executor 进程环境中未设置，会每轮打 "未配置 NOTION_API_KEY，Warmup Executor 跳过本轮" 并跳过  
   - 配置不完整：`queue_database_url` / `credential_registry_database_url` / `execution_log_database_url` / `conversation_event_log_database_url` / `bandwidth_detail_database_url` 任一为空会跳过该 entry（打 warn 日志）

---

## 建议排查步骤

1. 看 Warmup Executor 最近运行日志（Dashboard 或子进程 stdout/stderr）：是否有 "跳过本轮"、"配置不完整"、"credential_not_found"、"dependency_not_ready"、"already_synced" 等。  
2. 抽查一条未执行的 Queue 行：Status、Audit Decision、审计字段、Execute Window、依赖任务状态、对应 Credential 的 executor_enabled/credential_status、BandWidth 是否满足。  
3. 确认 Executor 进程的环境变量中 `NOTION_API_KEY` 已设置且与 Notion 集成一致。

---

## 涉及文件

- `src/notion-warmup.ts`：`queryWarmupQueueCandidates`、`isExecuteWindowActive`、`parseQueueItem`  
- `src/queue-sender.ts`：`runOneRound`、`processOne`、main 循环与 NOTION_API_KEY 检查  
- `src/queue-sender-config.ts`：配置加载与校验  
- `src/dashboard-queue-sender-runner.ts`：子进程启动（环境是否透传）  
- `src/server.ts`：Dashboard 拉取/展示 Warmup 运行日志

---

## 备注

- 若需「为何这条没被选中」的可观测性，可考虑在 Executor 中对「被过滤掉的行」打 debug 日志（例如 reason：status/audit/window/dependency/credential），便于后续类似问题快速定位。
