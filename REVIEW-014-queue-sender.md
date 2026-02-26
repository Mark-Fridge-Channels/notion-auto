# Code Review: Queue Sender (PLAN-014)

## ✅ Looks Good

- **Logging**：统一使用 `logger`，无 `console.log`，上下文清晰（pageId、messageId、行业等）。
- **TypeScript**：无 `any`，接口定义完整（`QueueItem`、`ScheduleIndustry`、Gmail 类型等）。
- **生产就绪**：无硬编码密钥，敏感配置来自 env；无遗留 TODO/debug。
- **架构**：Queue 与 Playwright 共用 schedule/Dashboard 模式，Notion/Gmail 模块职责清晰。
- **错误与重试**：Queue 单条发送重试 3 次，区分瞬时错误并写回 Stop Reason；主循环 try/catch 防止崩溃。
- **幂等与过滤**：Pending + 四 Flag + 非空字段，Sent At Last / Message ID Last 防重复发送；Planned Send At 在应用内再次校验。
- **Followup**：正确使用 threadId + Message ID Last，In-Reply-To/References 符合 RFC。

---

## ⚠️ Issues Found（已修复或建议）

### 已修复

- **[LOW]** [[src/gmail-send.ts](src/gmail-send.ts)] - `buildCold1Mime` 中未使用的 `boundary` 变量  
  - **Fix**：已删除该变量。

- **[LOW]** [[src/queue-sender.ts](src/queue-sender.ts)] - 冗余的 “Missing Thread ID for followup” 分支（`isFollowup` 为 true 时 `threadId` 已保证非空）  
  - **Fix**：已删除冗余分支。

- **[MEDIUM]** [[src/queue-sender.ts](src/queue-sender.ts)] - `runBatch` 中单条 `processOne` 抛错会导致整批中断  
  - **Fix**：已在 `for (const item of items)` 内对 `processOne` 增加 try/catch，单条失败仅打日志并继续下一条。

- **[LOW]** [[src/notion-queue.ts](src/notion-queue.ts)] - 未使用的 `getCheckbox` 函数  
  - **Fix**：已删除。

- **[LOW]** [[src/dashboard-queue-sender-runner.ts](src/dashboard-queue-sender-runner.ts)] - `configPath` / `getSchedulePath` 未使用（子进程自行加载 schedule）  
  - **Fix**：已移除未使用变量与 import。

### 建议（未改代码）

- **[MEDIUM]** **Notion 发件人库属性名**：代码使用 `props["password"]`；若 Notion 中列名为 `Password`（首字母大写），需在文档中说明与库中一致，或兼容 `password`/`Password`。
- **[LOW]** **邮件头安全**：From/To/Subject 若含换行等需防注入；当前对 Subject 做了 `\n` → 空格，From/To 在典型 Notion 可控内容下可接受，若有用户自由输入可再加固。

---

## 📊 Summary

- **Files reviewed**: schedule.ts, notion-queue.ts, gmail-send.ts, queue-sender.ts, dashboard-queue-sender-runner.ts, server.ts（Queue API + Dashboard 片段）, index.ts
- **Critical issues**: 0
- **Warnings**: 1 个 MEDIUM（Notion 属性名文档/兼容）、1 个 LOW（邮件头加固），其余已修复
- **修复项**: 5 处（死代码、冗余分支、批处理健壮性、未使用变量/导入）
