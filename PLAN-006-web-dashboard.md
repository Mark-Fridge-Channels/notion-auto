# Feature Implementation Plan: Web 控制台（状态 / 参数 / 停止·启动 / 日志）

**Overall Progress:** `100%`

## TLDR

新增 `npm run dashboard` 启动 Web 服务（端口 9000，仅 localhost）。页面提供：运行状态（运行中/已停止）、参数编辑（持久化到 params.json）、停止/启动脚本、最近 10 次运行日志（仅内存）。仅 notion-auto 子进程被停止/启动，Web 服务常驻。

## Critical Decisions

- **入口**：新增命令启动 Web，首次打开页面时脚本未运行；不暴露 storage，固定默认值。
- **参数**：与 CLI 对应字段持久化到 params.json；服务启动时加载为表单默认值；spawn 时组装为 argv（不含 --storage）。
- **日志**：子进程 stdout/stderr 按「一次运行」聚合，内存保留最近 10 次，不落盘；可对单次运行做行数/大小上限以防内存膨胀。
- **端口与绑定**：固定 9000，仅监听 localhost。

## Tasks

- [x] 🟩 **Step 1: 参数持久化与 argv 组装**
  - [x] 🟩 定义「可序列化参数」结构（与 Config 对应，不含 storage），及与现有 Config 默认值的映射。
  - [x] 🟩 实现 params.json 的读（不存在则用默认）/写（项目目录下）；校验与 config 一致（如 prompt-gateway 非空、new-chat-every ≥ 1）。
  - [x] 🟩 实现「参数对象 → CLI argv」函数，供 spawn 使用（不包含 --storage）。

- [x] 🟩 **Step 2: 子进程管理与日志采集**
  - [x] 🟩 实现子进程 spawn（`tsx src/index.ts ...`）+ kill；维护「当前是否在运行」状态。
  - [x] 🟩 采集子进程 stdout/stderr，按「本次运行」聚合；内存中保留最近 10 次运行，每次可设行数/大小上限。
  - [x] 🟩 提供：启动( params )、停止()、获取状态()、获取最近 N 次运行日志() 的接口供服务层调用。

- [x] 🟩 **Step 3: HTTP 服务与 API**
  - [x] 🟩 创建 HTTP 服务，监听 127.0.0.1:9000。
  - [x] 🟩 API：GET 运行状态；GET 当前参数（来自 params.json 或默认）；POST 保存参数（写 params.json）；POST 停止；POST 启动（用当前 params）；GET 最近 10 次运行日志。
  - [x] 🟩 静态或内联：提供前端页面入口（如 GET / 返回 HTML）。

- [x] 🟩 **Step 4: 前端页面**
  - [x] 🟩 单页：展示运行状态（运行中/已停止）；参数表单（total、interval、notion-url、new-chat-every、model-switch-interval、prompt-gateway、task1/2/3），与 API 同步；停止 / 启动按钮。
  - [x] 🟩 日志区：展示最近 10 次运行日志（可切换或折叠每次）；当前运行支持实时追加（轮询或 SSE 二选一，优先简单实现）。

- [x] 🟩 **Step 5: 入口与文档**
  - [x] 🟩 在 package.json 增加 `dashboard` 脚本，指向 Web 服务入口（如 `tsx src/server.ts`）。
  - [x] 🟩 README 中补充：如何启动控制台、访问地址、功能简述（状态/参数/停止·启动/日志）。
