# Playwright 多浏览器残留：process.exit / SIGTERM 导致未关闭浏览器

**类型:** bug  
**优先级:** high  
**投入:** small  

---

## TL;DR

主流程在 `process.exit(EXIT_RECOVERY_RESTART)` 时直接退出，`main()` 的 `finally` 不会执行，浏览器未被 `browser.close()`；Dashboard 点击停止时发 SIGTERM，子进程被终止时同样可能不执行 `finally`，导致本机残留多个 Chromium。需在退出/收信号前统一先关浏览器。

---

## 根因

1. **恢复重启路径**：try 块内调用 `process.exit(EXIT_RECOVERY_RESTART)` 会立即终止进程，async 的 `finally` 不执行，`browser.close()` 未调用。
2. **SIGTERM 路径**：Dashboard 对子进程 `kill("SIGTERM")` 时，子进程需在 handler 内先关浏览器再 exit，否则浏览器成孤儿。

---

## 已实现方案

- **index.ts**：模块级 `currentBrowser`；`closeBrowserAndExit(code)`（带 10s 超时）；恢复重启处改为 `await closeBrowserAndExit(EXIT_RECOVERY_RESTART)`；`process.on("SIGTERM"/"SIGINT", handleStopSignal)` 先关浏览器再 exit；`finally` 中关 `currentBrowser` 并置空。
- **getConfigPathFromArgs() 里 --help 的 process.exit(0)** 在 launch 前，无需改。

---

## 涉及文件

- `src/index.ts`
