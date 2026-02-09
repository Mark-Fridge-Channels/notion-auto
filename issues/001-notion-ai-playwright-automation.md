# Playwright 自动操作 Notion AI 任务

**类型**: feature  
**优先级**: normal  
**预估工时**: medium  

---

## TL;DR

用 Playwright 自动化：打开浏览器 → 预留 1 分钟手动登录 Google → 打开 Notion → 点击 Notion AI 入口 → 在弹窗中输入可配置的 AI 指令并发送 → 每 2 分钟执行一次输入+发送，执行 10 次后点击「New AI chat」再继续，循环执行。

---

## 当前状态 vs 期望结果

| 当前 | 期望 |
|------|------|
| 无自动化 | 脚本自动打开浏览器，预留登录时间后打开 Notion，按固定流程点击 Notion AI、输入参数化文案、发送，并支持每 2 分钟执行一轮、10 轮后新建对话并重置计数 |

---

## 需求拆解

### 1. 启动与登录等待
- 打开浏览器（建议 headed 或可配置，便于手动登录）。
- 留出 **1 分钟** 给用户手动完成 Google 登录。
- 之后自动进入后续步骤。

### 2. 打开 Notion 并打开 Notion AI
- 打开：`https://www.notion.so/`。
- 定位元素：`<img src="/_assets/9ade71d75a1c0e93.png" alt="Notion AI face" ...>` 的**上级 div**。
- 对该 div 执行**鼠标点击**，用于打开 Notion AI 入口。

### 3. 弹窗内输入（参数化）
- 页面出现弹窗后，定位输入区域：
  - 可选方式之一：`div.content-editable-leaf-rtl` 且 `placeholder="Do anything with AI…"`（或包含该文案的 contenteditable）。
- 对该输入区域：**模拟鼠标点击** → **键盘输入** 文案。
- 文案需为**可配置参数**，默认示例：`"@DTC Database 分析"`（建议通过 CLI 参数、环境变量或配置文件传入）。

### 4. 发送消息
- 定位发送按钮：`div[role="button"][data-testid="agent-send-message-button"][aria-label="Submit AI message"]`。
- 对该元素执行**点击**，完成发送。

### 5. 定时循环与「新建对话」逻辑
- **每 2 分钟**执行一次：步骤 3（输入）+ 步骤 4（发送），计为 **1 次**。
- **记录执行次数**；当次数达到 **10 次** 时：
  - 先定位并点击「New AI chat」按钮：`div[role="button"][aria-label="New AI chat"]`。
  - 再继续执行步骤 3、4。
  - **重置计数**为 0，重新开始计 10 次。
- 即：每 10 次输入+发送后，新建一次 AI 对话，再继续。

---

## 涉及文件/实现建议

- `package.json` — 加入 Playwright 依赖与运行脚本。
- `src/notion-ai-automation.ts`（或 `.js`）— 主流程：启动浏览器、等待登录、打开 Notion、定位并点击 AI 入口、输入、发送、定时与计数、新建对话。
- `src/config.ts` 或 CLI — 输入文案参数（如 `--prompt="@DTC Database 分析"`）、可选：登录等待时长、轮询间隔、每轮次数等。
- `README.md` — 使用说明：安装、登录、参数、运行命令。

**定位策略建议**：  
优先用稳定选择器（如 `data-testid`、`aria-label`、`placeholder`）；img 的 `src` 可能随 CDN 变化，可用 `alt="Notion AI face"` 或父级可识别属性定位父 div。

---

## 风险与注意事项

- **选择器稳定性**：Notion 为 SPA，类名或结构可能随版本变化；建议用 `data-testid`、`aria-label`、`role` 等，并加适当 `waitForSelector`/超时与重试。
- **登录态**：若支持，可考虑将登录后的 storage/cookies 持久化复用，避免每次跑脚本都要重新登录（可选后续优化）。
- **弹窗与时机**：点击 Notion AI 后弹窗可能出现动画，需在输入前等待弹窗和输入框可见/可编辑。
- **频率与限流**：每 2 分钟发一次、10 次后新建对话，需确认不违反 Notion 使用条款或触发风控。

---

## 验收要点

- [ ] 启动后留 1 分钟供用户登录 Google。
- [ ] 能打开 Notion 并点击 Notion AI 入口（img 的上级 div）。
- [ ] 弹窗内能定位输入框并输入**可配置**的文案（默认 `"@DTC Database 分析"`）。
- [ ] 能定位并点击发送按钮完成发送。
- [ ] 每 2 分钟执行一次「输入 + 发送」，并正确计数。
- [ ] 满 10 次后点击「New AI chat」，重置计数并继续执行。
