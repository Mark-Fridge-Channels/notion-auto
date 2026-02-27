# Dashboard 三 Tab 切换（主视图 / Reply Tasks / Inbound Listener）

**Type:** feature  
**Priority:** normal  
**Effort:** medium  

---

## TL;DR

Dashboard 启动后改为三个 Tab 进行页面切换：第一个 Tab 为主视图（全局设置、时间区间、行业与任务链、日志等），第二个 Tab 为 Reply Tasks 配置，第三个 Tab 为 Inbound Listener 配置。

## 当前状态

- Dashboard 为单页长布局（`server.ts` 内嵌 HTML）。
- 所有内容垂直排列：header（状态 + 操作按钮）→ 全局设置 → 时间区间 → 行业与任务链 → **Inbound Listener 配置** → **Reply Tasks 配置** → 各类 modal → 最近运行日志。
- 无 Tab 切换，需滚动才能看到配置区。

## 期望状态

- 页面顶部增加 **三个 Tab**，用于切换视图：
  - **Tab 1（主视图）**：保留 header（状态与所有操作按钮）、全局设置、时间区间、行业与任务链、最近运行日志。
  - **Tab 2（Reply Tasks）**：仅展示 Reply Tasks 配置相关 UI（配置列表、保存、加载 Task 列表、批量发送等）及对应 modal。
  - **Tab 3（Inbound Listener）**：仅展示 Inbound Listener 配置相关 UI（轮询间隔、Body 限制、监听组等）及对应 modal。
- 切换 Tab 时仅显示当前 Tab 对应内容，不整页刷新；**header（状态与操作按钮）在三个 Tab 下均一直展示**。

## 需改动的文件

- `src/server.ts`：内嵌 HTML/CSS/JS
  - 增加 Tab 导航 DOM 与样式（如 `.tab-nav`、`.tab-panel`、`data-tab`）。
  - 将现有「主视图 / Reply Tasks / Inbound Listener」三块内容分别放入三个 `tab-panel`，用 JS 根据当前 Tab 显示/隐藏。
  - 为 Tab 按钮绑定点击逻辑，切换 `active` 与对应 panel 的显示。

## 风险与备注

- 保持现有 API 与事件绑定不变，仅调整 DOM 结构与展示逻辑。
- 若 header 在三个 Tab 共用，需确保「启动/停止 Queue Sender / Inbound Listener」等按钮在所有 Tab 下都可操作。
- 无新增依赖，纯前端展示层改动。
