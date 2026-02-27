# Dashboard 三 Tab 实现计划

**Overall Progress:** `100%`

## TLDR

在 Dashboard 单页内增加三个 Tab：主视图、Reply Tasks、Inbound Listener；Header 始终展示；仅改 server.ts 内嵌 HTML/CSS/JS。

## Critical Decisions

- Header 不放入任何 tab-panel，三个 Tab 下均一直展示。
- 四个 modal 放在 tab 容器外，固定定位，从任意 Tab 打开均可。
- Tab 切换仅做 display 显隐，不重绑事件、不请求 API。

## Tasks

- [x] 🟩 **Step 1: CSS — tab-nav 与 tab-panel 样式**
  - [x] 🟩 新增 `.tab-nav`、`.tab-nav button`、`.tab-nav button.active`
  - [x] 🟩 新增 `.tab-panel`（默认 `display: none`）、`.tab-panel.active`（`display: grid` + 与现有 `.layout` 一致 grid）

- [x] 🟩 **Step 2: HTML — Tab 导航与三块 panel**
  - [x] 🟩 header 后增加 Tab 导航（主视图 / Reply Tasks / Inbound Listener）
  - [x] 🟩 原 `.layout` 拆为三个 `.tab-panel`：main（全局设置+时间区间+行业与任务链+日志）、reply-tasks（Reply Tasks card）、inbound（Inbound Listener card）
  - [x] 🟩 四个 modal 置于 panel 容器外

- [x] 🟩 **Step 3: JS — Tab 切换与默认主视图**
  - [x] 🟩 Tab 按钮点击：去其他 active、设当前 active；隐藏所有 panel、显示对应 panel
  - [x] 🟩 初始化时默认显示 tab-main（首 tab 与 panel 带 class active）
