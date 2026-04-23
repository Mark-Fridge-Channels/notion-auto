# Memory Optimization Plan

**Overall Progress:** `100%` （代码 & 文档；运行期 3 项手动验证待用户部署后勾选）

## TLDR
6 个账号同时跑 Playwright 时内存在启动瞬间就被打满（15.3GB 的 EC2），根因是 `.notion-auth.json` 里的 `origins[].localStorage` 长期单调增长（Kacey 3921 条 / ~1MB，Billy ~1MB），Notion 前端在加载 `storageState` 时会 rehydrate 这些 cache，renderer RSS 启动瞬间就到 1~2GB。本计划通过：**(A) storageState 只保留 cookies**、**(B) 降内存 Chromium args**、**(C) 主循环定时 recycle 浏览器**、**(D) adhoc 子进程并发上限**，从根源切断「越跑越胖」的飞轮，并给渲染器内存增长加一个长期兜底。

## Critical Decisions
- **Decision 1：`storageState` 只保留 cookies，丢弃所有 origin 的 localStorage** —— cookies 足以维持 Notion 登录态；localStorage 只是 Notion 前端 cache，丢失不会退登，Notion 会按需重建；这是「启动就爆」的直接根因。
- **Decision 2：cookies-only 同时用于「读」和「写」** —— `newContext({ storageState })` 只注入 cookies；`context.storageState()` 保存后再裁剪为 cookies-only 回写，确保文件不会被 Playwright 自己再度写胖。
- **Decision 3：一次性原地清洗现有 6 个账号的 `.notion-auth.json`** —— 执行前自动备份为 `.notion-auth.json.bak-<ts>`，立刻见效无须等下一次退出再瘦身。
- **Decision 4：定时 recycle 浏览器（每 H 小时 / 每 M 次发送择早触发）** —— 仅关闭当前 `currentBrowser` 并按相同 storagePath 重启 Chromium，不影响任务链/队列进度。默认 `H=6h`、`M=100`，写进 schedule 可调；设为 0 表示关闭对应维度。
- **Decision 5：Chromium 默认附带一组降内存 args** —— `--disable-dev-shm-usage`、`--disable-gpu`、`--disable-software-rasterizer`、`--disable-extensions`、`--disable-features=Translate,MediaRouter,OptimizationHints`、`--js-flags=--max-old-space-size=512`；headless 已默认 true，代码里不再强制变更。
- **Decision 6：adhoc 队列加 3 层内存/CPU 护栏** —— (a) 全局一次性 adhoc 子进程并发上限 `ADHOC_MAX_CONCURRENT_ONESHOT=1`；(b) running 账号每轮主循环只消费 1 条 adhoc 再回循环顶；(c) adhoc 发送也计入 recycle 计数。
- **Decision 7：不改 `dashboard-runner` 的 spawn 方式（继续 `npx tsx`）** —— 暂不引入编译步骤，保持现状；内存主因不在 Node 层，先控住 Chromium 这一头再说。
- **Decision 8：所有新增配置只读新字段，不删旧字段** —— schedule 向后兼容，没有迁移负担。

## Tasks

- [x] 🟩 **Step 1：`storageState` 瘦身（读写两端 cookies-only）**
  - [x] 🟩 在 `src/index.ts` 顶部新增工具 `loadStorageStateCookiesOnly(path)`：读取 JSON，返回 `{ cookies, origins: [] }`；文件不存在/损坏返回 `undefined`。
  - [x] 🟩 新增 `saveStorageStateCookiesOnly(context, path)`：调用 `context.storageState()` 拿到完整 state，写入前过滤掉 `origins`，只落 cookies；原子写（先 tmp 再 rename）。
  - [x] 🟩 替换 adhoc 一次性和主循环两处 `newContext({ storageState: path })` 为 cookies-only 版本。
  - [x] 🟩 替换 3 处 `context.storageState({ path })` 为 `saveStorageStateCookiesOnly(context, path)`。
  - [x] 🟩 失败兜底：读写 cookies-only 异常时记 warn，返回 undefined / 直接跳过保存，主循环不被打断。

- [x] 🟩 **Step 2：一次性清洗现有 `.notion-auth.json`**
  - [x] 🟩 新增 `scripts/trim-auth.mjs`：遍历 `accounts/*/` 与根目录 `.notion-auth.json`；自动备份 `.bak-<ts>`，写为 `{ cookies, origins: [] }`；打印清洗前后的 cookies/lsItems/size。
  - [x] 🟩 在 `package.json` 增加 `"trim-auth"` 脚本。
  - [x] 🟩 本地已执行：改动 4 个账号（Kacey 1.28MB→12.9KB、Paula 485KB→17KB、Mark 308KB→19.8KB、Peter 225KB→20.9KB），3 个已是 cookies-only 跳过。README 文档在 Step 6 统一补。

- [x] 🟩 **Step 3：Chromium 默认降内存 args**
  - [x] 🟩 `src/index.ts` 新增 `CHROMIUM_LOW_MEM_ARGS` + `buildChromiumArgs()`。
  - [x] 🟩 两处 `chromium.launch` 都传入 `args: buildChromiumArgs(schedule.chromiumExtraArgs)`。
  - [x] 🟩 `Schedule` 新增 `chromiumExtraArgs?: string[]` 与 `browserRecycle` 可选字段；`validateSchedule` 补类型 / 范围校验。

- [x] 🟩 **Step 4：主循环定时 recycle 浏览器（只在任务边界触发，不中断进行中任务）**
  - [x] 🟩 `Schedule.browserRecycle?` 默认 `{ everyRunsMax: 100, everyHours: 6 }`；`validateSchedule` 补范围校验。
  - [x] 🟩 `relaunchBrowser()` 关旧 launch + args + cookies-only state + newPage + goto + openNotionAI + clickNewAIChat，返回 `{ context, page }`。
  - [x] 🟩 `sendSinceRecycle` / `recycleSince` 在 main() 内维护；`tryTypeAndSend` / 队列 / adhoc 3 条成功路径全部 ++；`maybeRecycle` 闭包在 3 处循环顶调用。
  - [x] 🟩 recycle 检查点仅在：主 `for(;;)` 顶、Notion 队列内层 `for(;;)` 顶、`for (const task of tasks)` 顶；任务中间绝无 recycle。
  - [x] 🟩 recycle 不改 `chainRunsInSlot` / `sessionRuns` / `currentN` / `currentM` / `currentIndustry`；仅清零 recycle 自身的两个计数。

- [x] 🟩 **Step 5：adhoc 内存/CPU 护栏**
  - [x] 🟩 `dashboard-runner.isAdhocOnceRunning()` + `account-manager.countAdhocOnceInFlight()` 暴露一次性子进程计数。
  - [x] 🟩 `server.ts` 新增 `ADHOC_ONESHOT_MAX_CONCURRENCY`（env `NOTION_AUTO_ADHOC_ONESHOT_MAX`，默认 3），`tryDrainQueuedAssignments` 达上限后**本 tick 不再把 idle 账号纳入候选**，任务继续保持 queued 到下一 tick。
  - [x] 🟩 `drainAdhocForRunningAccount` 改为**单条消费 + 返回成功次数**（去掉 `while (true)`），由外层 main 循环下一轮再次进入。
  - [x] 🟩 adhoc 成功发送已计入 `sendSinceRecycle`（在 Step 4 的 6 处调用点全部 `+= await drainAdhoc...`）。
  - [x] 🟩 不新增 `unassignJob`：选择「**暂不分配**」而非「分配后回退」，减少队列状态抖动，实现更简。

- [x] 🟩 **Step 6：文档与验证**
  - [x] 🟩 README 新增「内存优化（多账号 / 长时间运行）」章节，覆盖 cookies-only / recycle / args / 并发上限 / 一次性清洗脚本 / 回滚方案。
  - [x] 🟩 本地已执行 `npm run trim-auth`，4 个账号完成瘦身（含备份）。
  - [x] 🟩 `env.example` 补 `NOTION_AUTO_ADHOC_ONESHOT_MAX` 默认 3 的说明。
  - [ ] 🟥 运行期手动验证（由用户在部署后执行，本轮代码改动不阻塞）：  
    a) `npm run dashboard` → 启动任意账号，确认能自动登录（cookies 生效）且能正常 `typeAndSend`；  
    b) 把 schedule `browserRecycle.everyRunsMax` 设小值（比如 3）手动触发 recycle，日志打印 `触发浏览器 recycle` 且任务继续；  
    c) 通过 webhook 插 3~5 条 adhoc，确认同一时间 oneshot 子进程数 ≤ `NOTION_AUTO_ADHOC_ONESHOT_MAX`（默认 3）。

- [ ] 🟨 **Step 7：lint 全清 + plan 100%**
  - [x] 🟩 `src/index.ts` / `src/schedule.ts` / `src/server.ts` / `src/account-manager.ts` / `src/dashboard-runner.ts` 全部无 lint 错误。
  - [ ] 🟨 提交由用户决定节奏，暂不自动 commit。

## Non-goals（本次不做）
- 不改 `dashboard-runner.ts` 的 `spawn("npx", ["tsx", ...])` 调用方式（保留现有 Node 进程链）。
- 不动 adhoc 持久化 / 锁机制本身，仅加并发护栏与单批上限。
- 不引入编译步骤（保持 `tsx` 直跑）。
- 不改 Notion 队列 / Conductor / 运行日志逻辑。
- 不升级 Playwright 版本；不切换到 `chromium-headless-shell` 通道（风险待评估，若之后还不够再做）。
