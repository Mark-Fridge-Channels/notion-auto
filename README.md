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
- **industries**：行业列表，每项含 `id`、`notionUrl`、`newChatEveryRunsMin`/`newChatEveryRunsMax`（每 N 次新会话的区间，开新会话时随机取 N；0=本会话不主动新建）、`modelSwitchIntervalMin`/`modelSwitchIntervalMax`（每 M 次换模型的区间，0=不换）、`tasks`（任务链）。
- **tasks**：每任务 `content`（输入文案）、`runCount`（本轮执行次数）。
- 顶层：`intervalMinMs`/`intervalMaxMs`（每次发送完成后等待的毫秒数区间，每次随机取）、`loginWaitMs`、`maxRetries`、`storagePath`。

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
- 查看最近 10 次运行的日志（仅内存，不落盘）

首次打开页面时脚本处于未运行状态，需点击「启动」才会执行。端口固定 9000，仅监听 localhost。

**自动恢复**：脚本异常退出时 Dashboard 会自动重启；脚本按当前时间对应行业从任务 1 开始（不恢复任务进度）。连续自动重启超过 5 次时会发一封告警邮件（需配置 SMTP 环境变量，见下）。

**告警邮件（可选）**：需在环境中配置以下变量后，连续自动重启 >5 次时才会发信（只发一封）：`NOTION_SMTP_HOST`、`NOTION_SMTP_PORT`（可选，默认 465）、`NOTION_SMTP_USER`、`NOTION_SMTP_PASS`、`NOTION_ALERT_TO`（收件人）。未配置则仅打日志不发信。

## 仅本地使用

本工具仅设计为在本地命令行运行，请勿在无头环境或未登录状态下依赖其行为。
