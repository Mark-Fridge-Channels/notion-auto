# Feature Implementation Plan: Webhook 插队任务队列

**Overall Progress:** `100%`

## TLDR

新增 **HTTP Webhook（Token 鉴权）**：调用方提交「独立形态」插队任务（`page.goto(url)` + `prompt` + **goto 超时** + **发送/输出超时** + **可选 model**），服务端 **持久化入队** 并 **立即返回已接受**（不等待执行完成）。子进程主循环在 **安全边界** 与 **可中断 sleep** 中优先消费插队队列；**running 且在间隔 sleep 中** 也可被唤醒处理插队。多账号 **轮询** 分配；**idle 账号优先**：需 **一次性执行路径**，执行结束后进程退出且 **不触发** 原 7×24 任务链/Notion 队列续跑。插队与 **Notion 队列无数据关联**；`model` 为空时 **不联动** 行业「每 M 次换模型」规则（仅当插队任务显式带 `model` 才切换）。

## Critical Decisions

- **插队载荷**：`url`、`prompt`、`timeoutGotoMs`、`timeoutSendMs`、`model?`；超时 **C 方案**：goto 与发送/输出分段超时。
- **model 语义（你已选 1）**：插队未带 `model` 时 **忽略** `sessionRuns` 触发的行业级换模型；仅 `model` 有值时对当次插队执行 `switchModel`。
- **持久化队列**：磁盘为真源；Webhook 仅 **入队**；需 **并发安全**（建议：仅 `server` 进程写队列头/状态，子进程 **认领** 或读只读视图 + 原子重命名，具体实现再定一种锁策略）。
- **安全插入点**：仅在 **`tryTypeAndSend` 与关键写回完成之后**、以及 **可中断 sleep 切片**之间拉取插队；**绝不**在发送/输出临界区内切入。
- **可中断 sleep**：将长 `sleep` 拆片，每片检查本账号待执行插队或信号，以便 **running + sleep** 仍尽快响应。
- **idle 账号执行插队**：子进程以 **显式模式**（如 CLI flag / 环境变量）启动，**只处理分配给该账号的插队任务（可多条直至空或单次策略）后正常退出**；`DashboardRunner` 对该类启动 **不设** `userWantsRunning` 自动续跑，或退出码路径 **跳过** `maybeAutoRestart`，保证 **不影响账号原运行状态**。
- **running 账号**：沿用现有子进程，在其主循环内 **插队优先**；完成后 **回到** 原任务链/队列逻辑（不改写 schedule）。
- **分配策略**：全局持久队列 + **轮询** 选择下一个可执行账号；**优先 idle**（实现上：挑选顺序 idle 先于 running-in-sleep，或两轮扫描：先 idle 再 running）。
- **API 语义**：校验 Token + 校验字段后 **202/200 + jobId**；**不同步等待** Playwright 完成。
- **鉴权**：简单 **Bearer / 固定 Header Token**（环境变量配置），不做复杂签名（按你要求「先做简单处理」）。

## Tasks

- [x] 🟩 **Step 1: 类型与持久化队列模块**
  - [x] 🟩 定义 `AdhocJob`（id、createdAt、url、prompt、timeoutGotoMs、timeoutSendMs、model?、status：`queued`|`assigned`|`running`|`done`|`failed`、assignedAccountId?、lastError?）
  - [x] 🟩 实现队列文件的读写与 **并发安全**（锁文件或 server 单写者 + 原子更新）
  - [x] 🟩 `enqueue` / `assignNextForAccount(accountId)` / `mark...` 等最小 API
  - [x] 🟩 队列路径：建议仓库根或 `data/` 下单一 JSON / JSONL（与 `accounts/` 并列，便于备份）

- [x] 🟩 **Step 2: Webhook HTTP 接口（server.ts）**
  - [x] 🟩 `POST /api/webhook/adhoc`（路径可按现有风格微调）：校验 Token、校验 url/prompt/两超时为正整数、model 可选字符串
  - [x] 🟩 入队成功返回 `{ accepted: true, jobId }`，错误返回 401/400 + 明确 message
  - [x] 🟩 入队后 **轮询** 选中下一个 **eligible** 账号（idle 优先，其次 running），写入 `assignedAccountId` 或等价字段
  - [x] 🟩 idle 被分配后：调用 **adhoc 一次性 spawn**（见 Step 4），**不**走普通 `startAccount` 无限循环

- [x] 🟩 **Step 3: index.ts — 可中断 sleep 与安全点**
  - [x] 🟩 抽取 `interruptibleSleep(totalMs, accountId|configPath)`（或等价）：短切片 + 每片检查「本账号是否有 queued/assigned 插队需立即处理」
  - [x] 🟩 替换任务链、队列模式、chainRuns 等待中的长 sleep 调用点（保持行为不变，仅增加可唤醒）
  - [x] 🟩 在每个 **安全边界**（发送与写回完成后）调用统一 `drainAdhocIfAny()`：**若存在插队** → `goto`（`timeoutGotoMs`）→ 可选 `switchModel` → `tryTypeAndSend`（使用 `timeoutSendMs`）→ 更新队列状态；再回到原分支

- [x] 🟩 **Step 4: DashboardRunner / account-manager — adhoc 一次性运行**
  - [x] 🟩 新增 `startAdhocOnce(accountId)`（命名待定）：spawn 时带 `--adhoc-job <id>` 或 `NOTION_AUTO_ADHOC_JOB=...`，且 **不** 置 `userWantsRunning=true`（或置位但子进程 exit 0 时明确不重启）
  - [x] 🟩 确保与 `stop`、stdin `stop`、普通 `start` **互斥**（同账号同时只能有一个子进程）
  - [x] 🟩 adhoc 子进程 **正常退出后** 账号回到 **idle**，且 **不会** 因 `progress.completed` / 恢复重启逻辑误启动主循环

- [x] 🟩 **Step 5: index.ts — adhoc 模式入口**
  - [x] 🟩 解析 CLI/env：加载 schedule、打开浏览器、执行 **单条或多条** 已分配给本 storage/account 的插队（按你与队列模块约定的「一次启动处理几条」——默认 **处理到无本账号 assigned 为止** 或 **只处理当前 jobId**；若未额外指定，计划在实现时取 **最小惊喜**：**仅执行 web 分配时绑定的那一条 job**，避免一次 spawn 扫光队列）
  - [x] 🟩 `page.goto` 使用 `timeoutGotoMs`；`tryTypeAndSend` 传入或包装 `timeoutSendMs`（若现有函数只接受统一 `waitSubmitReadyMs`，则扩展参数 **仅此路径** 覆盖）
  - [x] 🟩 成功/失败写回队列状态；`flushRunLogToNotion` 是否调用与现网一致策略（默认：**与任务链一致**，若需关闭再单开 issue）

- [x] 🟩 **Step 6: 文档与配置样例**
  - [x] 🟩 `env.example`：增加 Webhook Token 环境变量名说明
  - [x] 🟩 `README.md` 小节：Webhook 字段、响应语义、队列持久化文件位置、与 Dashboard 手动启停关系

---

*本计划基于前期 explore 结论：插队独立形态、持久化、Token、仅确认接受、RR、idle 优先与安全插入点；超时采用 **C（双字段）**；`model` 采用 **选项 1**。实现补充：`loadProgress(this.configPath)` 修复多账号 progress 路径；子进程完成写盘时通过 **server 定时 tryAssign（8s）** 继续分配 queued。*
