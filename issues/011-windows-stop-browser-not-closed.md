# Windows：Dashboard 点击停止后 Playwright 浏览器未退出

**类型:** bug  
**优先级:** high  
**投入:** small  

---

## TL;DR

在 Windows 上点击 Dashboard 的「停止」后，当前运行的 Playwright 浏览器没有被关掉，仍在继续跑。根因是 Windows 下 `child_process.kill("SIGTERM")` 要么无法让子进程收到信号，要么会直接终止进程而不触发 `process.on("SIGTERM")`，子进程里的「先关浏览器再退出」逻辑从未执行。

---

## 当前行为

- 用户在 Dashboard 点击「停止」→ `dashboard-runner.stop()` 调用 `currentProcess.kill("SIGTERM")`。
- 在 macOS/Linux 上，子进程能收到 SIGTERM，执行 `process.on("SIGTERM")` 里的 `browser.close()` 后退出，浏览器会关掉。
- 在 **Windows** 上，没有 POSIX 信号机制，Node 对 SIGTERM 的模拟往往是「立即终止进程」，子进程的 SIGTERM 回调来不及跑，或根本收不到；结果是子进程被强杀、Playwright 启动的 Chromium 成为孤儿进程继续运行，用户看到「点了停止但浏览器还在跑」。

---

## 期望行为

- Windows 上点击「停止」后，子进程应能先关闭 Playwright 浏览器再退出（与 macOS/Linux 一致），或至少保证浏览器进程随子进程一起结束，不再残留。

---

## 涉及文件

- **`src/dashboard-runner.ts`**  
  - Windows 上停止子进程的方式需调整：避免仅依赖 `kill("SIGTERM")`，改用能让子进程有机会执行退出的方式（见下），或能连子进程树一起结束的方式。

- **`src/index.ts`**（可选，视方案而定）  
  - 若采用「子进程先收退出指令再关浏览器」：需在 Windows 上增加可触发的退出路径（例如监听 stdin 或 IPC），收到后执行与 SIGTERM 相同的「关浏览器 → process.exit」。

---

## 实现要点

- **根因**：Windows 不支持 POSIX 信号，`kill("SIGTERM")` 要么不送达，要么等价于立即杀进程，子进程的 `process.on("SIGTERM")` 无法可靠执行。
- **可选方案**：
  1. **Windows 上改用 SIGINT**：部分环境下 `kill("SIGINT")` 可能能让子进程收到并执行 handler；在 `index.ts` 中为 `SIGINT` 注册与 SIGTERM 相同的「关浏览器再 exit」逻辑，在 `dashboard-runner` 里对 Windows 使用 `kill("SIGINT")`。需在 Windows 上验证是否真的能触发。
  2. **通过 stdin 发退出指令**：子进程用 `process.stdin` 可读时触发「关浏览器再 exit」；Dashboard 在 stop 时对 Windows 向子进程 stdin 写入约定字符串（如 `"stop\n"`）并关闭 stdin，子进程读完即执行退出逻辑。跨平台一致，不依赖信号。
  3. **杀进程树**：Windows 上用 `taskkill /pid <child.pid> /f /t` 结束子进程及其子进程树（含 Chromium），浏览器会被系统杀掉。缺点：子进程没有机会做保存状态等清理，仅适合「只要停掉即可」的场景。

建议优先尝试 1，若 Windows 上 SIGINT 仍不可靠则采用 2；3 可作为兜底或与 2 结合（先发 stdin 指令，超时后再 taskkill）。

---

## 风险与备注

- 若使用 taskkill 杀进程树，需确认只杀当前 runner 的子进程，不影响其他 Node/Playwright 进程。
- 若用 stdin 方案，需保证子进程在运行中确实在监听 stdin（例如 setEncoding + on("data")），且 Dashboard 只向自己的 currentProcess 写 stdin。
