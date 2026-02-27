# Dashboard 前端代码重构：拆分为符合项目架构的模块

**类型**: improvement  
**优先级**: normal  
**预估投入**: medium-high

---

## TL;DR

将 `server.ts` 里「一大段」的 Dashboard 实现（单页 HTML + 内联 CSS + 内联 ~700 行 JS）拆成符合项目架构的模块化代码，便于维护和扩展。本文档同时评估**改动量、风险与潜在 bug**。

---

## 当前状态

- **位置**: `src/server.ts` 中 `getDashboardHtml()`（约 474–1444 行）。
- **形态**: 一个巨型模板字符串，包含：
  - 完整 HTML 结构（head + body）
  - 约 90 行内联 CSS
  - 约 700 行内联 `<script>`（Tab 切换、主视图、Reply Tasks、Inbound Listener、行业/时间槽/弹窗、API 调用、日志等全部写在一起）
- **后端**: 已模块化（`dashboard-runner.ts`、`dashboard-queue-sender-runner.ts`、`dashboard-inbound-listener-runner.ts`、`schedule.js`、`inbound-listener-config.js`、`reply-tasks-config.js` 等），只有前端是一整块。

---

## 期望状态

- Dashboard 的 **HTML / CSS / 前端 JS** 以「符合项目架构」的方式组织，而不是单文件里一大段字符串。
- 具体形态可在实现时选定，例如：
  - 独立 HTML 模板文件（或按 tab/区块拆成多个片段）+ 独立 CSS 文件 + 一个或多个前端 JS 模块（通过构建打包或静态资源引入）；
  - 或继续由 Node 输出 HTML，但 HTML/CSS/JS 内容从**独立模块/文件**读取并组装，而不是一个超长模板字符串。

---

## 涉及文件

| 文件 | 说明 |
|------|------|
| `src/server.ts` | 当前包含 `getDashboardHtml()`、`getDashboardTitle()`、以及 `path === "/"` 时返回 HTML 的逻辑；重构后改为从模块/静态资源组装或指向静态入口。 |
| 新增（按选定方案） | 如：`src/dashboard/index.html`、`src/dashboard/styles.css`、`src/dashboard/` 下按功能拆分的 JS 模块，或 `static/` 目录等。 |

---

## 改动量评估

| 维度 | 评估 |
|------|------|
| **代码行数** | 约 **970 行** 从 `server.ts` 迁出（HTML + CSS + 内联 script）。若拆成多文件，总行数可能略增（模块边界、导入等）。 |
| **文件数** | 当前 1 个文件内一大段 → 预计 **5–15 个** 新文件（模板/片段、CSS、JS 模块、可能的构建配置）。 |
| **架构选择** | 若引入构建（如 esbuild/rollup/vite）或静态资源服务，需确定：是否保留「单次 `npm run dashboard` 启动即用」、是否增加构建步骤。 |

结论：**改动量为中到大**，集中在「前端如何拆分、如何被 server 使用」；后端 API 与路由可基本不动。

---

## 风险评估

| 风险 | 级别 | 说明 |
|------|------|------|
| **行为不一致** | 中 | 内联 script 依赖大量闭包与全局 DOM 引用（如 `currentSchedule`、`replyTasksQuill`、各 `getElementById`）。拆成模块后若作用域/初始化顺序处理不当，会出现「点击无反应」「配置不保存」等。 |
| **资源路径与部署** | 中 | 若改为独立 CSS/JS 文件，需在 server 中挂静态路由或通过构建注入路径；路径错误会导致 404、白屏或样式/脚本不加载。 |
| **首屏与依赖顺序** | 低–中 | 当前 Quill 通过 CDN 在页面内顺序加载；拆成多脚本后需保证加载顺序或使用模块系统，否则 Quill 未就绪时可能报错。 |
| **回归范围** | 中 | 三 Tab（主视图 / Reply Tasks / Inbound）、所有弹窗、保存/加载/发送逻辑都会被动到，需系统回归。 |

整体：**风险中等**，通过「按功能分步迁移 + 每步可手动/自动化验证」可控制在可接受范围。

---

## 潜在 Bug 与注意点

1. **事件绑定与 DOM 时机**  
   当前在 IIFE 内直接 `document.getElementById(...).onclick = ...`。拆成模块后若在 DOM 未就绪时执行，会报错或绑定失败。需保证脚本在 DOM 就绪后执行，或使用事件委托。

2. **共享状态与闭包**  
   `currentSchedule`、`currentInboundConfig`、`currentReplyTasksConfig`、`replyTasksSendTaskPageId`、`replyTasksQuill`、`editingIndustryIndex`、`runs` 等目前都在同一 script 作用域。拆开后要么放在单一「状态」模块，要么通过参数/事件传递，否则容易出现「点保存没反应」「弹窗数据错乱」。

3. **API 路径与 base URL**  
   当前使用相对路径 `fetch('/api/...')`。若将来 Dashboard 不在根路径（如 `/dashboard`），需统一 base URL 或配置，否则请求 404。

4. **escapeHtml / escapeAttr / truncateUrl**  
   多处拼接 HTML 时依赖这些工具函数。拆出后需保证所有生成 HTML 的模块都能访问到同一实现，避免 XSS 或显示异常。

5. **Quill 实例生命周期**  
   Reply Tasks 发送弹窗里 Quill 只创建一次（`if (!replyTasksQuill)`）。若拆成独立「Reply Tasks 模块」，需保证该实例在 Tab 切换或多次打开弹窗时仍可用且不重复创建。

6. **日志 Tab 与 runs 数组**  
   `renderLogTabs` 依赖 `runs` 与 `logTabs`/`logContent`。若日志逻辑拆到单独模块，需与「主入口」或状态模块约定好数据源与 DOM 引用。

7. **构建与运行方式**  
   若引入前端构建，需确保 `npm run dashboard`（或现有启动方式）在开发/生产下都能正确提供或生成静态资源，避免本地能跑、部署后 404。

---

## 建议实施方式（降低风险）

- **分步拆**：先只把 **HTML 结构** 和 **CSS** 抽到独立文件/模块，由 `getDashboardHtml()` 拼成字符串或 stream 输出，行为不变；再拆 **JS**（先按 Tab 或功能块拆成几个大块，再细化）。
- **每步可测**：每步完成后在浏览器里走一遍：三 Tab 切换、主视图保存/加载、Reply Tasks 加载/发送、Inbound 配置保存、日志刷新。
- **尽量保持单文件输出一段时间**：若暂不引入构建，可保持「Node 读多个模板/JS 文件后拼成单 HTML 响应」，这样部署与当前一致，仅代码结构变化。

---

## 验收标准（建议）

- [ ] Dashboard 的 HTML/CSS/JS 不再以「一大段」形式存在于 `server.ts`。
- [ ] 现有功能不变：三 Tab、主视图配置与时间槽/行业、Reply Tasks 配置与列表/发送、Inbound 配置、日志、拉取并重启等均正常。
- [ ] 新结构有简单说明（如 README 或代码内注释），说明各模块/文件职责与组装方式。
