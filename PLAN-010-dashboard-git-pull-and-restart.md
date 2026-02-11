# Feature Implementation Plan：Dashboard Git Pull + 重启

**Overall Progress:** `0%`

## TLDR

在 Dashboard 页增加「拉取并重启」：点击后当前机器执行 `git pull`，成功则整进程重启（spawn 新 server 进程后当前进程 exit），保证新进程仍监听 9000 端口；pull 失败则仅返回错误不重启。不依赖 pm2，支持 macOS/Windows。

## Critical Decisions

- **整进程重启**：重启整个 Node 进程（含 server），使 pull 下来的所有代码生效；采用「spawn 新进程再 exit」而非只重启 runner。
- **方案 B（server 内延迟 listen）**：不新增脚本；`NOTION_AUTO_RESTART=1` 时在 server 启动处先 `await delay(2000)` 再 `server.listen(...)`，避免 EADDRINUSE，端口唯一定义在 server.ts，保证重启后仍是 9000。
- **跨平台**：git pull 用 `spawn("git", ["pull"], { cwd })`；spawn 新 server 时非 Windows 用 `spawn("npx", ["tsx", "src/server.ts"], opts)`，Windows 用 `shell: true` + 单命令（与 dashboard-runner 一致）。

## Tasks

- [ ] 🟥 **Step 1: server 启动时支持延迟 listen（方案 B）**
  - [ ] 🟥 在 `server.ts` 中，在 `createServer`/`server.listen` 之前或之间，若 `process.env.NOTION_AUTO_RESTART === "1"` 则 `await new Promise(r => setTimeout(r, 2000))`。
  - [ ] 🟥 保证 `server.listen(PORT, HOST, ...)` 仍在同一处、PORT 仍为 9000，仅增加「有条件时先等 2 秒」的分支。

- [ ] 🟥 **Step 2: 实现 git pull 与并发锁**
  - [ ] 🟥 在 `server.ts` 中增加模块级变量 `let isPullRestartInProgress = false`，在 pull-and-restart 流程开始时设为 true、结束或失败时设为 false。
  - [ ] 🟥 实现 `runGitPull(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }>`：`spawn("git", ["pull"], { cwd })`，收集 stdout/stderr，返回 exitCode 与输出；不设 shell，跨平台通用。

- [ ] 🟥 **Step 3: 实现 spawn 新 server 并 exit**
  - [ ] 🟥 实现 `spawnNewServerAndExit()`：先 `runner.stop()`；构造 `env: { ...process.env, NOTION_AUTO_RESTART: "1" }`；非 Windows：`spawn("npx", ["tsx", "src/server.ts"], { detached: true, stdio: "ignore", cwd: process.cwd(), env })`；Windows：`shell: true` + 单命令 `npx tsx src/server.ts`（可抽成与 runner 类似的转义/拼命令，或内联）。不 await 子进程，spawn 后即返回。
  - [ ] 🟥 调用方在 spawn 后立即 `process.exit(0)`（在返回 HTTP 响应之后）。

- [ ] 🟥 **Step 4: 新增 API POST /api/pull-and-restart**
  - [ ] 🟥 若 `isPullRestartInProgress` 为 true，返回 409 或 400 并 body `{ error: "拉取并重启正在进行中" }`。
  - [ ] 🟥 设置 `isPullRestartInProgress = true`，在 try/finally 中失败时设回 false。
  - [ ] 🟥 执行 `runGitPull(process.cwd())`；若 `exitCode !== 0`，返回 200 且 body `{ ok: false, error, stdout, stderr }`（或 4xx），不重启。
  - [ ] 🟥 若 pull 成功，调用 `spawnNewServerAndExit()`，返回 200 且 body `{ ok: true, message: "即将重启，请稍后刷新" }`，然后在本请求处理末尾调用 `process.exit(0)`（在 send 完响应之后）。

- [ ] 🟥 **Step 5: 前端按钮与结果展示**
  - [ ] 🟥 在 `getDashboardHtml()` 的 header `.actions` 区域增加按钮「拉取并重启」。
  - [ ] 🟥 点击后调用 `POST /api/pull-and-restart`；根据返回：`ok: true` 时提示「即将重启，请稍后刷新」；`ok: false` 或 4xx 时展示 `error` 及可选的 `stdout`/`stderr`（如拉取失败、冲突等）。可禁用按钮防重复点击，请求结束后再恢复。
