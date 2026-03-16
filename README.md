# notion-auto

Playwright 自动化：按**时间区间**（左闭右开、本地时区）选择行业，每个行业有独立 **Notion Portal URL** 与**任务链**；按任务链顺序执行输入+发送，行业级「每 N 次新会话、每 M 次换模型（可 0=不换）」。7×24 运行直到用户停止；未配置时段不跑。配置由 **schedule.json**（或 `--config` 指定）提供。

## 环境要求

- Node.js 18+
- npm 或 pnpm

## 安装

```bash
npm install
npx playwright install chromium
```

## 首次运行与登录

1. **第一次运行**：执行 `npm run run`，浏览器打开后会等待 `loginWaitMs`（默认 **60 秒**）供你手动登录 Notion（用 Google 等）。登录完成后脚本会自动打开 Notion 并开始执行；**正常退出时会把登录态保存到 `.notion-auth.json`**。
2. **之后运行**：若项目目录下已有 `.notion-auth.json`，脚本会**自动加载该登录态**，只再等 **5 秒**就会继续（无需重新登录）；若你想换账号，可在这 5 秒内手动登录，脚本会覆盖保存新的登录态。

## 配置文件 schedule.json

运行前需在项目目录下准备 **schedule.json**（或通过 `--config <path>` 指定）。结构示例见 **schedule.example.json**：

- **timeSlots**：时间区间列表，左闭右开、本地时区；每项含 `startHour`、`startMinute`、`endHour`、`endMinute`（小时 0–23，分钟 0–59）、`industryId`（绑定行业）。止 23:59 表示到当日结束；缺省分钟视为 0。
- **industries**：行业列表。每项含 `id`；当前仅支持 `type: "playwright"`（可省略）。行业含 `notionUrl`、`newChatEveryRunsMin`/`Max`、`modelSwitchIntervalMin`/`Max`、`chainRunsPerSlot`（0=一直跑）、`tasks`（任务链）。
- **tasks**：每任务 `content`（输入文案）、`runCount`（本轮执行次数）（仅 Playwright 行业）。
- 顶层：`intervalMinMs`/`intervalMaxMs`（每次发送完成后等待的毫秒数区间）、`loginWaitMs`、`maxRetries`、`storagePath`。

未配置的时间段不跑（脚本会等待直至落入某区间）。时间区间列表为空会报错退出。

## 运行命令

```bash
npm run run
# 使用默认 schedule.json；指定配置或登录态路径：
npm run run -- --config schedule.json --storage .notion-auth.json
npm run run -- --help
```

| 参数 | 说明 |
|------|------|
| `--config <path>` | 配置文件路径，默认项目目录下 schedule.json |
| `--storage <path>` | 登录态保存路径，默认见 schedule 内 storagePath |
| `--help`, `-h` | 显示帮助 |

环境变量 `NOTION_AUTO_RESUME=1` 由 Dashboard 恢复重启时设置，脚本按当前时间对应行业从任务 1 开始（不恢复任务进度）。

## 行为简述

- **启动**：根据当前时间解析所在时间区间 → 得到当前行业；若未落入任何区间则等待（如每分钟再检查）。
- **主循环**：打开该行业 Notion Portal URL，登录等待一次；按该行业任务链顺序执行，每任务执行 `runCount` 次 typeAndSend；每次执行前按行业级 N/M 决定是否新会话、是否换模型；任务链跑完后立刻从头再跑；每轮任务链开始前检查时间，若落入另一区间则切换行业（换 URL 与任务链）。
- **结束**：仅用户停止（或进程终止）时退出，无总轮数。
- **单轮失败恢复**：与之前一致（重试 → New AI chat 再试 → 刷新+重开再试，仍失败则 EXIT_RECOVERY_RESTART 由 Dashboard 重启）。

## Web 控制台（Dashboard）

运行 `npm run dashboard` 启动本地 Web 服务（**http://127.0.0.1:9000**，仅本机访问）。在浏览器打开后可：

- 查看运行状态（运行中 / 已停止）
- 编辑**全局设置**（每轮间隔、登录等待、重试）、**时间区间**（起止小时、绑定行业）、**行业与任务链**（URL、N/M、任务输入内容与执行次数），保存到 **schedule.json**
- 点击「启动」或「停止」控制脚本子进程（启动前会先保存当前配置）
- 查看最近运行日志（Playwright 与 Warmup Executor 分开展示）
- **Warmup Executor**：在「Warmup Executor 配置」Tab 中维护配置（写入 `queue-sender.json`）。Warmup Executor 常驻轮询（每分钟一轮），每轮按配置顺序跑所有条目；与 `schedule.json` 的时段**无关**（只要 Dashboard 运行就会守护它）。

首次打开页面时脚本处于未运行状态，需点击「启动」才会执行。端口固定 9000，仅监听 localhost。

**Warmup Executor 与 NOTION_API_KEY**：当前实现会在真实 Notion 数据库上读取 Queue、Credential Registry、BandWidth Detail，并执行真实邮箱动作后回写 `Email Warmup Queue`、`Execution Log` 与 `Warmup Conversation Event Log`。需配置环境变量 `NOTION_API_KEY`（Notion Integration Token，且 Integration 需加入 Warmup 相关数据库的 Collaborators）。

**Warmup Executor 与 Mail Automation Agent**：邮件动作（发信、回复、打开、标星、加联系人）统一通过 **Mail Automation Agent**（Thunderbird 扩展 + minimal-server）执行，不再直接调用 Gmail/Zoho/M365/SMTP API。**前置条件与启动顺序**：1）先启动 minimal-server（如 `node minimal-server/server.js`，默认 `http://127.0.0.1:3939`）；2）Thunderbird 已安装并加载 Mail Automation Agent 扩展；3）再启动 Warmup Executor（或 Dashboard）。环境变量见 `env.example`：`MAIL_AUTOMATION_AGENT_BASE_URL`、`MAIL_AUTOMATION_AGENT_TIMEOUT_MS`、可选 `MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID`（Add Contact 用）。启动时会对 minimal-server 做健康检查，不可达则进程退出。

**Warmup Executor（现行逻辑）**：

- **消费条件**：只读取满足 `Status = Pending`、`audit_decision = Keep`、`Legacy Task Type = Warmup`、`Platform (Legacy) = Email` 的 Queue 项。
- **执行窗口**：`Execute Window` 支持单个开始时间或时间范围；有 `start + end` 时按 `start <= now <= end`，只有 `start` 时按 `now >= start`。
- **依赖口径**：若 `depends_on_task_id` 非空，则必须在同库中找到上游 `Task ID` 且其 `Status = Sent`，才允许继续执行。
- **凭据与风控**：通过 `actor_mailbox_id` 命中 `Credential Registry`，并优先读取 relation 关联的 `BandWidth Detail` 做 gate。
- **执行结果**：成功项会把 Queue 写成 `Status = Sent`，并写入两张 log；失败项写 `Status = Failed` 与阻塞状态，便于人工复盘。
- **邮件执行**：统一走 **Mail Automation Agent**（minimal-server）：`Send`、`Reply`、`Open`、`Star`、`Add Contact`、`Wait`（noop）。Credential 仅需能解析出账号（邮箱），不再区分 Gmail/Zoho/M365/SMTP。

### Credential Registry 的 `auth_config_json`

当 `platform = SMTP` 或需要补充 IMAP / CardDAV 兼容能力时，可在 `Credential Registry.auth_config_json` 写入 JSON。当前支持的最小结构：

```json
{
  "smtp": {
    "host": "smtp.example.com",
    "port": 587,
    "secure": false,
    "username": "user@example.com",
    "password": "smtp-password",
    "fromEmail": "user@example.com",
    "fromName": "Warmup Bot"
  },
  "imap": {
    "host": "imap.example.com",
    "port": 993,
    "secure": true,
    "username": "user@example.com",
    "password": "imap-password",
    "mailbox": "INBOX",
    "starFlag": "\\Flagged"
  },
  "contacts": {
    "type": "carddav",
    "baseUrl": "https://contacts.example.com/addressbooks/user/default/",
    "username": "user@example.com",
    "password": "carddav-password"
  },
  "messageLookup": {
    "useReplyToMessageId": true,
    "useThreadId": true,
    "fallbackToSubjectSearch": true,
    "fallbackToCounterpartySearch": true
  }
}
```

- `smtp`：非 Gmail / Zoho / M365 的发信与回复走这里。
- `imap`：`Open` / `Star` 通过 IMAP 搜索并修改目标邮件状态。
- `contacts`：`Add Contact` 当前使用 CardDAV 兼容方案。
- 若字段缺失，执行器会优先回退到 `login_username` / `password` / `account` / `mailbox_id` 等 Registry 字段。
- **四类 provider 可填字段模板**：见 [docs/credential-registry-auth-config-templates.md](docs/credential-registry-auth-config-templates.md)（Gmail / Zoho / M365 / SMTP 必填与可选字段说明）。
- **检查当前 Notion 凭据是否可跑**：在配置好 `queue-sender.json` 与 `NOTION_API_KEY` 后，执行 `npx tsx scripts/check-warmup-credentials.ts`，会列出每条凭据的「可运行」/「需补配置」及缺项说明。

### Gmail OAuth2 凭据（GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET）

**一套凭据、所有账号共用**：`GMAIL_CLIENT_ID` 和 `GMAIL_CLIENT_SECRET` 是你在 Google Cloud 里创建的 OAuth 客户端。Warmup Executor 通过 `Credential Registry` 读取账号与认证信息，并在 Gmail / Google People API 上执行真实动作。

获取步骤：

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) 并选择或新建一个项目。
2. **启用 Gmail API**：左侧「API 和服务」→「库」→ 搜索 “Gmail API” → 启用。
3. **创建 OAuth 2.0 凭据**：
   - 「API 和服务」→「凭据」→「创建凭据」→「OAuth 客户端 ID」。
   - 若提示先配置「OAuth 同意屏幕」：选「外部」、填应用名称等必填项并保存。
   - 应用类型选 **「Web 应用」**（Web application）。**不要选「桌面应用」**——桌面应用无法在控制台添加重定向 URI，会导致授权页脚本报「此应用的请求无效」。
   - 在「已授权的重定向 URI」中**添加**：`http://127.0.0.1:9010/callback`（用于下方「通过授权页获取 refresh_token」）。
   - 创建后会得到 **客户端 ID**（形如 `xxx.apps.googleusercontent.com`）和 **客户端密钥**。
4. 将 **客户端 ID** 写入 `.env` 的 `GMAIL_CLIENT_ID`，**客户端密钥** 写入 `GMAIL_CLIENT_SECRET`。
5. 当前项目保留授权页脚本用于获取 Gmail `refresh_token`；请将其接入 `Credential Registry.refresh_token` 或由 `auth_config_json` 引用的外部凭据。

**通过授权页获取 refresh_token**：

1. 确保 OAuth 客户端类型为 **「Web 应用」**，并在「已授权的重定向 URI」中**添加**：`http://127.0.0.1:9010/callback`（若之前创建的是「桌面应用」，需新建一个 Web 应用类型的客户端并填同一重定向 URI）。
2. 在项目目录执行：`npx tsx scripts/gmail-oauth-refresh-token.ts`。
3. 在浏览器打开终端提示的地址（如 `http://127.0.0.1:9010`），点击「用 Google 账号登录授权」，完成登录与授权。
4. 授权成功后页面会显示 **refresh_token**，请手动保存，并在后续真实执行阶段接入 `Credential Registry`。可多次点击「返回首页」再授权其他账号；用完后在终端按 Ctrl+C 停止脚本。

**Gmail 所需权限**：至少需要 `gmail.send`、`gmail.modify` 与 Google People API 联系人写入权限，否则 `Open` / `Star` / `Add Contact` 无法执行。

### Zoho / Microsoft 365 / SMTP 额外说明

- `Zoho`：除发信权限外，需具备消息更新与联系人创建权限，`Add Contact` 走 Zoho Contacts API。
- `Microsoft 365`：除 `Mail.Send` 外，需具备 `Mail.ReadWrite` 与 `Contacts.ReadWrite`。
- `SMTP`：不是单独的“万能 provider”。它的兼容路径是：
  - `Send` / `Reply`：SMTP
  - `Open` / `Star`：IMAP
  - `Add Contact`：CardDAV
  若只提供 SMTP 而没有 IMAP / CardDAV，则对应动作会失败并写回 Queue。

**自动恢复**：脚本异常退出时 Dashboard 会自动重启；脚本按当前时间对应行业从任务 1 开始（不恢复任务进度）。连续自动重启超过 5 次时会发一封告警邮件（需配置 SMTP 环境变量，见下）。

**告警邮件（可选）**：需在环境中配置以下变量后，连续自动重启 >5 次时才会发信（只发一封）：`NOTION_SMTP_HOST`、`NOTION_SMTP_PORT`（可选，默认 465）、`NOTION_SMTP_USER`、`NOTION_SMTP_PASS`、`NOTION_ALERT_TO`（收件人）。未配置则仅打日志不发信。

## 仅本地使用

本工具仅设计为在本地命令行运行，请勿在无头环境或未登录状态下依赖其行为。
