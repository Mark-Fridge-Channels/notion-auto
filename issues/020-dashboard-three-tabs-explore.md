# 020 Dashboard 三 Tab — 探索结论

## 需求确认

- **Tab 1（主视图）**：全局设置、时间区间、行业与任务链、最近运行日志。
- **Tab 2（Reply Tasks）**：Reply Tasks 配置（列表、保存、加载 Task 列表、批量发送等）。
- **Tab 3（Inbound Listener）**：Inbound Listener 配置（轮询间隔、Body 限制、监听组等）。
- **Header**：三个 Tab 下都一直展示（状态 + 所有操作按钮）。

---

## 现有结构（server.ts 内嵌 HTML）

| 区域 | 行号约 | 内容 |
|------|--------|------|
| header | 521–540 | 标题、statusEl、queueSenderStatusEl、inboundListenerStatusEl、actions（启动/停止/Queue Sender/Inbound Listener/保存配置/拉取并重启）、msg |
| .layout | 542–661 | grid 容器，内含： |
| | 543–562 | card 全局设置（intervalSecondsMin/Max, loginWaitSeconds, maxRetries, autoClickButtonsContainer, btnAddAutoClickButton） |
| | 563–566 | card 时间区间（timeSlotsContainer, btnAddSlot） |
| | 567–571 | card 行业与任务链（industriesContainer, btnAddIndustry） |
| | 572–586 | card Inbound Listener 配置（inboundPollInterval, inboundBodyPlainMaxChars, inboundListenerGroupsContainer, btnAddInboundGroup, btnSaveInboundConfig） |
| | 587–609 | inboundListenerGroupModal（编辑监听组） |
| | 610–611 | card Reply Tasks 配置（replyTasksEntriesContainer, btnAddReplyTasksEntry, btnSaveReplyTasksConfig, btnLoadReplyTasksList, btnSendBatchReplyTasks, replyTasksListContainer） |
| | 612–624 | replyTasksEntryModal |
| | 625–634 | replyTasksSendModal |
| | 635–664 | industryModal（编辑行业） |
| | 655–659 | card logs-card（logTabs, logContent） |

- **Modals**：均为 `position: fixed; inset: 0`，与所在 DOM 位置无关，可放在任意一处（例如与 tab 平级或 body 末尾），从任意 Tab 打开均能正常覆盖全屏。
- **JS**：全部通过 `getElementById` 与 `onclick` 在页面加载时绑定一次，不依赖元素是否可见；隐藏 Tab 内的按钮仍在 DOM 中，点击逻辑不受影响。
- **初始化**：约 1312–1319 行依次 `loadSchedule()`、`loadInboundListenerConfig()`、`loadReplyTasksConfig()`、`refreshStatus()`，再 `setInterval(refreshStatus, 3000)`。三块数据在首屏即加载并填表，与当前显示哪个 Tab 无关；隐藏 panel 内的 input 仍保留值，无问题。

---

## 集成方式与约束

1. **唯一改动文件**：`src/server.ts`（内嵌 HTML/CSS/JS），无新依赖、无新 API。
2. **DOM 调整**：
   - Header 保持在 `<body>` 下、`.layout` 之前，不放入任何 tab-panel，即实现「三个 Tab 下都一直展示」。
   - 在 header 与 `.layout` 之间增加 **Tab 导航**（如三个 button 或 a，带 `data-tab="main"|"reply-tasks"|"inbound"`）。
   - 将 `.layout` 改为包一层「tab 容器」：内部分为三个 `.tab-panel`（例如 `id="tab-main"`、`id="tab-reply-tasks"`、`id="tab-inbound"`）：
     - **tab-main**：当前「全局设置 + 时间区间 + 行业与任务链」三张 card + 「最近运行日志」card（可继续用同一 grid，或给该 panel 单独 grid）。
     - **tab-reply-tasks**：仅 Reply Tasks 配置那张 card。
     - **tab-inbound**：仅 Inbound Listener 配置那张 card。
   - 四个 modal（inboundListenerGroupModal、replyTasksEntryModal、replyTasksSendModal、industryModal）可保留在 tab 容器外（例如放在三个 panel 之后、或 body 末尾），无需按 Tab 移动。
3. **样式**：
   - 新增 `.tab-nav`、`.tab-nav button.active`、`.tab-panel`（默认 `display: none`），当前 Tab 对应 panel 为 `display: block`（或 `display: grid` 以保持原 layout）；与现有 `.log-tabs button.active` 风格一致即可。
4. **脚本**：
   - 仅新增：Tab 按钮点击 → 去掉其他按钮的 active、为当前按钮加 active；隐藏所有 `.tab-panel`，显示当前 `data-tab` 对应的 panel。无需改现有事件绑定或 API 调用。
5. **默认 Tab**：首次进入为「主视图」（tab-main）。

---

## 边界与注意事项

- **无障碍**：若需支持键盘/屏幕阅读器，可给 tab 按钮加 `role="tab"`、`aria-selected`、panel 加 `role="tabpanel"`、`aria-hidden`；当前 scope 未明确要求，实现时可按最小实现先做，后续再补。
- **URL / 刷新**：不要求 URL hash 与 Tab 同步；刷新后仍默认主视图即可。
- **移动端**：现有 `.header`、`.layout` 已有 `@media (max-width: 768px)` 等，Tab 导航需在小屏下可换行或收缩，避免撑破布局。

---

## 无歧义、可进入实现

- Header 始终展示已确认。
- 三块内容与 modal 归属明确，无未决问题；可按上述结构在 `server.ts` 内实现三 Tab 切换。
