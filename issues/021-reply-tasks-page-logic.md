# Reply Tasks 页面逻辑调整

**Type:** feature  
**Priority:** normal  
**Effort:** medium  

---

## TL;DR

Reply Tasks Tab 六项调整：配置项当前选中状态更明确、Done 任务禁止再次发送、Task 列表增加详情查看、发送回复弹窗加宽、弹窗内展示对方上次回复内容、正文编辑改为富文本（现成组件如 Quill）。

## 当前状态

- **配置**：已有 `selected_index` 与文案「[当前]」，无高亮样式。
- **Task 列表**：每条有 Task Summary、Status、Suggested Reply 片段、「发送」按钮；Status=Done 仍可点发送（会走 API，后端可标 Done 但重复发送无意义且易误操作）。
- **详情**：无单独详情入口，仅列表行内片段 + title tooltip。
- **发送回复弹窗**：`replyTasksSendModal` 使用 `.modal-box` 默认 `max-width: min(90vw, 360px)`，正文为 textarea；无「对方回复」展示，无富文本编辑。

## 期望状态

1. **Reply Tasks 配置当前选中状态**
   - 当前选中的配置项在视觉上明确区分（如整行高亮、左侧竖条、或与「[当前]」配套的 class），便于一眼识别当前库。

2. **Done 不允许再次发送**
   - 「当前库 Task 列表」中，若某条 Task 的 Status 为 Done，则：
     - 不展示「发送」按钮，或展示为禁用（disabled）并 tip 说明已完成；
   - 避免对已 Done 任务误点发送。

3. **Task 列表增加详情按钮**
   - 每条 Task 增加「详情」按钮；点击后展示该 Task 的详情（如 Task Summary、Status、Suggested Reply 全文、可选其他字段），以弹窗或抽屉形式展示即可；数据可用列表已加载的 `replyTasksList` 中对应项，无需新增接口。

4. **发送回复弹窗加宽**
   - 「发送回复（可编辑正文）」弹窗宽度加大（如 `max-width: min(90vw, 720px)` 或类似），正文区域支持多行、可处理简单富文本（保留现有 textarea 或改为 contenteditable/简单富文本控件均可，以能看清、可编辑为准）。

5. **发送弹窗展示「上次对方回复内容」**
   - 打开发送回复弹窗时，需展示该 Task 对应的**对方上一条回复内容**（即关联的 Inbound Message 的邮件正文），方便编写回复时对照。数据来源：Task → Inbound Message → 属性「Body Plain」。

6. **正文编辑为富文本（现成组件）**
   - 正文编辑需支持**正常邮件正文编写**（富文本：加粗、链接、换行等），使用**现成组件**（如 Quill）实现，而非纯 textarea。

## 需改动的文件

- **`src/server.ts`**
  - Reply Tasks 配置列表渲染：为选中行加 class（如 `.selected`），并补充对应 CSS。
  - Task 列表渲染：根据 `t.status === 'Done'` 隐藏或禁用「发送」；增加「详情」按钮及详情弹窗（新 modal 或复用结构），展示 taskSummary / status / suggestedReply 等。
  - 发送回复弹窗：加宽（`.modal-box--wide`）；增加「对方回复」只读展示区，打开弹窗时请求 context API 并填入；正文区改为富文本组件（如 Quill，CDN 引入），提交时取编辑器 HTML。
- **`src/notion-reply-tasks.ts`**
  - `ReplyTaskSendContext` 增加 `lastInboundBodyPlain?: string`；`getReplyTaskSendContext` 从 IM 的「Body Plain」读取并填入。
- **`src/server.ts`（API）**
  - 新增 **GET /api/reply-tasks/context?taskPageId=xxx**：返回该 Task 的 suggestedReply、lastInboundBodyPlain、to、subject 等，供发送弹窗展示与预填。

## 风险与备注

- 后端 `/api/reply-tasks/list` 已返回 `status`，无需改该接口。
- 详情内容用前端已有列表数据即可，无需新增「单条 Task 详情」API。
- **对方回复**：需新增 GET /api/reply-tasks/context，内部调用现有 getReplyTaskSendContext 并扩展其返回（IM 的 Body Plain）；若 Notion 中 IM 无「Body Plain」列则返回空串。
- **富文本**：采用 Quill 等现成组件，建议 CDN 引入（无构建改动）；若不允许 CDN，需在 server 中静态托管 node_modules/quill/dist 或等价方案。
