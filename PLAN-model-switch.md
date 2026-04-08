# 模型切换增强（黑名单 / 每 M 次 / 指定模型 / 队列 Rich text 列）

**Overall Progress:** `100%`

## TLDR

用 `unified-chat-model-button` 为主定位，在 Playwright 中实现 normalize、黑名单（normalize 后整行相等）、轮换与指定模型（找不到则 fallback 下一项）；任务链与 Notion 队列支持指定模型且当轮跳过「每 M 次」；Dashboard 与 `schedule.json` 同步配置。

## Critical Decisions

- 黑名单：与菜单项 **normalize 后整行相等**。
- 指定模型当轮：**不执行**「每 M 次」轮换；仅 `switchModel(name)`。
- 队列模型列：**仅 Rich text**，与 Action Name 同读取方式。
- 打开选择器：**优先** `data-testid="unified-chat-model-button"`，否则沿用发送钮左侧兄弟。

## Tasks

- [x] 🟩 **Step 1: 类型与合并** — `Schedule.modelBlacklist`、`ScheduleTask.model`、`NotionQueueConfig.columnModel`；校验与 `mergeSchedule` / `normalizeIndustry` 任务归一化
- [x] 🟩 **Step 2: model-picker** — `normalizeModelLabel`、`switchModel`、过滤 Auto/空/黑名单
- [x] 🟩 **Step 3: notion-queue** — 解析可选模型列，`QueuedTask.model`
- [x] 🟩 **Step 4: index 主循环** — 任务链与队列 + Conductor 的模型策略与 `sessionRuns` 对齐
- [x] 🟩 **Step 5: Dashboard** — 全局黑名单、任务指定模型、队列列名与说明文案
