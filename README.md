# notion-auto

Playwright 自动化：打开浏览器 → 预留 1 分钟手动登录 → 打开 Notion → 点击 Notion AI → 按**全局轮数**选文案（可配 `--task1`/`--task2`/`--task3`，或使用 `--prompt-gateway` 每轮固定文案）定时输入并发送，每 `--new-chat-every` 轮新建对话（默认 10）；可选每 N 轮切换模型（`--model-switch-interval`，0=不切换）。起始地址由 `--notion-url` 控制。支持登录态持久化与失败重试。

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

## 运行命令

```bash
npm run run
# 带参数时必须在 run 后面加 --，否则 npm 会吞掉 --total 等选项，参数传不到脚本
npm run run -- --total 20 --interval 120 --login-wait 60
npm run run -- --model-switch-interval 50 --task1 "@Task 1" --task2 "@Task 2" --task3 "@Task 3"
npm run run -- --prompt-gateway "https://your-prompt-gateway.example/prompt"   # 每轮使用 Prompt 网关内容
```

## 参数说明

| 参数 | 说明 | 默认 |
|------|------|------|
| `--total`, `-n` | 总轮数（所有对话的 输入+发送 次数） | 25 |
| `--interval` | 每轮间隔（秒） | 120 |
| `--login-wait` | 每次运行时的登录等待（秒） | 60 |
| `--notion-url` | 脚本打开后访问的地址 | selectors 中默认 URL |
| `--new-chat-every` | 每 n 轮点击 New AI chat 新建对话，最小 1 | 10 |
| `--model-switch-interval` | 每 n 轮切换一次模型，0=不切换 | 50 |
| `--task1` | 第 1～5 轮文案 | @Task 1 — Add new DTC companies |
| `--task2` | 第 6～10 轮文案 | @Task 2 — Find high-priority contacts |
| `--task3` | 第 11 轮起随机文案之一 | @Task 3 — Find people contact (LinkedIn / Email / X) |
| `--prompt-gateway` | 使用 Prompt 网关内容，每轮均使用该文案，忽略 --task1/2/3（必填，不能为空） | - |
| `--storage` | 登录态保存路径 | .notion-auth.json |
| `--resume` | 从 progress.json 恢复进度（totalDone/conversationRuns）继续运行 | - |
| `--help`, `-h` | 显示帮助 | - |

## 行为简述

- **每次运行**：先等 1 分钟 → 若有 `.notion-auth.json` 则加载登录态 → 打开 `--notion-url` 指定地址 → 点击 Notion AI 入口打开弹窗 → **点击 New AI chat 开启新会话** → 进入主循环。
- **主循环**：每 2 分钟执行一次「输入 + 发送」；输入前用**鼠标坐标点击**输入框中心再输入；文案由 `--task1`/`--task2`/`--task3` 与全局轮数决定（若指定 `--prompt-gateway` 则每轮均使用网关内容）；若 `--model-switch-interval`>0，每 N 轮会先切换模型再发送（切换失败只打日志不退出）；本对话满 `--new-chat-every` 次后点击「New AI chat」并重置对话计数；总轮数达到 `--total` 后退出。
- **单轮失败恢复**：单轮「输入+发送」重试 3 次仍失败时**不退出**：先点 New AI chat 再试 3 次；仍失败则**刷新页面 → 点 AI 头像 → 点 New AI chat** 再试 3 次，可重复「重新打开 Notion」最多 3 次；仍失败则跳过本轮继续下一轮。
- **错误**：**模型切换**失败仅打日志并继续运行；**单轮输入+发送**失败按上述恢复流程处理，不因单轮失败退出进程。
- **收尾**：退出前保存登录态到 `--storage` 并关闭浏览器。

## Web 控制台（Dashboard）

运行 `npm run dashboard` 启动本地 Web 服务（**http://127.0.0.1:9000**，仅本机访问）。在浏览器打开后可：

- 查看运行状态（运行中 / 已停止）
- 编辑参数（保存到项目目录下的 `params.json`）
- 点击「启动」或「停止」控制脚本子进程（不重启 Web 服务）
- 查看最近 10 次运行的日志（仅内存，不落盘）

首次打开页面时脚本处于未运行状态，需点击「启动」才会执行。端口固定 9000，仅监听 localhost。

**自动恢复**：在「运行中」若脚本因异常退出，Dashboard 会自动重启并从项目目录下的 **progress.json** 恢复进度（不影响 totalDone 计数）；正常跑满总轮数则不会自动重启。连续自动重启超过 5 次时会发一封告警邮件（需配置 SMTP 环境变量，见下）。

**告警邮件（可选）**：需在环境中配置以下变量后，连续自动重启 >5 次时才会发信（只发一封）：`NOTION_SMTP_HOST`、`NOTION_SMTP_PORT`（可选，默认 465）、`NOTION_SMTP_USER`、`NOTION_SMTP_PASS`、`NOTION_ALERT_TO`（收件人）。未配置则仅打日志不发信。

## 仅本地使用

本工具仅设计为在本地命令行运行，请勿在无头环境或未登录状态下依赖其行为。
