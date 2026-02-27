# Inbound Listener 实现计划

**Overall Progress:** `100%`

## TLDR

实现 Inbound Listener 常驻进程：从独立 JSON 加载多组配置，按 mailbox（发件人库 Email）轮询 Gmail 入站（INBOX、排除 SENT），幂等写入 📥 RE Inbound Messages，按 Thread ID 路由到 📬 Touchpoints（与现有 Queue 表同一张），并对 Unsubscribe/Hard Bounce 写回 Touchpoints 止损。由 Dashboard 启停，与 Queue Sender、Playwright 并行独立。

## Critical Decisions

- **Touchpoints = 现有 Queue 表**：路由与止损都读写同一张 Notion 库；Touchpoints 的 Email Status 为 **Select**，写回用 `select: { name: "Stopped" }`。
- **配置**：独立 JSON（如 `inbound-listener.json`），多组，每组 IM DB、Touchpoints DB、mailboxes[]（发件人库 Email）、发件人库 URL；Notion 统一用 `NOTION_API_KEY`。
- **Gmail**：轮询（`messages.list` + label INBOX、排除 SENT），不做 Push；需 `gmail.readonly` scope，用户需重新授权。
- **路由**：仅 Thread ID 精确匹配，不做 from_email + 14 天兜底；多组时「先命中唯一 Touchpoint 的 group」写入其 IM 表，否则写第一个 group + Needs Review。
- **Body Plain**：优先 text/plain；无则 html→纯文本（去 tag、br/p→换行）；截断 20k–50k，超长保留开头+结尾。
- **最小止损**：MVP 必须做；已关联 Touchpoint 且识别 Unsubscribe/Hard Bounce 时立即 update Touchpoint 行。

---

## Tasks

- [x] 🟩 **Step 1: 配置与类型**
  - [x] 🟩 定义 `inbound-listener.json` schema：groups[]，每组 `inbound_messages_db_id`、`touchpoints_db_id`、`sender_accounts_database_url`、`mailboxes[]`（Email 字符串数组）；可选 `poll_interval_seconds`、`body_plain_max_chars`。
  - [x] 🟩 实现配置加载函数（读 JSON、校验必填），可从 env 或参数指定路径；与 schedule 完全独立。
  - [x] 🟩 在 `env.example` 中注明 Listener 需 Gmail 读权限（`gmail.readonly`）及重新授权说明。

- [x] 🟩 **Step 2: Gmail 读邮件（scope + 轮询 + 解析）**
  - [x] 🟩 新增 Gmail 读端：在现有 OAuth 基础上增加 `gmail.readonly`（或新建小模块，接受 refresh_token 返回带读权限的 client），与 `gmail-send.ts` 的 send-only client 区分或复用入口并传不同 scopes。
  - [x] 🟩 实现按 mailbox 轮询：对单个 mailbox 用 `users.messages.list`，q 或 labelIds 实现「INBOX 且排除 SENT」；支持按 `internalDate` 或 `after` 做增量窗口（如本轮只处理最近 N 分钟），避免全量扫。
  - [x] 🟩 实现单条 message 解析：`messages.get` 取 id、threadId、internalDate、snippet、payload；从 headers 解析 From/To/Subject/Delivered-To；从 payload 解码 body：优先 text/plain part，无则取 text/html 并转为纯文本（去 tag、br/段落→换行）；应用截断（如 20k–50k，超长保留开头+结尾）。
  - [x] 🟩 导出标准化结构：`gmail_message_id`, `thread_id`, `from_email`, `to_email`, `received_at`, `subject`, `snippet`, `body_plain`。

- [x] 🟩 **Step 3: Notion Adapter（IM + Touchpoints）**
  - [x] 🟩 幂等查 IM：`query database` 过滤 `Message ID` (rich_text) equals `gmail_message_id`，存在则返回已存在，否则可创建。
  - [x] 🟩 路由查 Touchpoints：`query database` 过滤 `Thread ID` (rich_text) equals `thread_id`；返回 0/1/多行；调用方根据结果判定唯一或落默认。
  - [x] 🟩 创建 IM 行：必填 Message（title 格式 `YYYY-MM-DD HH:mm — <From> — <Subject>`）、Message ID、Thread ID、Direction=Inbound、From Email、To Email、Received At、Subject、Body Plain、Snippet；可选 Touchpoint relation、Listener Run ID、Classification（默认 Other）、Needs Review；属性名与开发说明 3.1/3.2 一致。
  - [x] 🟩 更新 Touchpoint 止损：写 Stop Flag=true、Stop Reason（Unsubscribe / Bounce Hard）、Email Status=Stopped（**Select**：`select: { name: "Stopped" }`）、Next Send At=null 等；不依赖现有 notion-queue 的 Status 类型。

- [x] 🟩 **Step 4: 多组路由与幂等流程**
  - [x] 🟩 对每条 message 确定「包含该 mailbox 的 groups」并按配置顺序遍历；在每个 group 的 Touchpoints 表 query by Thread ID；命中唯一即选定该 group + touchpoint pageId，并停止遍历。
  - [x] 🟩 若所有 group 均未命中唯一：选定第一个 group，touchpoint=空，needs_review=true。
  - [x] 🟩 在**选定 group** 的 IM 表做幂等：query by Message ID；若已存在则 skip 整条（不写 IM、不写 Touchpoint）。
  - [x] 🟩 调用 Step 3 创建 IM 行（含 relation 与 Needs Review）；生成并写入 Listener Run ID（每轮一个，格式如 `YYYY-MM-DDTHH:mm:ssZ-re-inbound-01`）。

- [x] 🟩 **Step 5: 最小止损（Unsubscribe / Hard Bounce）**
  - [x] 🟩 Unsubscribe：body_plain 命中关键字（unsubscribe, remove me, do not contact, opt out, stop, 退订, 不要再发, 别再联系 等，可去引用块降误判）且已关联 Touchpoint → update Touchpoint（Stop Flag, Stop Reason=Unsubscribe, Email Status=Stopped, Next Send At=null）；IM 可选写 Classification=Unsubscribe。
  - [x] 🟩 Hard Bounce：from/subject/body 命中（mailer-daemon, postmaster, Delivery Status Notification, Undelivered, mailbox not found, user unknown 等）且已关联 Touchpoint → update Touchpoint（Stop Flag, Stop Reason=Bounce Hard, Email Status=Stopped 等）；IM 可选 Classification=Bounce Hard。
  - [x] 🟩 仅在 IM 创建成功且 touchpoint 已归属时执行上述 update，避免对未路由到的行写回。

- [x] 🟩 **Step 6: Listener 主循环与入口**
  - [x] 🟩 入口脚本（如 `src/inbound-listener.ts`）：加载配置、创建 Notion client（NOTION_API_KEY）、本轮生成 Run ID；遍历所有 mailbox（去重，因可属多组），对每个 mailbox 取发件人凭据（`fetchSenderCredentials(notion, senderAccountsDatabaseUrl, email)`）、拉取入站消息列表并解析。
  - [x] 🟩 对每条 message 执行：标准化 → 多组路由 → 幂等检查 → 写 IM → 止损写回；日志输出 `mailbox / message_id / resolved_group / touchpoint_found / wrote_im / stop_written`。
  - [x] 🟩 每轮结束后 sleep(poll_interval_seconds)，循环；进程常驻直至退出。

- [x] 🟩 **Step 7: Dashboard 集成（启停 + 状态 + 日志）**
  - [x] 🟩 新增 `dashboard-inbound-listener-runner.ts`：仿照 `dashboard-queue-sender-runner.ts`，spawn `npx tsx src/inbound-listener.ts`（可传 `--config` 指定 JSON 路径），采集 stdout/stderr，保留最近 N 次运行日志；`getInboundListenerStatus`、`startInboundListener`、`stopInboundListener`、`getInboundListenerRunLogs`。
  - [x] 🟩 在 `server.ts` 中注册 API：`GET /api/inbound-listener/status`、`POST /api/inbound-listener/start`、`POST /api/inbound-listener/stop`；运行日志合并到现有「最近运行」接口（若存在）或单独列表；进程退出时 `stopInboundListener()`。
  - [x] 🟩 前端：Inbound Listener 状态展示、启动/停止按钮（与 Queue Sender 并列），逻辑与 Queue Sender 一致。

- [x] 🟩 **Step 8: 文档与收尾**
  - [x] 🟩 README 或 issues/014 中补充：如何配置 `inbound-listener.json`、Gmail 重新授权、轮询间隔建议、与 Queue Sender 的数据关系（Touchpoints 表）。
  - [x] 🟩 提供 `inbound-listener.json.example` 示例配置（含一组、mailboxes、db ids 占位符）。
