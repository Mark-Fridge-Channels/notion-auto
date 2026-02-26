# notion-auto

Playwright 自动化：按**时间区间**（左闭右开、本地时区）选择行业，每个行业有独立 Notion Portal URL 与**任务链**；按任务链顺序执行输入+发送，行业级「每 N 次新会话、每 M 次换模型」。7×24 运行直到用户停止；未配置时段不跑。配置由 **schedule.json**（或 `--config` 指定）提供。

## 环境要求

- Node.js 18+
- npm 或 pnpm

## 安装

```bash
npm install
npx playwright install chromium
```

## 首次运行与登录

1. **第一次运行**：执行 `npm run run`，浏览器打开后有 **60 秒**供你手动登录 Notion（用 Google 等）。登录完成后脚本会自动打开 Notion 并开始执行；**正常退出时会把登录态保存到 `.notion-auth.json`**。
2. **之后运行**：若项目目录下已有 `.notion-auth.json`，脚本会**自动加载该登录态**，只再等 **5 秒**就会继续（无需重新登录）；若你想换账号，可在这 5 秒内手动登录，脚本会覆盖保存新的登录态。

## 配置文件 schedule.json

运行前需在项目目录下准备 **schedule.json**（或通过 `--config <path>` 指定）。结构示例见 **schedule.example.json**：

- **timeSlots**：时间区间列表，左闭右开、本地时区；每项含 `startHour`、`startMinute`、`endHour`、`endMinute`（小时 0–23，分钟 0–59）、`industryId`（绑定行业）。止 23:59 表示到当日结束；缺省分钟视为 0。
- **industries**：行业列表。每项含 `id`；**行业类型** `type` 为 `playwright`（默认）或 `queue`。**Playwright** 行业含 `notionUrl`、`newChatEveryRunsMin`/`Max`、`modelSwitchIntervalMin`/`Max`、`tasks`（任务链）。**Queue** 行业含 `queueDatabaseUrl`、`senderAccountsDatabaseUrl`（发件人库各自用）、`batchSize`（可选，默认 20），用于出站邮件发送，由 Dashboard「启动 Queue Sender」在对应时段执行。
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
- 查看最近运行日志（Playwright 与 Queue Sender 合并展示，tabs 区分）
- **Queue Sender**：行业类型为 Queue 时，在对应时段可点击「启动 Queue Sender」运行出站发信进程；状态与日志与 Playwright 共用同一页。

首次打开页面时脚本处于未运行状态，需点击「启动」才会执行。端口固定 9000，仅监听 localhost。

**Queue Sender 与 NOTION_API_KEY**：出站发送依赖 Notion API 与 Gmail API。需配置环境变量 `NOTION_API_KEY`（Notion Integration Token，且 Integration 需加入 Queue 库与发件人库的 Collaborators）、`GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`；发件人库中存各账号的 `Email` 与 `password`（作为 refresh_token 使用）。详见 issues/010 与 PLAN-014。

**发送节奏与节流**：发送节奏完全由程序控制，Notion 的 Planned Send At **不参与**是否可发判断；满足四 Flag、Subject/Body 等的 Pending 均进入待发，顺序与发送时机由程序决定。节流为全局配置、**按发送者**生效：两封间隔 3～5 分钟（可配）、每小时每发送者最多 10 封、每天每发送者最多 50 封（见 env `QUEUE_THROTTLE_*`）。无固定轮询间隔：有待发时按「下次可发时间」休眠，无待发时每 1 分钟拉一次 Notion。

### Gmail OAuth2 凭据（GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET）

**一套凭据、所有发件人共用**：`GMAIL_CLIENT_ID` 和 `GMAIL_CLIENT_SECRET` 是你在 Google Cloud 里创建的那一个「桌面应用」OAuth 客户端，整台机器/整个项目只配一次。不同发件人（不同 Gmail 邮箱）的区别在发件人库里：每行一个邮箱，**password 列存该邮箱自己的 refresh_token**。发信时用同一套 Client ID/Secret + 当前行对应的 refresh_token 去换访问令牌。因此只需在 `.env` 里配一份 `GMAIL_CLIENT_ID`、`GMAIL_CLIENT_SECRET`；每个要用来发信的 Gmail 账号各自做一次授权，把拿到的 refresh_token 填进发件人库对应行的 password 列即可。

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
5. 发件人库中每行的 **password** 列应存该邮箱的 **refresh_token**。可用本项目提供的**授权页脚本**获取（见下）。

**通过授权页获取 refresh_token**：

1. 确保 OAuth 客户端类型为 **「Web 应用」**，并在「已授权的重定向 URI」中**添加**：`http://127.0.0.1:9010/callback`（若之前创建的是「桌面应用」，需新建一个 Web 应用类型的客户端并填同一重定向 URI）。
2. 在项目目录执行：`npx tsx scripts/gmail-oauth-refresh-token.ts`。
3. 在浏览器打开终端提示的地址（如 `http://127.0.0.1:9010`），点击「用 Google 账号登录授权」，完成登录与授权。
4. 授权成功后页面会显示 **refresh_token**，请手动选中复制，粘贴到 Notion 发件人库对应行的 **password** 列。可多次点击「返回首页」再授权其他账号；用完后在终端按 Ctrl+C 停止脚本。

**自动恢复**：脚本异常退出时 Dashboard 会自动重启；脚本按当前时间对应行业从任务 1 开始（不恢复任务进度）。连续自动重启超过 5 次时会发一封告警邮件（需配置 SMTP 环境变量，见下）。

**告警邮件（可选）**：需在环境中配置以下变量后，连续自动重启 >5 次时才会发信（只发一封）：`NOTION_SMTP_HOST`、`NOTION_SMTP_PORT`（可选，默认 465）、`NOTION_SMTP_USER`、`NOTION_SMTP_PASS`、`NOTION_ALERT_TO`（收件人）。未配置则仅打日志不发信。

## 仅本地使用

本工具仅设计为在本地命令行运行，请勿在无头环境或未登录状态下依赖其行为。
