# Feature Implementation Plan: 030 最近运行日志按 Tab 区分

**Overall Progress:** `100%`

## TLDR

主视图「最近运行日志」只展示 Playwright；Queue 发信配置、Inbound Listener 的日志分别放到各自 tab 下。API 使用单一 `GET /api/logs?kind=` 按类型过滤；未传 kind 时视为 playwright。

## Critical Decisions

- **API**：保留 `GET /api/logs`，增加可选参数 `?kind=playwright|queue-sender|inbound-listener`。不传 kind 时等价于 `kind=playwright`。
- **主视图**：仅请求 `?kind=playwright`，按钮文案简化为「#id 时间」/「#id 运行中」（不再带 Queue/Inbound 前缀）。
- **各 tab 标题**：Queue / Inbound tab 下日志区块标题均为「最近运行日志」。
- **轮询与条数**：与现有一致，每 5 秒、最多 10 条。

## Tasks

- [x] 🟩 **Step 1: API 支持按 kind 过滤**
  - [x] 🟩 解析 `?kind=`，仅接受 playwright / queue-sender / inbound-listener，否则视为 playwright；按 kind 只返回对应 runner 最多 10 条。

- [x] 🟩 **Step 2: 主视图仅展示 Playwright 日志**
  - [x] 🟩 `refreshLogs()` 请求 `/api/logs?kind=playwright`；`renderLogTabs()` 按钮文案仅「#id 时间」/「#id 运行中」。

- [x] 🟩 **Step 3: Queue 发信配置 tab 增加最近运行日志**
  - [x] 🟩 在 tab-queue-sender 内增加「最近运行日志」+ queueSenderLogTabs / queueSenderLogContent；refreshQueueSenderLogs、renderQueueSenderLogTabs；初始化与 5s 轮询。

- [x] 🟩 **Step 4: Inbound Listener tab 增加最近运行日志**
  - [x] 🟩 在 tab-inbound 内增加「最近运行日志」+ inboundLogTabs / inboundLogContent；refreshInboundLogs、renderInboundLogTabs；初始化与 5s 轮询。
