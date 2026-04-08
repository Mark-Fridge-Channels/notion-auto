# Notion 任务运行日志

**Overall Progress:** `100%`

## TLDR

每次队列 / 任务链 / Conductor 任务在发送完成后：展开 Thought、抽取对话正文，写入 **任务日志库**。使用与队列相同的 **`NOTION_API_KEY`**；库 URL 为 **`NOTION_RUN_LOG_DATABASE_URL`**。列名与库 schema 一致（`title`、`Execute Time`、`Completion Time` 等），**不写 `Created by`**。`LLM Model` 在 `switchModel`（如有）之后、发送前从模型按钮读取。

## Critical Decisions

- **`schedule.json` 不含日志配置**；旧键 `notionRunLog` 在 `mergeSchedule` 中不再读出。
- **属性类型**：`Input Content` / `LLM Model` 按 Notion API **`rich_text`** 写入（与常见「文本」列一致）；若 retrieve 显示不同类型再调整。
- Dashboard **不再透传** `notionRunLog`。

## Tasks

- [x] 🟩 **环境变量与列名常量**（`notion-run-log.ts`）
- [x] 🟩 **移除 schedule / server 中的 notionRunLog**
- [x] 🟩 **主流程：读模型 + flush 传 `llmModel`**（`model-picker` 导出 `readModelButtonLabel`）

## 配置

1. `.env`：`NOTION_API_KEY`、`NOTION_RUN_LOG_DATABASE_URL`（任务日志库公开页或 database URL，需 Integration 可写）。
2. 数据库选项：`Status` 为 `success` / `failed`。

## 故障排除

- **`page.evaluate: __name is not defined`**：`conversation-extract` 内避免具名 `function` 与外层 `async` 传入 evaluate（tsx 可能注入 `__name`）；当前实现为同步回调 + `new Promise` + 箭头函数。
