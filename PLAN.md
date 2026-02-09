# Feature Implementation Plan

**Overall Progress:** `100%`

## TLDR

用 Playwright 实现本地 CLI：打开浏览器 → 每次运行等 1 分钟供手动登录 → 打开 Notion → 点击 Notion AI 入口 → 在弹窗中按「对话内前 3 次用分析、第 4～10 次用总结」输入并发送 → 每 2 分钟执行一轮，每 10 轮点击 New AI chat 并重置对话计数，直到达到配置的总轮数。支持登录态持久化与失败重试 3 次。

## Critical Decisions

- **登录**：脚本只负责打开浏览器；每次运行都等待 1 分钟后再导航到 notion.so；支持保存/加载 storage 以持久化登录态。
- **文案策略**：按「对话」切换。每个对话（每次点击 New AI chat 或首次打开 AI 弹窗）内：前 3 次用「@DTC Database 分析」，第 4～10 次用「@DTC Database 总结」；总轮数 = 所有对话的 (输入+发送) 次数总和。
- **结束条件**：由参数指定总轮数，跑满即退出。
- **错误处理**：单步失败时最多重试 3 次，仍失败则退出。
- **输入框**：弹窗出现后等待 1s，定位 contenteditable，先清空再输入。

## Tasks

- [x] 🟩 **Step 1: 项目与依赖**
  - [x] 🟩 初始化 package.json（name、scripts、type 等）
  - [x] 🟩 安装 playwright，添加 npm run 脚本（如 `run` / `start`）
  - [x] 🟩 如用 TypeScript：添加 tsconfig、ts-node 或 build 脚本

- [x] 🟩 **Step 2: 配置与 CLI 参数**
  - [x] 🟩 定义并解析参数：总轮数、间隔(默认 2 分钟)、登录等待(默认 1 分钟)、两条文案（分析/总结）
  - [x] 🟩 暴露为命令行参数或简单配置文件，便于本地运行

- [x] 🟩 **Step 3: 浏览器启动与登录等待**
  - [x] 🟩 使用 Playwright 启动浏览器（headed，便于登录）
  - [x] 🟩 实现「每次运行等 1 分钟」逻辑
  - [x] 🟩 若存在已保存的 storage 文件则加载，否则使用新 context；运行结束后可选保存 storage 到本地文件

- [x] 🟩 **Step 4: Notion 导航与打开 AI 弹窗**
  - [x] 🟩 导航到 https://www.notion.so/
  - [x] 🟩 定位 `img[alt="Notion AI face"]` 的父 div，点击打开 AI 弹窗
  - [x] 🟩 弹窗出现后等待 1s

- [x] 🟩 **Step 5: 单次「输入 + 发送」**
  - [x] 🟩 定位 contenteditable（如 placeholder 含 "Do anything with AI…"），点击、清空、输入当前文案
  - [x] 🟩 根据「当前对话内是第几次」决定文案：1～3 用分析，4～10 用总结
  - [x] 🟩 定位并点击发送按钮（data-testid="agent-send-message-button"）
  - [x] 🟩 将上述步骤包成可重试单元（失败重试最多 3 次）

- [x] 🟩 **Step 6: 主循环与 New AI chat**
  - [x] 🟩 维护：总已执行轮数、当前对话内轮数
  - [x] 🟩 循环：每 2 分钟执行一次 Step 5；总轮数 +1，当前对话轮数 +1
  - [x] 🟩 当当前对话轮数达到 10：定位并点击「New AI chat」（aria-label="New AI chat"），将当前对话轮数置 0，再继续
  - [x] 🟩 当总轮数达到配置值则退出

- [x] 🟩 **Step 7: 错误处理与收尾**
  - [x] 🟩 关键步骤（打开弹窗、输入、发送、New AI chat）失败时重试 3 次后退出并报错
  - [x] 🟩 退出前关闭浏览器/context，必要时保存 storage

- [x] 🟩 **Step 8: README**
  - [x] 🟩 安装与运行命令、参数说明、首次登录与持久化说明
