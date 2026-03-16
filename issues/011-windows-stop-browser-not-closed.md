# Windows：Dashboard 点击停止后 Playwright 浏览器未退出

**类型:** bug  
**优先级:** high  
**投入:** small  

---

## TL;DR

在 Windows 上点击 Dashboard「停止」后，Playwright 浏览器未被关掉。根因是 Windows 下 `kill("SIGTERM")` / `kill("SIGINT")` 可能无法让子进程可靠执行 handler，子进程的「先关浏览器再退出」逻辑未跑。

---

## 已实现方案（方案 2 + 3 兜底）

1. **方案 2 - stdin 发退出指令**  
   - 子进程（index.ts）：当 stdin 为 pipe 时监听 `data`，收到行 `"stop"` 则执行 `handleStopSignal(130)`（关浏览器再 exit）。  
   - Dashboard（dashboard-runner）：Windows 上 spawn 时使用 `stdio: ["pipe", "pipe", "pipe"]`；stop() 时向子进程 stdin 写入 `"stop\n"` 并 end()。

2. **方案 3 - taskkill 兜底**  
   - 发完 "stop" 后设 3s 定时器；若子进程未退出则执行 `taskkill /pid <pid> /f /t` 结束进程树（含 Chromium）。  
   - Windows 上 stop() 不立即置空 `currentProcess`，由子进程 exit 事件统一清空。

---

## 涉及文件

- `src/index.ts`：stdin 监听 "stop" 并调用 handleStopSignal。
- `src/dashboard-runner.ts`：Windows 使用 pipe stdio；stop() 写 "stop"、超时 taskkill。
