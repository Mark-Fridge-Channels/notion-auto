# Inbound Listener 探索：集成点与待澄清

**目标**：在不动手实现的前提下，搞清楚 Inbound Listener 与现有代码库的集成方式、依赖、边界与歧义，并列出需要确认的问题。

---

## 1. 现有代码库要点（与 Listener 相关）

### 1.1 Gmail

- **当前**：`src/gmail-send.ts` 仅用 `gmail.send` scope，OAuth2 凭据来自 env（GMAIL_CLIENT_ID/SECRET）+ 发件人库每行的 `password`（存 refresh_token）。
- **发件人库**：`notion-queue.ts` 的 `fetchSenderCredentials(notion, senderAccountsDatabaseUrl, senderAccount)` 按「Sender Account」匹配发件人库的 Email 列，取该行的 `password` 作为 refresh_token；即 **一个发件人库行 = 一个 Gmail 账号 = 一个 refresh_token**。
- **结论**：Listener 需要 **读邮件**（`gmail.readonly` 或 `gmail.modify`），需新增 scope；同一套 OAuth 客户端 + 多 refresh_token（多邮箱）的模式可复用，但每邮箱需单独用其 refresh_token 建 Gmail 客户端拉取该邮箱的入站。

### 1.2 Notion

- **当前**：`notion-queue.ts` 面向 **Queue 库**（query pending、update 成功/失败）和 **发件人库**（按 Email 取凭据）。Queue 库属性含 Thread ID、Message ID Last、Stop Flag、Needs Review、Email Status 等。
- **文档中的概念**：需求里出现 **📥 RE Inbound Messages**（IM 表）与 **📬 Touchpoints**（TP 表）。当前代码库**没有** IM 表、也没有以「Touchpoints」命名的模块；仅有 Queue 库与发件人库。
- **结论**：需确认 📬 Touchpoints 是否就是当前用的 Queue 库，还是另一张 Notion 数据库；若另一张，其 database_id/URL 与属性名从何配置、是否已存在。

### 1.3 配置与运行方式

- **Queue Sender**：由 Dashboard 启停（`dashboard-queue-sender-runner.ts`  spawn `npx tsx src/queue-sender.ts`）；配置来自 `schedule.json` 的行业（type=queue 时 `queueDatabaseUrl` + `senderAccountsDatabaseUrl`）+ env（NOTION_API_KEY、GMAIL_CLIENT_ID/SECRET、节流等）。
- **结论**：Listener 的「多组」配置（每组 IM DB、TP DB、mailboxes[]、token）与现有 schedule 的「行业」结构不同；需新增配置来源（独立 JSON/env 或扩展现有 schedule）。

### 1.4 可复用能力

- `parseDatabaseId`、Notion Client 的 query/update 模式、getRichText/getSelectOrStatusName/getDate 等解析方式。
- Gmail OAuth2 建 Client 的方式（仅需扩展 scope 与「按 mailbox 建多个 client」）。
- 日志、dotenv、Dashboard 子进程启停模式（若 Listener 也由 Dashboard 启停）。

---

## 2. 集成与依赖

- **新依赖**：Gmail API 读邮件（messages.get, messages.list 或 history.list）；若用 push，需 Google Pub/Sub + 公网 endpoint。
- **Notion**：需能 query 某 DB  by Message ID（IM 幂等）、query 某 DB by Thread ID（Touchpoints 路由）、create page（IM 行）、update page（Touchpoints 止损）。现有 `@notionhq/client` 已满足。
- **多组与多邮箱**：同一 mailbox（一个 Gmail 账号）可属多组；需明确「mailbox」在配置里如何表示、如何解析到 refresh_token（是否复用发件人库、或独立配置）。

---

## 3. 边界与约束（从需求归纳）

- 幂等键仅 Gmail `message.id`，不用 threadId。
- 同一封 message 只写入**一张** IM 表（多组时按「路由到唯一 Touchpoint 的 group 优先，否则默认 group」）。
- 路由失败也必须落库 IM，并设 Needs Review；不因路由失败跳过落库。
- Body 截断策略：如 20k–50k，超长保留开头+结尾。
- 最小止损仅对「已归属 Touchpoint」且确定性 Unsubscribe / Hard Bounce 写回 Touchpoints。

---

## 4. 待澄清问题清单

以下问题需产品/你确认后，实现时才有唯一解。

### 4.1 数据模型与 Notion 库

1. **📬 Touchpoints 与现有 Queue 库是否同一张 Notion 数据库？**  
   - 若**是**：路由时「query Touchpoints by Thread ID」即 query 当前 Queue 库的 Thread ID；止损写回即 update 该 Queue 行。  
   - 若**否**：Touchpoints 为单独数据库，请提供其 database_id/URL 及属性名约定（Thread ID、Stop Flag、Stop Reason、Email Status、Next Send At 等是否与现有 Queue 一致）。

2. **📥 RE Inbound Messages 表是否已存在？**  
   - 若已存在：请确认属性名与类型与开发说明 3.1/3.2 一致（如 Message title、Message ID text、Thread ID、Direction select、From Email/To Email、Received At date、Subject、Body Plain、Snippet、Touchpoint relation、Listener Run ID、Classification、Needs Review）。  
   - 若未存在：是否由我们按文档建表，还是你方先建好再对接？

### 4.2 多组与 mailbox 配置

3. **「mailbox」在配置中的含义与来源？**  
   - 是否与现有**发件人库**一致：即 mailbox = 发件人库中某行的标识（如 Email 或 Sender Account），Listener 用该标识去发件人库取 refresh_token 拉取该 Gmail 收件箱？  
   - 还是 mailbox 为独立配置（例如另一张表或 JSON 中的 mailbox_id → refresh_token / 发件人库行引用）？  
   - 若复用发件人库：`mailboxes[]` 是发件人库的 Email 列表，还是 Sender Account 列表？取 refresh_token 时是否沿用 `fetchSenderCredentials(notion, senderAccountsDatabaseUrl, senderAccount)` 的匹配逻辑（当前按 Email 匹配）？

4. **多组配置的载体？**  
   - 独立 JSON（如 `inbound-listener.json`）还是扩展现有 `schedule.json`（例如新行业类型 `inbound`）？  
   - 每组 `notion_token`：MVP 是否统一使用当前 env 的 `NOTION_API_KEY` 即可（即「或统一 token」）？

### 4.3 拉取与运行方式

5. **Gmail 入站拉取方式（MVP）？**  
   - **Push**：需 Gmail watch + Google Cloud Pub/Sub + 公网可访问 endpoint，实时性好，实现与运维更重。  
   - **轮询**：定时用 `users.messages.list`（或 history）按时间窗口拉新消息，无公网 endpoint，实现简单，延迟取决于轮询间隔。  
   - 请确认 MVP 是否仅做轮询即可，还是必须支持 push。

6. **Listener 进程的运行方式？**  
   - 是否与 Queue Sender 一致：**常驻进程 + 由 Dashboard 启停**（如「启动 Inbound Listener」/「停止 Inbound Listener」）？  
   - 还是独立部署（如单独机器/cron 调度的脚本），与 Dashboard 无关？

### 4.4 入站方向与过滤

7. **「入站」的精确含义？**  
   - 是否只处理「别人发给该 mailbox 的邮件」？若是，是否用 Gmail label 过滤（例如 INBOX 且排除 SENT）或按 `From` ≠ 当前 mailbox 的 email？  
   - 是否需要排除系统邮件（如 mailer-daemon）、已归档/已删除的邮件（仅 INBOX + UNREAD 等）？请约定 MVP 的过滤规则。

### 4.5 字段与格式

8. **Notion 属性名与类型**  
   - IM 与 Touchpoints 在 Notion 中的**属性名**是否与开发说明完全一致（含空格、大小写，如 "Message ID"、"From Email"、"Received At"）？  
   - Touchpoints 的 Email Status 是 **Status** 还是 **Select**？（现有 Queue 兼容两种，Listener 若写回 Stopped 需一致。）

9. **Listener Run ID 的生成规则？**  
   - 文档示例：`2026-02-26T14:00Z-re-inbound-01`。是否为「每次 Listener 跑一轮」一个 Run ID（即一轮拉取内所有新写入的 IM 行共用同一 Run ID）？`-01` 等后缀是 group 编号还是随机/递增？

10. **Body 解码与 body_plain**  
    - 若邮件为 multipart，是否只取 `text/plain` 部分；若仅有 `text/html`，MVP 是否要求转成纯文本（strip tags），还是可暂存为空或原始 snippet？

### 4.6 兜底与可选

11. **路由兜底（from_email + 14 天 + subject 弱匹配）**  
    - MVP 是否明确**不做**兜底，只做 Thread ID 精确匹配；路由失败一律落默认 group + Needs Review？

12. **最小止损（Unsubscribe / Hard Bounce）**  
    - MVP 是否必须实现 Step 5，还是可以「先只落库 IM + 路由 Touchpoint」，止损写回作为后续迭代？

---

## 5. 小结

- **集成点**：Gmail 读邮件（新 scope + 多邮箱/多 client）、Notion 新增 IM 写入与 TP 查询/更新、多组配置与路由策略、幂等与截断策略；运行方式与配置载体待定。
- **歧义与风险**：主要集中在 Touchpoints 与 Queue 是否同一库、mailbox 配置来源、拉取方式（push vs 轮询）、运行方式（Dashboard 启停 vs 独立）、入站过滤规则、以及部分字段/格式细节。  
- 建议先确认 **4.1（数据模型）、4.2（多组与 mailbox）、4.3（拉取与运行方式）、4.4（入站过滤）**，再细化 4.5/4.6，即可开始实现与排期。

---

## 6. 澄清结论（已确认）

以下为产品/你的确认，实现时以本节为准。

### 6.1 数据模型与 Notion 库

- **Touchpoints 与 Queue**：**同一张 Notion 库**（📬 Real Estate Email Touchpoints = 现有 Queue 表）。路由时 query 该库的 Thread ID；止损写回即 update 该库行。
- **Touchpoints 的 Email Status**：**Select** 类型（不是 Status）。写回 Stopped 时用 `select: { name: "Stopped" }`。  
  （当前 `notion-queue.ts` 里 Queue 的 Email Status 是 Status 类型，两表不同。）
- **📥 RE Inbound Messages**：表已存在；开发按 3.1/3.2 属性名与类型实现即可。

### 6.2 多组与 mailbox 配置

- **mailbox**：即**发件人库里的一行**。配置里 `mailboxes[]` 每项为**发件人库的 Email**（与发件人库 Email 列一致）；取 refresh_token 时用该 Email 调用 `fetchSenderCredentials(notion, senderAccountsDatabaseUrl, email)` 即可。
- **多组配置**：**独立 JSON**（如 `inbound-listener.json`），不扩展现有 schedule。
- **Notion token**：**统一用 env 的 `NOTION_API_KEY`**。

### 6.3 拉取与运行方式

- **Listener 进程**：**常驻进程，由 Dashboard 启停**（与 Queue Sender 一致）。
- **Gmail 拉取**：**轮询**（定时 `messages.list` / `history.list`），MVP 不做 Push。轮询 vs Push 对比见 **6.7**。

### 6.4 入站过滤

- **目标**：该 mailbox **收到的**入站邮件（含外部来信 + 系统通知如 bounce、OOO）。
- **Gmail label 过滤**：
  - **必须包含**：`INBOX`
  - **必须排除**：`SENT`
- **不排除** mailer-daemon（bounce 等系统邮件也算入站）。

### 6.5 字段与格式

- **Notion 属性名**：与开发说明 3.1/3.2 **完全一致**。
- **Listener Run ID**：**每轮扫描/处理批次一个**；本轮内所有新增的 IM 行共用同一 Run ID。格式可按示例（如 `2026-02-26T14:00Z-re-inbound-01`），后缀为 group 或 run 标识由实现定。
- **Body Plain**：口径为纯文本，**MVP 必须做到**：
  - 优先取 `text/plain` part；
  - 无 plain 时：把 `text/html` 转成纯文本（去 tag，`<br/>`/段落转成换行），否则后续 Notion AI 分类与生成会受影响。

### 6.6 兜底与最小止损

- **路由兜底**：MVP **明确不做** from_email + 14 天 + subject 弱匹配；只做 Thread ID 精确匹配，失败则落默认 group + Needs Review。
- **最小止损**：**必须做**。Unsubscribe / Hard Bounce 识别后写回 Touchpoints（Stop Flag、Stop Reason、Email Status=Stopped 等）。

### 6.7 轮询 vs Push 的区别与建议

| 维度 | 轮询（Polling） | Push（Gmail watch + Pub/Sub） |
|------|-----------------|--------------------------------|
| **实现** | 定时调用 `users.messages.list`（或 `history.list`）按时间/after 拉新消息 | 在 Gmail 侧为 mailbox 建 `watch`，Gmail 将变更推送到 Google Cloud Pub/Sub topic；需一 HTTP endpoint 接收 Pub/Sub push，验证 token 后拉 `history.list` 取增量 |
| **依赖** | 仅 Gmail API + 现有 OAuth | Gmail API + **Google Cloud 项目**中创建 Pub/Sub topic + **公网可访问的 HTTPS endpoint**（如 ngrok 或云函数） |
| **延迟** | 取决于轮询间隔（如 1–5 分钟） | 通常数十秒内 |
| **运维** | 无额外基建；常驻进程内定时循环即可 | 需维护 endpoint 可用性、证书、Pub/Sub 订阅与重试；多 mailbox 可共用一个 watch 但每 mailbox 需单独 watch 或共用 topic 后根据 history 区分 |
| **配额** | `messages.list` 有用量限制，高频轮询可能触限 | watch 有 7 天过期，需定期续期；Pub/Sub 有配额但一般够用 |

**区别有多大**：  
- **代码量**：轮询约「每 N 秒 list + 按 message 处理」；Push 需「watch 注册 + HTTP server 收 push + 按 historyId 拉 history」+ 部署与安全（验证 Pub/Sub 请求来源）。  
- **结论建议**：MVP 用**轮询**即可实现「落库 + 路由 + 止损」，实现与部署都更简单；若后续需要近实时再加 Push 作为可选通道（或单独迭代）。

---

## 7. 探索完成

- 上述澄清已覆盖 4.1–4.6 及拉取方式、mailboxes 标识，**无未决歧义**。
- 可据此进入实现与排期。

---

## 8. 完整流程说明与现有程序关系

### 8.1 当前程序结构（与 Listener 相关部分）

- **Dashboard**（`src/server.ts`）：HTTP 服务 + 前端；负责启停两类子进程，不参与业务逻辑。
- **Playwright 主流程**（`src/index.ts`）：按 `schedule.json` 的时间区间与行业，在**当前时段为 Playwright 行业**时打开 Notion、执行任务链；**当前时段为 Queue 行业时不跑**，只等待。
- **Queue Sender**（`src/queue-sender.ts`）：常驻进程，由 Dashboard「启动 Queue Sender」spawn；配置来自 **schedule.json**（时间区间 + 行业列表）。每轮：
  1. 取当前时间对应的行业；若非 `type=queue` 则本轮不拉取、休眠后继续。
  2. 若为 queue 行业：用该行业的 `queueDatabaseUrl`（即 **Touchpoints/Queue 表**）和 `senderAccountsDatabaseUrl`（发件人库）。
  3. 从 Touchpoints 表 **query Pending**（Email Status=Pending、四 Flag 假等），得到待发行。
  4. 每行有 `senderAccount`、`email`、`threadId`、`messageIdLast` 等；用 **senderAccount** 去发件人库按 **Email 列**匹配取 `password`（refresh_token）。
  5. 用 Gmail API **发信**（Cold1 或 Followup），成功后 **回写同一行**：Sent At Last、Thread ID、Message ID Last、Subject Last、Needs Review=false 等。
- **Notion 表**：当前代码只涉及两张——**Queue 表**（即 📬 Touchpoints，存待发/已发、Thread ID、Stop Flag 等）和**发件人库**（Email + password/refresh_token）。**没有** 📥 Inbound Messages 表相关逻辑。

**小结**：Queue Sender = 读 Touchpoints 表 Pending → 用发件人库取 refresh_token → Gmail 发信 → **写回 Touchpoints 表**（同一行）。出站方向、单行业单库、配置来自 schedule.json。

---

### 8.2 Inbound Listener 完整流程（单轮）

每轮一次「扫描 + 处理批次」，生成一个 **Listener Run ID**，本轮所有新写入的 IM 行共用该 ID。

1. **加载配置**  
   读独立 JSON（如 `inbound-listener.json`）：多组，每组 `inbound_messages_db_id`、`touchpoints_db_id`、`mailboxes[]`（发件人库 Email 列表）；发件人库 URL 需在配置中（或每组）指定；Notion 用 env `NOTION_API_KEY`。

2. **按 mailbox 拉取入站**  
   对配置中出现的每个 mailbox（发件人库 Email）：
   - 用该 Email 调 `fetchSenderCredentials(notion, senderAccountsDatabaseUrl, email)` 取 refresh_token；
   - 用 **带 gmail.readonly 的** Gmail Client 对该邮箱轮询：`users.messages.list`（或 history）过滤 **label 含 INBOX、不含 SENT**；
   - 得到本轮新消息 id 列表，再逐条 `messages.get` 取 headers、snippet、payload，解码得到 `body_plain`（优先 text/plain，无则 html→纯文本），截断策略 20k–50k。

3. **逐条标准化 + 幂等**  
   对每条 message 组装：`gmail_message_id`, `thread_id`, `from_email`, `to_email`, `received_at`, `subject`, `snippet`, `body_plain` 等。  
   **幂等**：先做路由（见下），确定目标 group 后，在该 group 的 **IM 表**里 query `Message ID == gmail_message_id`；若已存在则 **skip 本条**（不写 IM、不写 Touchpoints）。

4. **多组路由（确定写入哪张 IM 表）**  
   找出「包含当前 mailbox 的 groups」，按配置顺序：
   - 在该 group 的 **Touchpoints 表**（与 Queue 表同一张）query `Thread ID == thread_id`；
   - 命中 **唯一** 行 → 选定该 group，记下 touchpoint pageId，后续写 IM 时带 relation；
   - 命中 0 或 >1 → 继续下一 group；
   - 若所有 group 都未命中唯一 → 用 **第一个 group** 作为落库目标，Touchpoint 为空，Needs Review=true。

5. **写入 📥 Inbound Messages**  
   在选定 group 的 IM 表 **create 一行**：Message（title）、Message ID、Thread ID、Direction=Inbound、From/To Email、Received At、Subject、Body Plain、Snippet、Touchpoint relation（若有）、Listener Run ID、Classification（默认 Other）、Needs Review（路由失败则为 true）。**路由失败也必须落库。**

6. **最小止损写回 Touchpoints（可选分支）**  
   仅当本条 **已关联到唯一 Touchpoint** 且识别到确定性信号时：
   - **Unsubscribe/STOP**：body 命中关键字 → update 该 Touchpoint 行：Stop Flag=true, Stop Reason=Unsubscribe, Email Status=Stopped（Select）, Next Send At=null 等；IM 行可选写 Classification=Unsubscribe。
   - **Hard Bounce**：from/subject/body 命中 → update Touchpoint：Stop Flag=true, Stop Reason=Bounce Hard, Email Status=Stopped 等；IM 可选 Classification=Bounce Hard。

7. **本轮结束**  
   休眠（轮询间隔），下一轮重复 2–7。

8. **日志**  
   每条 message 输出：`mailbox / message_id / resolved_group / touchpoint_found / wrote_im / stop_written`。

---

### 8.3 与当前程序的关系（数据与进程）

| 维度 | 当前程序 | Inbound Listener |
|------|----------|------------------|
| **进程** | Dashboard 启停 Queue Sender（`queue-sender.ts`）和 Playwright（`index.ts`） | Listener 同样由 Dashboard 启停，**独立常驻进程**（如 `inbound-listener.ts`），与 Queue Sender、Playwright **并行存在**，互不依赖。 |
| **配置** | Queue Sender 用 schedule.json（时间区间 + queue 行业：queueDatabaseUrl、senderAccountsDatabaseUrl） | Listener 用 **独立 JSON**（多组：IM DB、Touchpoints DB、mailboxes[]）；发件人库可复用同一张，但 **不读 schedule**。 |
| **Notion 表** | Queue Sender **读+写** Touchpoints 表（Pending 查询、成功/失败回写 Thread ID / Message ID Last / Stop 等） | Listener **读** Touchpoints 表（按 Thread ID 路由）、**写** IM 表（新建行）、**写** Touchpoints 表（仅止损：Stop Flag、Email Status=Stopped 等）。 |
| **Gmail** | 仅 **发信**（gmail.send），按发件人库行取 refresh_token | **读信**（gmail.readonly），按 mailbox（发件人库 Email）取 refresh_token，轮询 INBOX、排除 SENT。 |
| **发件人库** | Queue Sender 用 **Sender Account**（来自 Queue 行）去匹配发件人库 **Email** 列取 password | Listener 用 **mailboxes[] 中的 Email** 直接匹配发件人库 Email 列取 password，**同一张发件人库**可复用。 |

**数据流关系**：

- **出站**：Queue Sender 从 Touchpoints 表取 Pending 行 → 发信 → 把 **Thread ID、Message ID Last** 写回该行。  
- **入站**：Listener 从 Gmail 拿到回复（带 threadId）→ 在 **同一张 Touchpoints 表** 按 Thread ID 找到对应行（即之前出站写回 thread 的那行）→ 在 IM 表新建一行并关联该 Touchpoint；若识别 Unsubscribe/Bounce，再 **update 该 Touchpoint 行**（Stop Flag、Email Status=Stopped），Queue Sender 后续 query Pending 时会因 Stop Flag 等过滤掉，不再给该联系人发信。

因此：**Touchpoints 表 = 出站与入站的交汇点**；Queue Sender 写 Thread ID，Listener 用 Thread ID 做路由并可选写回止损字段；两进程 **不共享内存、不共享配置**，仅通过 Notion 表与发件人库在数据上衔接。

---

### 8.4 流程简图（文字）

```
[ 当前已有 ]
  schedule.json ──► Queue Sender 常驻 ──► Touchpoints 表 query Pending
       │                     │                        │
       │                     │                        ▼
       │                     │              发件人库取 refresh_token
       │                     │                        │
       │                     └──────────────────────► Gmail 发信
       │                                ▲                        │
       │                                │                        ▼
       │                        Sent At Last, Thread ID, Message ID Last 写回 Touchpoints
       │
  schedule.json ──► index.ts（Playwright）仅在 Playwright 行业时段跑

[ 新增 ]
  inbound-listener.json ──► Inbound Listener 常驻
       │                              │
       │                              ▼
       │                     各 mailbox：发件人库 Email → refresh_token → Gmail 轮询（INBOX, ¬SENT）
       │                              │
       │                              ▼
       │                     每 message：幂等查 IM 表 → 多组路由（Touchpoints 表 query Thread ID）
       │                              │
       │                              ▼
       │                     写 IM 表（新行 + 可选 Touchpoint relation）→ 若止损则 update Touchpoints 行
       │
  Dashboard：启停 Queue Sender / Playwright / **Inbound Listener**（三者独立）
```
