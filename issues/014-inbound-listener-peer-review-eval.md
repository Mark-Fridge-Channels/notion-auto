# Inbound Listener 同事审查结论 — 复核报告

对《014-inbound-listener-code-review.md》中的结论与修复逐条核实后的评估。

---

## 1. 逐条核实

### Finding 1: [MEDIUM] server.ts — `/api/inbound-listener/start` 的 configPath 未校验，路径穿越风险

**核实**：  
- 修复前：`inboundListenerRunner.startInboundListener(body?.configPath?.trim())`，用户可控 path 直接传入子进程，存在路径穿越。  
- 当前代码：存在 `resolveInboundListenerConfigPath(configured)`（45–52 行），与 `resolveConfigPath` 一致：`resolve(cwd, configured)` 后做 `relative(cwd, resolved)`，若 `rel.startsWith("..") || rel.includes("..")` 则退回 `base`；start 时使用 `inboundConfigPath = resolveInboundListenerConfigPath(body?.configPath)` 再传给 runner（251–252 行）。

**结论**：**问题曾存在，修复已正确落实。** 绝对路径（如 `/etc/passwd`）会得到含 `..` 的 rel，同样被拒绝。

---

### Finding 2: [LOW] gmail-read.ts — GMAIL_READ_SCOPES 未使用

**核实**：  
- 当前代码中已无 `GMAIL_READ_SCOPES` 常量；文件头与 `getGmailClientForRead` 上方注释均说明需在授权时申请 gmail.readonly。

**结论**：**问题已按建议修复，无残留。**

---

### Finding 3: [LOW] inbound-listener-config.ts — getInboundListenerConfigPath() 相对路径可指向 cwd 外

**核实**：  
- `getInboundListenerConfigPath()`（75–83 行）：当 `INBOUND_LISTENER_CONFIG` 为相对路径时，先 `resolve(process.cwd(), fromEnv)`，再 `relative(process.cwd(), resolved)`，若 `rel.startsWith("..") || rel.includes("..")` 则返回 `join(process.cwd(), DEFAULT_CONFIG_FILENAME)`。

**结论**：**问题曾存在，修复已正确落实。**

---

### Finding 4: [LOW] notion-inbound.ts — From Email / To Email 未 trim

**核实**：  
- createInboundMessageRow 中（87–88 行）：`"From Email": { email: (params.fromEmail ?? "").trim() || "" }`，`"To Email": { email: (params.toEmail ?? "").trim() || "" }`。

**结论**：**问题已按建议修复，空串统一为 `""`。**

---

## 2. 审查中的「Looks Good」结论

对报告中的正面结论做抽检：

- **Logging**：grep 确认 Inbound Listener 相关代码仅使用 `logger.info` / `logger.warn`，无 `console.log`。✅  
- **Error handling**：主循环与单条 message 均有 try/catch，配置加载失败有 sleep 重试。✅  
- **架构**：与 Queue Sender / Dashboard runner 模式一致，配置与 Notion 复用合理。✅  

未发现与“Looks Good”矛盾的实现。

---

## 3. 是否有遗漏风险

- **Runner 传参**：`startInboundListener` 现始终收到一个路径（默认或校验后），子进程总是带 `--config <path>`，行为与“未传时用 getInboundListenerConfigPath()”一致（默认路径相同）。✅  
- **JSON.parse 异常**：`loadInboundListenerConfig` 中 `JSON.parse(raw)` 无 try/catch，解析异常会直接抛出；由调用方（main/循环）的 try/catch 捕获并打日志，符合当前设计。无需在本轮修复中扩充。

---

## 4. 汇总与行动

### 有效结论（已确认且修复正确）

| 严重程度 | 描述 | 修复状态 |
|----------|------|----------|
| MEDIUM   | server.ts 中 configPath 未校验，路径穿越 | ✅ 已通过 resolveInboundListenerConfigPath 修复 |
| LOW      | gmail-read 未使用常量 | ✅ 已删常量并补注释 |
| LOW      | getInboundListenerConfigPath 相对路径可逃逸 cwd | ✅ 已做 .. 校验并回退默认路径 |
| LOW      | From/To Email 未 trim | ✅ 已 trim 并空串写 "" |

### 无效结论

无。同事报告中的问题均存在过，且修复与描述一致。

### 后续行动建议

- **无需新增修复**：当前 4 项均已正确落地。  
- **可选**：若希望与 schedule 的 `resolveConfigPath` 完全同源复用，可考虑抽成通用 `resolvePathUnderCwd(configured, defaultPath)`，属风格/DRY 优化，非必须。  
- 建议将本复核结论同步给该同事，并保留《014-inbound-listener-code-review.md》作为历史记录。
