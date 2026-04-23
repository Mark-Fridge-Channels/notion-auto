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
- **industries**：行业列表，每项含 `id`、`notionUrl`、`newChatEveryRunsMin`/`newChatEveryRunsMax`（每 N 次新会话的区间，开新会话时随机取 N；0=本会话不主动新建）、`modelSwitchIntervalMin`/`modelSwitchIntervalMax`（每 M 次换模型的区间，0=不换）、`taskSource`（可选，`"schedule"` 或 `"notionQueue"`，默认任务链）、`tasks`（任务链；当 `taskSource` 为 `notionQueue` 时可为空）。
- **tasks**：每任务 `content`（输入文案）、`runCount`（本轮执行次数）。
- 顶层：`intervalMinMs`/`intervalMaxMs`（每次发送完成后等待的毫秒数区间，每次随机取）、`loginWaitMs`、`maxRetries`、`storagePath`、**notionQueue**（可选，见下）。

未配置的时间段不跑（脚本会等待直至落入某区间）。时间区间列表为空会报错退出。

## Notion 任务队列（可选）

当某行业的 **taskSource** 设为 `"notionQueue"` 时，该时段内不再使用手动编辑的任务链，而是从 **Notion 数据库** 中拉取待执行任务（Status = 待执行状态），用 Playwright 打开每条任务的 **File URL** 页面并输入 **"@" + Action Name** 执行，执行完成后按配置更新状态或删除记录。

- **环境变量**：需在 `.env` 或环境中配置 **NOTION_API_KEY**（Notion Integration Token）。未配置则仅运行任务链模式。
- **配置**：在 Dashboard 的「Notion 任务队列」区块中填写：数据库 URL、列名（Action Name / File URL / Status）、待执行状态值（默认 `Queued`）、完成后状态值（默认 `Done`）、失败后状态值（默认 `Failed`）、成功后「更新状态」或「删除记录」。
- **数据库**：Notion 数据库需包含至少三列（类型与列名与配置一致）：Action Name（Text）、File URL（URL）、Status（Select，如 Queued/Done/Failed）。数据库需分享给该 Integration。
- **到点停止**：使用 Notion 队列时，**时间一到（离开当前时间区间）只跑完当前正在执行的那条任务即停**，不再从队列取新任务；与手动任务链「跑满 N 轮再等离开时段」不同。

## Webhook 插队任务（可选）

与 **Notion 任务队列**无关：单独 HTTP 入队，持久化在 **`data/adhoc-queue.json`**（锁文件 `data/adhoc-queue.lock`）。每条任务字段：`url`（`page.goto` 目标）、`prompt`、`timeoutGotoMs`、`timeoutSendMs`、可选 `model`（仅当提供时才切换模型，不触发行业「每 M 次换模型」）。

- **鉴权**：环境变量 **`NOTION_AUTO_WEBHOOK_TOKEN`**。请求头 **`Authorization: Bearer <token>`** 或 **`X-Webhook-Token: <token>`**。
- **接口**：`POST /api/webhook/adhoc`，JSON body 见上；**202** 响应 `{ "accepted": true, "jobId": "<uuid>" }`（仅表示已入队/接受，不等待 Playwright 完成）。
- **分配**：在 Dashboard 已加载的账号间 **idle 优先**，其次 **running**（主循环在间隔 sleep 中可被唤醒）；同档内轮询；每账号同时仅一条「已分配/执行中」插队。
- **idle 账号**：Dashboard 为该账号启动 **一次性子进程**（`--adhoc-job`），跑完即退出，**不会**接着跑原 schedule 主循环。
- **running 账号**：由现有子进程在安全点与可中断 sleep 中消费插队；完成后尝试回到当前行业 Portal 并 New chat，再继续原任务链/队列。
- **积压**：无可用账号时任务保持 `queued`；Dashboard 进程内 **约每 8 秒** 尝试再次分配，插队终态后也会触发分配；单次分配轮询有上限，大量积压会分多轮消化。
- **限制**：请求体约 **512KB** 上限；`url` / `prompt` / `model` 长度在服务端有上限（与磁盘恢复校验一致），避免过大 JSON 撑爆队列文件。

curl -sS -X POST http://127.0.0.1:9000/api/webhook/adhoc \
  -H "Authorization: Bearer 1234567890" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://www.notion.so/34a9166fd9fd80ec8d04c37260db78ed?source=copy_link","prompt":"@生成一段开心的话 ","timeoutGotoMs":60000,"timeoutSendMs":120000}'

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
- 编辑**全局设置**（每轮间隔、登录等待、重试）、**Notion 任务队列**（可选：数据库 URL、列名、状态值）、**时间区间**（起止小时、绑定行业）、**行业与任务链**（URL、任务来源「任务链」或「Notion 队列」、N/M、任务输入内容与执行次数），保存到 **schedule.json**
- 点击「启动」或「停止」控制脚本子进程（启动前会先保存当前配置）
- 查看最近 10 次运行的日志（仅内存，不落盘）

首次打开页面时脚本处于未运行状态，需点击「启动」才会执行。端口固定 9000，仅监听 localhost。

**自动恢复**：脚本异常退出时 Dashboard 会自动重启；脚本按当前时间对应行业从任务 1 开始（不恢复任务进度）。连续自动重启超过 5 次时会发一封告警邮件（需配置 SMTP 环境变量，见下）。

**告警邮件（可选）**：需在环境中配置以下变量后，连续自动重启 >5 次时才会发信（只发一封）：`NOTION_SMTP_HOST`、`NOTION_SMTP_PORT`（可选，默认 465）、`NOTION_SMTP_USER`、`NOTION_SMTP_PASS`、`NOTION_ALERT_TO`（收件人）。未配置则仅打日志不发信。

## 内存优化（多账号 / 长时间运行）

多账号同时启动 Chromium（尤其在 EC2 等低内存机器上）时，一段时间后内存会被打满。原因是：

1. Playwright 的 `storageState` 默认把 Notion 前端的 **localStorage 缓存**（block / queryCache / AI 会话元数据）一起落盘，单账号 auth 文件可涨到 1MB+；每次新 context 会把这些数据注入 Chromium，Notion SPA 启动瞬间 rehydrate 出大量 JS 堆。
2. 长时间运行的单个 Chromium 进程会累积 renderer 堆碎片、已关闭的 page 残留、Blink 内部 cache。

本仓库已内置以下优化：

- **只持久化 cookies**：`loadStorageStateCookiesOnly` / `saveStorageStateCookiesOnly` 读写时过滤掉 `origins`，登录态不丢；localStorage 由 Notion 按需重建。
- **Chromium 降内存 launch args**：`--disable-dev-shm-usage`、`--disable-gpu`、`--disable-software-rasterizer`、`--disable-extensions`、关键 features 关闭、`--js-flags=--max-old-space-size=512`。schedule.json 可追加 `chromiumExtraArgs?: string[]` 微调。
- **定时 recycle 浏览器**：默认每 **50 次成功发送**或**超过 6 小时**，在**任务边界**关闭并重新 launch Chromium（cookies 热加载，继续跑）。可通过 schedule.json 的 `browserRecycle?: { everyRunsMax?: number; everyHours?: number }` 调整；任一字段填 `0` 即关闭该维度。
- **任务不中断**：recycle 检查点仅放在 3 处循环顶（主循环 / Notion 队列内层 / 任务链内层），绝不在 `tryTypeAndSend` / `page.goto` / 状态回写之间触发。已完成的发送与状态更新不会丢，只会「换一个干净的浏览器继续下一条」。
- **Webhook 插队并发上限**：env `NOTION_AUTO_ADHOC_ONESHOT_MAX`（默认 3）限制同时最多启动的一次性子进程个数；超限时任务保持 `queued`，空位释放后继续分配。running 账号走进程内消费，每轮主循环最多 1 条，避免连续发多条导致 renderer 暴涨。
- **Dashboard「全部启动」错峰**：env `NOTION_AUTO_STARTUP_STAGGER_MS`（默认 25000ms）控制相邻账号的启动间隔，避免同一秒 N 个 Chromium 一起抢带宽 / CPU / swap，引发 Notion SPA 初刷互相拖累、`page.goto` 30s 超时。设为 `0` 回到旧行为（同时启动）。
- **`page.goto` 超时兜底**：Notion 首页 / recycle 后的初次 `page.goto` 超时放宽到 **90s**，并在 `openNotionAI` 里做 URL 去重——如果当前 `page.url()` 已经指向目标页（origin+pathname 相同），不再 goto 第二次，直接等 AI 入口。避免「同 URL 双导航」在 renderer 忙时 timeout 30s。

### 一次性清洗历史 auth 文件

升级到当前版本后，**仓库里老的 `.notion-auth.json` 可能仍包含大量 localStorage**（观察到过单账号 1.28MB、3900+ 条）。执行一次性瘦身：

```bash
npm run trim-auth
```

脚本会：

1. 扫描 `./accounts/*/` 与根目录的 `.notion-auth.json`；
2. 为每个文件生成 `.bak-<yyyyMMddHHmmss>` 备份；
3. 原地写为 `{ cookies, origins: [] }`，打印前后 cookies / lsItems / 文件大小对照。

登录态不受影响（cookies 全保留）。如需回滚，把备份文件改回原名即可。

## 仅本地使用

本工具仅设计为在本地命令行运行，请勿在无头环境或未登录状态下依赖其行为。
