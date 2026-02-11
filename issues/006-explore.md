# 006 探索总结：Git Pull + 重启 · 需求与跨平台适配

## 1. 对代码与需求的理解

### 1.1 需求

- 在 Dashboard 页面上提供「拉取并重启」操作。
- 点击后：**当前机器**执行 `git pull`，成功则**重启应用**，失败（冲突等）则仅返回错误、不重启。
- 多台已 clone 的电脑各自打开自己的 Dashboard 执行一次即可同步并重启。

### 1.2 现有架构（与 006 相关的部分）

- **入口**：`npm run dashboard` → `tsx src/server.ts`。**当前进程 = HTTP server（端口 9000）**。
- **Runner**：`dashboard-runner.ts` 在 server 进程内用 `child_process.spawn` 启动**子进程**执行 `npx tsx src/index.ts`（实际跑 Notion 自动化的脚本）。
- **API**：`/api/start`、`/api/stop`、`/api/status`、`/api/schedule`、`/api/logs` 等，均在 `server.ts` 的 `handleRequest` 中处理。
- **工作目录约定**：全项目统一用 `process.cwd()` 作为「项目根」（schedule 路径、runner 子进程 cwd、progress 路径等），即约定**从项目根启动**（如 `cd notion-auto && npm run dashboard`）。

### 1.3 已确认的决策（2025-02）

| 问题 | 选择 |
|------|------|
| 重启范围 | **重启整个 Node 进程**（含 server），使 pull 下来的所有代码生效。 |
| 日常启动方式 | **`npm run dashboard`** 前台启动。 |
| 是否依赖 pm2 等 | **不依赖**；需实现「一键重启」：当前进程 spawn 新进程再 exit，无外部进程管理器。 |

---

## 2. 与现有实现的集成点

- **API**：在 `server.ts` 的 `handleRequest` 中新增 `POST /api/pull-and-restart`（或类似路径）。
- **执行 git pull**：在项目根（`process.cwd()`）下执行 `git pull`，用 `child_process.spawn` 或 `execSync`，捕获 stdout/stderr 和 exit code；非 0 视为失败，返回错误信息，不重启。
- **重启逻辑（已确定：整进程 + 不依赖 pm2）**：
  1. 先 `runner.stop()`，避免 Playwright 子进程成为孤儿。
  2. **端口交接**：新进程若立即 `listen(9000)` 会因当前进程仍占用端口而 EADDRINUSE。因此采用「延迟再起」：当前进程 spawn 一个**延迟约 2 秒后再启动 dashboard 的进程**，然后立即 `process.exit(0)` 释放端口；约 2 秒后新进程再执行 `npm run dashboard` 并成功绑定 9000。
  3. 实现延迟的方式（**选定方案 B，优先稳定**）：
     - **方案 B（采用）**：不新增脚本；在 `server.ts` 启动时若检测到环境变量 `NOTION_AUTO_RESTART=1`，则先 `await delay(2000)` 再 `server.listen(PORT, HOST, ...)`。API 里 spawn 的正是 **同一入口** `npx tsx src/server.ts` 并传入该 env，当前进程响应后 exit；新进程加载的仍是 `server.ts`，其中 `const PORT = 9000` 不变，延迟后执行 `server.listen(9000, ...)`，**从而保证重启后监听的一定是 9000 端口**。链路短、无额外脚本、端口唯一定义在 server.ts，更稳。
     - ~~方案 A~~：独立脚本 + 再起 `npm run dashboard`，链路更长、依赖 npm 解析与 cwd，不采用。
  4. 当前进程在 spawn 后立即返回 200/204 给前端（body 可带 `{ ok: true, message: "即将重启，请稍后刷新" }`），然后 `process.exit(0)`。
- **前端**：在 `getDashboardHtml()` 的 header actions 区域增加「拉取并重启」按钮，调用新 API，根据返回展示 pull 结果（成功/失败/冲突等）；若返回 204 或成功且会整进程重启，可提示「即将重启，请稍后刷新」。
- **并发**：建议加简单锁（如一个 `let isPullRestartInProgress = false`），防止重复点击导致多次 pull 或多次重启。
- **安全**：现有 server 已绑定 `127.0.0.1`，仅本机可访问，无需额外改动。

---

## 3. macOS 与 Windows 适配

### 3.1 项目里已有的跨平台模式

- **dashboard-runner.ts**（约 80–87 行）：
  - **Windows**：`process.platform === "win32"` 时使用 `opts.shell = true`，把参数用 `escapeArgForWindowsCmd` 转义后拼成一条命令 `npx tsx src/index.ts ...`，再 `spawn(fullCmd, opts)`。
  - **非 Windows**：直接 `spawn("npx", ["tsx", "src/index.ts", ...args], opts)`。
- **index.ts**：快捷键 `process.platform === "darwin" ? "Meta+a" : "Control+a"`（与 pull/重启无关，仅说明已有 platform 判断）。

### 3.2 git pull 的跨平台

- **命令**：`git pull` 在 macOS/Linux/Windows（Git for Windows）上行为一致，无需区分。
- **执行方式**：
  - 推荐：`spawn("git", ["pull"], { cwd: process.cwd(), ... })`，不设 `shell: true`。在 Windows 上只要 `git` 在 PATH 中（Git for Windows 默认会加），Node 即可找到可执行文件。
  - 若希望与现有 runner 风格完全一致，在 Windows 上也可用 `shell: true` + 单字符串 `"git pull"`，需注意工作目录在 shell 下的写法（`cwd` 仍可用）。
- **工作目录**：统一用 `process.cwd()`（与全项目约定一致），不在路径上做 `path.sep` 等区分。

### 3.3 整进程重启的跨平台（已确定：方案 B，server 内延迟 listen）

- **当前进程**：先 `runner.stop()`，再 spawn **同一 `npx tsx src/server.ts`** 并传 `env: { ...process.env, NOTION_AUTO_RESTART: "1" }`，然后立即返回 HTTP、`process.exit(0)`。
- **新进程**：加载 `server.ts`，若 `NOTION_AUTO_RESTART === '1'` 则 `await delay(2000)` 后执行 `server.listen(PORT, HOST, ...)`，其中 `PORT = 9000` 不变，**从而保证监听 9000 端口**。
- **跨平台 spawn**：与现有 runner 一致——非 Windows：`spawn("npx", ["tsx", "src/server.ts"], { detached, stdio: "ignore", cwd, env })`；Windows：`shell: true` + 单命令 `npx tsx src/server.ts`（可复用 runner 的转义方式）。

### 3.4 小结：macOS / Windows 适配要点

| 项目 | 做法 |
|------|------|
| 执行 `git pull` | 统一用 `spawn("git", ["pull"], { cwd: process.cwd() })`；若 Windows 上遇 PATH 问题再考虑 `shell: true` + `"git pull"`。 |
| 工作目录 | 全用 `process.cwd()`，与现有约定一致。 |
| 整进程重启 | 方案 B：spawn `npx tsx src/server.ts` 并传 NOTION_AUTO_RESTART=1；新进程在 server 内延迟 2s 后 `listen(9000)`，端口唯一定义在 server.ts。detached + stdio: 'ignore'；Windows 用 shell + 单命令。 |

---

## 4. 依赖与边界情况

- **依赖**：无需新 npm 包；`node:child_process`、`node:path` 已有。
- **git 可用性**：若机器未装 git 或不在 PATH，spawn 会失败，API 返回错误即可。
- **冲突/非零退出**：pull 返回非 0 时，不执行任何重启，仅把 stdout/stderr 或错误信息返回前端。
- **权限**：需对 repo 目录有写权限（与日常在终端执行 `git pull` 相同）。

---

## 5. 方案选定与端口保证

- **采用方案 B**（优先稳定）：延迟逻辑放在 `server.ts` 内，不新增脚本；spawn 的入口就是 `npx tsx src/server.ts`，与日常启动一致。
- **端口 9000 的保证**：`server.ts` 中 `const PORT = 9000` 与 `server.listen(PORT, HOST, ...)` 是唯一监听处；重启后新进程仍是同一文件，先延迟再执行同一段 `listen(PORT, HOST, ...)`，因此**最终一定是 9000 端口**。无需通过 npm 脚本或环境变量再指定端口。

需求与跨平台均已明确，可进入实现阶段。
