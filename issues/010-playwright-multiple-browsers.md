# Playwright 多浏览器残留：process.exit 导致未关闭浏览器

**类型:** bug  
**优先级:** high  
**投入:** small  

---

## TL;DR

主流程在 `process.exit(EXIT_RECOVERY_RESTART)` 或 `process.exit(0)` 时直接退出，`main()` 的 `finally` 不会执行，浏览器未被 `browser.close()`，导致本机残留多个 Chromium 进程；若由 Dashboard 自动重启或多次启动，会不断叠加新浏览器实例。

---

## 当前行为

- 运行 `src/index.ts` 时，Playwright 会 `chromium.launch({ headless: false })` 启动一个浏览器。
- 正常结束或「恢复重启」时，代码在 try 块内调用 `process.exit(0)`（约 243 行）或 `process.exit(EXIT_RECOVERY_RESTART)`（约 182 行）。
- `process.exit()` 会立即终止进程，**不会执行** `main()` 的 `finally`，因此 `browser.close()` 从未被调用。
- 浏览器进程成为孤儿，继续留在系统中；Dashboard 再 spawn 新子进程时，新进程又 launch 一个新浏览器 → 出现多个浏览器同时存在。

---

## 期望行为

- 无论以何种方式退出（正常完成、恢复重启、未捕获异常），在进程退出前都应先关闭已启动的 Playwright 浏览器（即执行 `browser.close()`），保证同一时间最多只有一个由本应用启动的浏览器在运行。

---

## 涉及文件

- **`src/index.ts`**  
  - 在调用 `process.exit()` 之前先 `await browser.close()`（或抽成统一退出函数：关浏览器 → 再 process.exit）。  
  - 确保 `main().catch` 路径下若已打开过 browser，在 exit(1) 前也关闭（当前若异常发生在 try 内，finally 会执行，但 process.exit 两条路径需单独处理）。

---

## 实现要点

- **根因**：在 async main 的 try 块内使用 `process.exit()`，会跳过同一 async 函数的 `finally`。
- **建议**：
  1. 将「关浏览器」与「退出码」分离：在需要退出的分支先 `await browser.close()`，再 `process.exit(code)`；或
  2. 使用一个共享的 `browser` 引用 + 单一 `exitWith(code)` 函数，内部先关 browser（若已存在），再 `process.exit(code)`，所有退出路径都走该函数。
- 注意：`getConfigPathFromArgs()` 里 `--help` 的 `process.exit(0)` 在 launch 之前，无需关浏览器。

---

## 风险与备注

- 若 `browser.close()` 卡住（如页面无响应），可加短超时或 `close()` 失败时仍执行 `process.exit`，避免进程僵死。
- 修复后，建议在「恢复重启」和「正常完成」两种退出路径各验证一次：退出后系统内不应再留下本项目启动的 Chromium 进程。
