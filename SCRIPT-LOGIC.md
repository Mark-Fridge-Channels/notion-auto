# 脚本逻辑说明

## 整体流程

1. **启动**：解析 CLI 参数 → 启动浏览器（有头）→ 加载或新建 context → 打开 `--notion-url` 指定地址。
2. **登录**：有已保存登录态则等 5 秒，否则等 `--login-wait`（默认 60 秒）供手动登录。
3. **打开 AI 弹窗**：点击 Notion AI 头像打开面板；若出现「Personalize your Notion AI」则点 Done 关闭。
4. **新会话**：点击 New AI chat，进入主循环。

## 主循环（每轮直到跑满 `--total`）

- **每 N 轮**（`--new-chat-every`，默认 10）：点 New AI chat，重置「本对话轮数」。
- **每 N 轮切换模型**（`--model-switch-interval`，0 不切换）：先等发送按钮可见（最多 120s），再点发送左侧打开模型弹窗、选下一项；失败只打日志不退出。
- **选文案**：若指定 `--prompt-gateway` 则每轮用该文案；否则按轮数用 task1/task2/task3（`--task1`/`--task2`/`--task3`）。
- **输入+发送**：鼠标点输入框中心 → 全选 → 输入文案 → 点发送 → 等发送按钮再次出现（最多 180s）后进入下一轮。
- **单轮失败恢复**（不退出脚本）：
  - 先重试 3 次（`--help` 中 maxRetries）；
  - 再点 New AI chat 再试 3 次；
  - 再重复「刷新页 → 点 AI 头像 → New AI chat」再试 3 次，最多做 3 次「重新打开」；
  - 仍失败则跳过本轮，继续下一轮。
- **轮间**：等待 `--interval`（默认 120 秒）。

## 模块分工

| 模块 | 职责 |
|------|------|
| `config` | CLI 参数与默认值（总轮数、间隔、登录等待、notionUrl、newChatEveryRuns、模型切换间隔、task1/2/3、promptGateway、storage、maxRetries） |
| `prompts` | 按 runIndex 选 task1/2/3 或常量默认值 |
| `model-picker` | 等发送按钮可见后，点发送左侧、打开模型弹窗、选下一项 |
| `selectors` | 页面选择器与超时常量（含 NOTION_URL 默认、AI 头像、输入框、发送按钮、WAIT_SUBMIT_READY_MS 等） |
