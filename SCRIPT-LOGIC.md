# 脚本逻辑说明（以当前代码为准）

入口脚本为 `npm run run`（`tsx src/index.ts`），核心行为由 `schedule.json` 决定（Dashboard 可编辑并保存）。

## 整体流程

1. **启动**：加载 `schedule.json`（或 `--config <path>` 指定）→ 解析当前时间所在的时间区间 → 选择对应行业（Playwright）。
2. **打开浏览器**：启动有头 Chromium → 若存在 `storagePath`（默认 `.notion-auth.json`）则加载登录态，否则等待 `loginWaitMs` 供手动登录。
3. **打开 Notion AI**：点击 Notion AI 入口，必要时关闭 “Personalize your Notion AI” 弹窗 → 点击 New AI chat。
4. **进入 7×24 主循环**：按行业任务链顺序执行输入+发送；跨时间区间时切换行业 URL 与任务链。

## 主循环（7×24 运行直到用户停止）

- **任务链**：对每个任务执行 `runCount` 次「输入+发送」。
- **每 N 次新会话**：按行业配置区间 \([newChatEveryRunsMin, newChatEveryRunsMax]\) 在“开新会话时”随机抽一个 N；会话内每跑满 N 次自动点 New AI chat 并重新抽 N/M。
- **每 M 次换模型**：按行业配置区间 \([modelSwitchIntervalMin, modelSwitchIntervalMax]\) 抽 M；会话内每跑满 M 次尝试切到下一个模型（0 表示不切换）。
- **输入+发送**：点击输入框中心 → 全选 → 输入文案 → 点发送 → 等发送按钮再次出现（支持在等待期间按配置自动点击某些按钮）。
- **轮间间隔**：每次发送完成后，在 \([intervalMinMs, intervalMaxMs]\) 内随机取值 sleep。

## 单轮失败恢复

- 先重试（`maxRetries`）
- 再点 New AI chat 后重试
- 再「刷新 → 打开 AI → New AI chat」重试（最多 3 次重新打开）
- 仍失败则以 `EXIT_RECOVERY_RESTART` 退出，交由 Dashboard 拉起自动重启（用于“卡住”类问题）。

## 进度与恢复

- **progress.json**（项目目录）：运行中会写入一些计数，用于 Dashboard 自动重启时的恢复信号（env `NOTION_AUTO_RESUME=1`）。当前 Playwright 主流程按“当前时间对应行业从任务 1 开始”，不恢复任务进度。
- **Dashboard 自动重启**：子进程异常退出且用户未点「停止」时，会自动再 spawn 并传 `NOTION_AUTO_RESUME=1`；连续 >5 次时会发一封 SMTP 告警（可选 env 配置，只发一封）。

## 模块分工（核心）

| 模块 | 职责 |
|------|------|
| `schedule` | `schedule.json` 的类型定义、加载/保存、校验、时间区间解析 |
| `model-picker` | 切换 Notion AI 模型 |
| `selectors` | 页面选择器与超时常量 |
| `progress` | `progress.json` 读写 |
| `alert-email` | 连续自动重启 >5 次时 SMTP 告警 |
| `queue-sender` | Warmup Executor Dry Run（`queue-sender.json`），每分钟轮询真实 Warmup 数据层并回写状态 |
| `server` | Dashboard（9000）与各子进程启停/配置 API |

> 备注：`src/config.ts` / `src/prompts.ts` 属于早期“按 CLI 参数跑固定轮数”的逻辑，当前 `npm run run` 已不走该入口。
