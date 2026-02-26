# Queue Sender：从 Notion Queue 数据库取待发任务并发送、回写结果

**类型**：feature  
**优先级**：normal  
**工作量**：large

---

## TL;DR

行业与任务链支持第二种类型：用户提供 **Notion Queue 数据库** URL，程序读取该库中 Email Status=Pending 的项，按每条 item 的规则（**Sender Account** 发信人、**Planned Send At** 发信时间、收件人、主题与正文；若有 Thread ID 则沿用该 thread 发送），执行出站发信；发信成功/失败后按文档说明回写 Queue（状态与结果字段 + **错误原因写入 Stop Reason（text）**）。同步 Prompt 由外部处理，本仓库不实现。发信凭据来自**发件人库**（按 Sender Account 匹配 Email，取 Email + password）；**发件人库各自用**，每个 Queue 行业配置自己的发件人库 URL（senderAccountsDatabaseUrl）。Dashboard 与 Playwright 共用「最近运行日志」并**合并展示**（tabs 或标签区分）。

---

## 当前行为 vs 期望行为

| 项目 | 当前 | 期望 |
|------|------|------|
| 行业任务链类型 | 仅一种：Playwright 打开行业 Notion Portal URL，按任务链 typeAndSend | **两种**：① 现有 Playwright 任务链；② **Queue 型**：用户配置 Queue 数据库 URL，程序只读写该 Notion 库，取 Pending 任务发信并回写 |
| 出站发信来源 | 无；仅有 SMTP 告警邮件 | 从 Queue 取 Pending item，按 item 字段（**Sender Account**、**Planned Send At**、收件人、主题与正文、可选 Thread ID）发送；仅当当前时间 ≥ Planned Send At 才发 |
| 发信后处理 | — | 成功：按文档说明写 Done + Sent At Last / Thread ID / Message ID Last / Subject Last 等。同步 Prompt 不在此实现。 |
| 发信失败处理 | — | Queue 调整状态（Needs Review、回滚 Email Status、可选 Stop Flag），**错误原因写入 Stop Reason（text）**。同步 Prompt 不在此实现。 |

**Queue Sender 范围**：只读写用户指定的 Notion Queue 数据库（示例：<https://www.notion.so/ad4abefd380545e2b3c60358f79e5a68?v=7dd8d7077f534fd09c8acbaa11903c78>），将 Email Status=Pending 的任务发出并回写发送结果字段。

---

## 需求要点

1. **Queue 数据源**：用户提供 Notion Queue 数据库 URL；程序通过 Notion API 读取该库，筛选 `Email Status = Pending` 的项；**仅当当前时间 ≥ Planned Send At 才发送**。
2. **每条 item 的发送规则**：从 item 读取 **Sender Account**、**Planned Send At**、收件人、主题与正文。发信凭据来自**发件人库**（URL 见探索文档）：用 Queue 的 Sender Account 匹配发件人库的 **Email** 字段，取该行的 **Email** + **password** 发信。若存在 `Thread ID`（Followup）则必须在该 thread 内发送，且需 **threadId + In-Reply-To/References**（References 需 **Message ID Last**）；缺 threadId 时不发，标 Needs Review 并回滚状态。否则新会话（Cold1）。
3. **发信成功**：按文档说明回写 Queue（Done + Sent At Last / Thread ID / Message ID Last / Subject Last，Needs Review=false）。同步 Prompt 不在此实现。
4. **发信失败**：Queue 调整状态（Needs Review、Email Status 改回 Pending、可选 Stop Flag），**错误原因必须写入 Queue 的 Stop Reason（text）字段**。同步 Prompt 不在此实现。
5. **与现有类型并存**：行业配置区分「Playwright 任务链」与「Queue 数据库」两种类型；配置与时段均在 Dashboard「行业与任务链」+ 现有时段配置中完成；Queue Sender 为常驻服务，由 Dashboard 控制何时执行，执行时复用现有时段配置。

---

## 涉及文件（建议）

| 文件/模块 | 修改点 |
|-----------|--------|
| `src/schedule.ts` | 行业类型区分：支持「Queue 型」配置（如 `queueDatabaseUrl` 或类型字段）；校验与默认值 |
| 新模块 `src/queue-sender.ts`（或类似） | 从 Notion API 读 Queue 库、解析 Pending 项；按 item 调用发信（邮箱/时间/收件人/内容/threadId）；回写 Queue 字段（Done/Needs Review + 各结果字段） |
| 发信实现 | Gmail API（Followup 时 threadId + In-Reply-To/References，需 Message ID Last）；凭据来自**发件人库**（Notion），用 Queue 的 Sender Account 匹配发件人库的 **Email**，取 **Email** + **password**。 |
| 同步 Prompt | 本仓库不实现。 |
| Queue Sender 入口 | 独立常驻进程（如 `queue-sender.ts`），由 Dashboard 启动/停止；按当前时段绑定的行业是否为 Queue 类型决定是否执行；与 `index.ts` Playwright 流程分离。 |
| `src/server.ts` / Dashboard | 行业编辑：支持选择或填写 Queue 数据库 URL（及类型切换），与现有 notionUrl/任务链并存或二选一 |
| Notion 集成 | 引入 `@notionhq/client` 或等效，通过 Integration Token 读/写 Queue 数据库（需 env 配置 NOTION_API_KEY、Queue 库授权） |

---

## 实现要点（简要）

- **Notion Queue 字段名**：**Sender Account**、**Planned Send At**；Email Status、Sent At Last、Thread ID、Message ID Last、Subject Last、Needs Review、Stop Flag、**Stop Reason（text）**、Email、Email Subject、Email Body、Sequence Stage 等。**失败时错误原因必须写入 Stop Reason**。
- **发件人库**：**各自用**——每个 Queue 行业必填 **senderAccountsDatabaseUrl**；用 Queue 的 Sender Account 匹配该库 **Email** 字段，取 **Email** + **password** 发信。
- **Followup**：必须 **threadId + In-Reply-To/References**（需 **Message ID Last**）。缺 threadId 时：不发，Needs Review，回滚状态。Cold1 无 threadId，直接新会话。
- **回写**：按文档说明一直都写；失败时除状态外写 **Stop Reason**。
- **同步 Prompt**：本仓库不实现；只把 Queue 状态与回写字段写对。
- **调度**：复用现有时段配置；Queue Sender 常驻，Dashboard 控制何时执行；仅在当前时段绑定行业为 Queue 类型时执行该 Queue 的发送。

---

## 风险与备注

- **依赖**：Notion API（Queue 库 + 各行业发件人库）、Gmail API；发件人库 URL 每 Queue 行业配置，匹配方式见探索文档。**日志**：Queue Sender 与 Playwright 合并展示于同一块「最近运行日志」，用 tabs 或标签区分。
- **安全**：NOTION_API_KEY 从 env 读取；邮箱与 password 从发件人库（Notion）按 Sender Account→Email 匹配读取，不写死在代码中。
- **兼容**：现有 Playwright 任务链行业保持不变；新增 Queue 型为可选，不破坏现有 schedule 结构（通过类型或 URL 区分）。
