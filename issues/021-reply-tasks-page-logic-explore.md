# 021 Reply Tasks 页面逻辑 — 探索结论

## 结论：无未决疑问，可直接实现

需求与现有实现已对齐，以下为实现时的**可选取舍**（不要求你拍板，按约定实现即可）。

---

## 1. Reply Tasks 配置当前选中状态

- **现状**：`renderReplyTasksEntries()` 里用 `currentReplyTasksConfig.selected_index === idx` 显示「[当前]」，行是 `industry-row`。
- **实现**：在选中行上增加 class（如 `row.classList.add('selected')` 当 `selected_index === idx`），CSS 增加 `.industry-row.selected`（如背景色或左侧 border），与现有 `.industry-row` 一致、不破坏布局。
- **无歧义**。

---

## 2. Done 不允许再次发送

- **现状**：`/api/reply-tasks/list` 返回的每项含 `status`（Notion Status 的 name，如 `"Done"`）；列表每行都有「发送」按钮。
- **实现**：判断 `t.status === 'Done'`（大小写与 Notion 一致）。可选两种方式：
  - **A**：Done 时**不渲染**「发送」按钮（更简洁，推荐）。
  - **B**：保留按钮但 `disabled` + title 提示「已完成」。
- **约定**：采用 A（不展示发送按钮），若你更希望 B 可在实现时改为 B。
- **无歧义**。

---

## 3. Task 列表增加详情按钮

- **现状**：`replyTasksList` 每项有 `pageId, taskSummary, status, suggestedReply`，列表只展示片段。
- **实现**：每行增加「详情」按钮；点击打开**新 modal**（如 `id="replyTasksDetailModal"`），内容展示：Task Summary、Status、Suggested Reply 全文。数据用当前列表项，不请求新接口。
- **安全**：Suggested Reply 可能含 HTML，详情内用**转义后文本**或只读 `textarea`/`pre` 展示，避免 innerHTML 导致 XSS。
- **无歧义**。

---

## 4. 发送回复弹窗加宽 + 富文本编辑（与 5、6 一起实现）

- **现状**：`replyTasksSendModal` 内层是 `.modal-box`，全局 `max-width: min(90vw, 360px)`；正文为 `textarea`。
- **实现**：弹窗加宽（见上）；正文编辑改为**富文本**，见下节 6。

---

## 5. 发送弹窗展示「上次对方回复内容」

- **需求**：打开发送回复弹窗时，需要看到**对方上一条回复内容**（即该 Task 关联的 Inbound Message 的邮件正文），便于在写回复时对照。
- **数据来源**：Task → relation「Inbound Message」→ IM 页面；IM 在 `notion-inbound.ts` 中写入属性 **"Body Plain"**（rich_text），即对方邮件正文的纯文本存储。
- **实现**：
  - **后端**：在 `notion-reply-tasks.ts` 的 `ReplyTaskSendContext` 中增加字段 `lastInboundBodyPlain?: string`；在 `getReplyTaskSendContext` 中读取 IM 的 `imProps["Body Plain"]`（用现有 `getRichText` 拼成字符串）并填入。新增 **GET /api/reply-tasks/context?taskPageId=xxx**：调用 `getReplyTaskSendContext`，返回 `{ suggestedReply, lastInboundBodyPlain, to?, subject? }` 等供弹窗展示（不包含敏感凭据）。若 selected 配置无效或 Task 无 IM，返回 400/404。
  - **前端**：打开发送弹窗时（`openReplyTasksSendModal`）先请求该 context API，在弹窗内**只读区域**展示「对方回复」内容（如 `<pre>` 或只读 textarea，内容转义防 XSS），下方为可编辑的正文（富文本，见 6）。
- **无歧义**。

---

## 6. 正文编辑：富文本（现成组件）

- **需求**：正文编辑支持**正常邮件正文编写**，即富文本（加粗、链接、换行等），使用**现成组件**。
- **现状**：Dashboard 为 server 内嵌单页 HTML/JS，无打包；`package.json` 无前端富文本库。
- **实现**：
  - **组件选型**：采用 **Quill**（https://quilljs.com/）— 常用、支持纯 JS 接入、可从 CDN 加载，无需改构建。若项目禁止 CDN，可改为从 `node_modules/quill/dist` 静态托管（需在 server 增加静态路由）。
  - **接入**：在 `replyTasksSendModal` 内用 `<div id="replyTasksBodyEditor"></div>` 替代正文 textarea；页面加载或首次打开弹窗时 `new Quill('#replyTasksBodyEditor', { theme: 'snow', ... })`，打开弹窗时 `quill.root.innerHTML = context.suggestedReply`（或 setContents 若为 Delta），提交时用 `quill.root.innerHTML` 作为 bodyHtml 调用现有 POST /api/reply-tasks/send。
  - **样式**：Quill 自带 CSS 需在页面引入（同 CDN）；弹窗加宽（`.modal-box--wide`）以容纳编辑区。
- **无歧义**。

---

## 涉及位置

| 项 | 位置 |
|----|------|
| 配置行 selected 样式 | server.ts：CSS .industry-row.selected；JS renderReplyTasksEntries |
| Done 不展示发送 | server.ts：renderReplyTasksList |
| 详情按钮 + 详情弹窗 | server.ts：renderReplyTasksList、新 modal + JS |
| 发送弹窗加宽 | server.ts：.modal-box--wide CSS、发送 modal 结构 |
| 对方回复展示 + context API | notion-reply-tasks.ts：ReplyTaskSendContext + getReplyTaskSendContext 读 Body Plain；server.ts：GET /api/reply-tasks/context、弹窗内只读区域 |
| 富文本编辑 | server.ts：Quill CDN script/link、#replyTasksBodyEditor 容器、初始化与取值逻辑 |

---

**是否有其他疑问：无。** 可按 issue 021 与本文约定直接写实现计划或进入 /execute。
