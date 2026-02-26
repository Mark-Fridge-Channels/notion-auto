# Queue Sender 探索：集成点、依赖与待澄清

**目标**：在不动手实现的前提下，搞清楚 Queue Sender 与现有代码库的集成方式、依赖、边界与歧义，并列出需要你确认的问题。

---

## 1. 现有代码库要点

### 1.1 入口与调度

- **主流程**：`src/index.ts` 由 Dashboard 通过 `dashboard-runner.ts` 以子进程方式启动：`npx tsx src/index.ts --config <path> --storage .notion-auth.json`。
- **配置**：只认 `schedule.json`（或 `--config` 指定路径），通过 `loadSchedule()` 得到 `Schedule`（时间区间 + 行业列表）；**没有** Notion API、没有 Gmail API、没有「Queue」概念。
- **行业**：`ScheduleIndustry` 目前只有 `id`、`notionUrl`、N/M 区间、`chainRunsPerSlot`、`tasks[]`；`notionUrl` 仅用于 Playwright 打开页面，不用于 API。

### 1.2 依赖

- **package.json**：`playwright`、`nodemailer`（仅告警邮件）、`dotenv`。**没有** `@notionhq/client`，**没有** Gmail API（`googleapis`）。
- **发信**：当前只有 `src/alert-email.ts` 用 nodemailer 发 SMTP；**没有**按 thread 发信、没有 Gmail API 的 `messages.send` / threadId。

### 1.3 配置与凭证

- **env.example**：仅有 `NOTION_AUTO_NAME`、SMTP 告警相关；**没有** `NOTION_API_KEY`、没有 Gmail OAuth/Service Account 相关变量。
- **工作目录**：Runner 与 schedule 均以 `process.cwd()` 为项目根；Queue Sender 若独立运行，同样可约定从项目根读 env 与配置文件。

---

## 2. Queue Sender 与现有结构的集成方式

### 2.1 结论：独立入口更合适

- Queue Sender 的节奏是「每 5–10 分钟跑一批、10:00–18:00」，且需在 Queue Builder 执行时暂停；现有主流程是「7×24 按时间区间切行业 + Playwright 任务链」，两者**无共享状态**（不共用浏览器、不共用 schedule 的行业任务链）。
- 因此更合适做成**独立入口**，例如：
  - 新脚本：`src/queue-sender.ts`（或 `scripts/queue-sender.ts`），通过 **cron / 系统定时任务** 或 **Dashboard 上的单独「启动 Queue Sender」** 调用，例如：`npx tsx src/queue-sender.ts --config queue-sender.json`。
- 不在 `index.ts` 里按「行业类型」分支成 Playwright vs Queue：那样会把两套完全不同的依赖（Playwright vs Notion API + Gmail API）和运行节奏绑在一起，复杂度高且易混。

### 2.2 配置从哪来（已确认）

- **采用现有 schedule + Dashboard**：不新增独立配置文件。在 **schedule.json** 的行业列表里支持第二种行业类型「Queue」：该类型行业配置 Queue 数据库 URL、批量大小等；时间区间仍按现有方式引用 `industryId`。当某时段绑定的行业是 Queue 类型时，Queue Sender 在该时段内执行该 Queue 的发送。
- **Dashboard**：在「行业与任务链」中增加 Queue 发送的配置（如行业类型选择 Playwright / Queue，Queue 时展示 Queue 数据库 URL、批量等），与现有行业编辑同一套列表与时段配置。

### 2.3 与 Dashboard 的关系（已确认）

- **Queue Sender 是一个常驻服务**，进程一直在运行；**Dashboard 控制什么时候调用这个服务进行执行**（例如 Dashboard 上有「启动 Queue Sender」/「停止 Queue Sender」，与现有 Playwright 的启动/停止类似；当「启动」后，服务按**现有 Dashboard 的时段配置**在允许的时间窗口内执行发送，例如每 5–10 分钟跑一批）。
- 即：复用现有**时段配置**决定「何时可以跑 Queue Sender」；时段内若当前行业为 Queue 类型，则执行该 Queue 的拉取与发送。

---

## 3. 依赖与实现边界

### 3.1 需要新增的依赖

- **Notion API**：`@notionhq/client`，用于查询 Queue 数据库（filter + sort）、更新 page 属性（含 Email Status、Sent At Last、Thread ID、Message ID Last、Subject Last、Needs Review、Stop Flag、**Stop Reason（text）** 等）；并查询**发件人库**（按 Email 匹配 Sender Account，取 Email + password）。需 **Integration Token**，且该 Integration 需被加入 Queue 库与发件人库的 Collaborators。
- **Gmail 发信**：必须用 **Gmail API**（`googleapis` 的 `gmail.users.messages.send`），才能：
  - 在 Followup 时传 `threadId` 并设置 `In-Reply-To` / `References`，保证进同一线程；
  - 拿到返回的 `message.id` 和 `threadId` 回写 Notion。
- 当前 **nodemailer** 仅适合告警邮件；用 SMTP 发业务邮件且要严格 thread 语义需自己拼 MIME，且拿不到 Gmail 的 message id/threadId，故**不采用 nodemailer 做 Queue 发信**。

### 3.2 Notion 侧

- **Database ID**：从你提供的 URL  
  `https://www.notion.so/ad4abefd380545e2b3c60358f79e5a68?v=7dd8d7077f534fd09c8acbaa11903c78`  
  解析出 database_id：通常为 `ad4abefd380545e2b3c60358f79e5a68`（32 位 hex）；Notion API 有时要求带连字符的格式，需在实现时按 API 文档处理。
- **属性名**：API 中属性名通常与 Notion 界面显示一致（英文）。字段命名约定：
  - **Sender Account**（发信人）：对应原 Owner。
  - **Planned Send At**（发信时间）：对应原 Pre-Send Time；仅当当前时间 ≥ Planned Send At 才发送。
- 其余属性名以 data source 为准（如 `Email Status`、`Email`、`Email Subject`、`Email Body`、`Sequence Stage`、`Thread ID`、`Sent At Last`、`Message ID Last`、`Subject Last`、`Queued At`、`Priority Score`、四个 Flag 等）。

### 3.3 发件人库（Sender 凭据来源，已确认）

- **发件人库 URL**：  
  `https://www.notion.so/2dc9166fd9fd81ff97710003811d21af/ds/3129166fd9fd807099b7000b74db03ee?db=3129166fd9fd805b9c8bff5ed3d361cc`  
  其中 **database_id** 为 `3129166fd9fd805b9c8bff5ed3d361cc`（从 `db=` 参数取；若 API 需无连字符格式则去掉连字符）。
- **匹配方式**：用 Queue 条目的 **Sender Account** 与发件人库的 **Email** 字段匹配，找到对应行后取该行的 **Email**（发信邮箱）与 **password**（凭据）用于发信。
- 即：发件人库有 **Email**、**password** 等属性；程序根据 Queue 的 Sender Account 在发件人库中查 `Email = Sender Account` 的记录，用该记录的 Email + password 发信（若用 Gmail API 且为应用密码/OAuth，则 password 可能为 refresh_token 或 app password，实现时按实际字段含义处理）。

### 3.4 Gmail 侧

- 发信凭据来自上述**发件人库**（按 Sender Account 匹配 Email，取 password）；Gmail API 发信需 OAuth2 或应用密码，实现时按发件人库中实际存储的凭据类型做认证与 token 刷新。

---

## 4. 你给的规则在实现上的对应（字段名已按约定调整）

| 规则点 | 实现侧理解 |
|--------|------------|
| 筛选条件（Email Status=Pending + 四个 Flag 全 false + Email/Subject/Body 非空） | Notion query filter 写清；排序用 `Queued At` 升序或 `Priority Score` 降序。 |
| **Planned Send At**（发信时间） | **仅当当前时间 ≥ Planned Send At 才发送**；未到点的本批跳过，不标 Needs Review，下一批再试。 |
| **Sender Account**（发信人） | 从 Queue 读取；发信时用该值与**发件人库**的 **Email** 字段匹配，取该行的 Email + **password** 作为发信凭据。发件人库 URL 见 §3.3。 |
| 批量 10–30 条 | 一次 query 取 limit 10–30，可配置。 |
| Cold1：直接 `messages.send`，无 threadId | 不传 threadId；回写 message.id、threadId。 |
| **Followup 必须** | 需 **threadId + In-Reply-To/References**（References 需用到该 thread 的 **Message ID Last**）。若**缺 threadId**：**不发**，标 **Needs Review**，并**回滚状态**（如 Email Status 保持或改回 Pending）。 |
| Body 用 HTML（`<br/>` 保留） | MIME `Content-Type: text/html; charset="UTF-8"`，raw 用 base64url。 |
| 成功回写 | 按文档说明写：Done + Sent At Last + Thread ID + Message ID Last + Subject Last，Needs Review=false。**按文档说明一直都写**。 |
| 失败回写 | 按文档说明调整状态字段（Needs Review、Email Status 改回 Pending、可选 Stop Flag）；**错误原因必须写入 Queue 的 Stop Reason（text）字段**。 |
| 幂等、不重复发送 | 若 Email Status≠Pending、或 Sent At Last 已有、或 Message ID Last 已有，则**绝不发送**；取数后发信前再校验一次。 |
| 同步 Prompt 不处理 | 本仓库不实现同步到 Campaigns + Touchpoints；只把 Queue 状态与回写字段写对。 |

---

## 5. 已确认结论（按你的回复整理）

| 项 | 结论 |
|----|------|
| **配置** | 用**现有 schedule.json + Dashboard**，不新增独立配置文件；在 **行业与任务链** 里增加 Queue 发送配置（Queue 类型行业：Queue 数据库 URL、批量等）。 |
| **字段名** | **Owner → Sender Account**（发信人）；**Pre-Send Time → Planned Send At**（发信时间）。实现时严格按此命名，不写错。 |
| **Planned Send At** | **仅当当前时间 ≥ Planned Send At 才发送**；未到点本批跳过，下一批再试。 |
| **发信账号** | **多账号**；所有账号密码/凭据在**另一 Notion** 中存放，结构你后续提供；根据 Queue 条目的 Sender Account 从该 Notion 取对应凭据。 |
| **失败回写** | 按说明调整状态字段（Needs Review、Email Status 改回 Pending、可选 Stop Flag）；**错误原因必须写入 Queue 的 Stop Reason（text）字段**。 |
| **重试** | **单次最多重试 3 次**（同一批内对同一条）；**一定不要重复发送**（幂等：Status≠Pending / Sent At Last 已有 / Message ID Last 已有则不发）。 |
| **何时跑** | 用**现有 Dashboard 的时段配置**：只有在当前时间落入某时段、且该时段绑定的行业为 Queue 类型时，才执行该 Queue 的发送。 |
| **服务形态** | Queue Sender 是**常驻服务**，一直运行；**Dashboard 控制何时调用执行**（如启动/停止该服务；启动后按时段配置在允许窗口内每 5–10 分钟跑一批）。 |

---

## 6. 已补充结论（发件人库 / Followup / Stop Reason）

| 项 | 结论 |
|----|------|
| **发件人库** | 用 Queue 的 **Sender Account** 匹配发件人库的 **Email** 字段，取该行的 **Email** + **password** 作为发信凭据。**发件人库各自用**：每个 Queue 行业在配置里必填 **senderAccountsDatabaseUrl**（发件人库 URL），不共用顶层。 |
| **回写一致性** | **按照文档说明一直都写**：所有成功/失败/Followup 缺 threadId 等情况的回写，均按文档说明执行，不遗漏。 |
| **Followup 必须** | Followup 必须：**threadId + In-Reply-To/References**（References 需用到 **Message ID Last**）。缺 threadId 时：**不发**，标 **Needs Review**，**回滚状态**（如 Email Status 改回或保持 Pending）。 |
| **错误原因** | **错误原因需要写到 Queue 的 Stop Reason（text）字段**。失败时除状态字段外，必须把错误原因写入 Stop Reason。 |
| **日志** | **日志合并**：Queue Sender 与 Playwright 共用「最近运行日志」区域，前端用 tabs 或标签区分 Playwright 运行 / Queue Sender 运行。 |

---

## 7. Dashboard 页面对应改动设计

以下是对 Dashboard 改动的设计思路（仅设计，不实现），与现有「行业与任务链」+ 时段 + 启停保持一致风格，并支持 Queue Sender 的配置与运行控制。

### 7.1 数据结构（schedule.json / Schedule）

- **行业类型**：在 `ScheduleIndustry` 上增加 **`type`**：`'playwright' | 'queue'`（默认 `'playwright'`，兼容现有配置）。
- **Playwright 行业**（现有）：保留 `id`、`notionUrl`、N/M、`chainRunsPerSlot`、`tasks`；`type === 'playwright'` 或不填时按现逻辑使用。
- **Queue 行业**：`type === 'queue'` 时使用：
  - **`queueDatabaseUrl`**（必填）：Notion Queue 数据库 URL。
  - **`batchSize`**（可选）：每批取条数，默认如 20。
  - **`senderAccountsDatabaseUrl`**（必填）：**发件人库各自用**——每个 Queue 行业各自配置发件人库 URL，不从顶层共用。
  - 不要求 `notionUrl`、任务链；N/M、chainRunsPerSlot 对 Queue 无意义，保存时可写默认值或忽略。
- **时间区间**：不改。仍为 `timeSlots[].industryId` 引用行业 id；当某 slot 的 `industryId` 指向一个 **Queue 类型**行业时，在该时段内 Queue Sender 会执行该 Queue。

### 7.2 行业与任务链区域

- **列表行（行业主视图）**  
  - 保持：每行「id + URL 截断 + 编辑 + 删除」。  
  - **增加一列「类型」**：显示 `Playwright` 或 `Queue`；或把「URL 截断」改为「主 URL」——Playwright 显示 `notionUrl`，Queue 显示 `queueDatabaseUrl`，这样用户一眼能区分。  
  - 新建行业时默认 `type: 'playwright'`，与现有行为一致。

- **编辑弹窗（编辑行业）**  
  - **第一行或第二行**：增加 **「行业类型」** 单选：`Playwright` / `Queue`。  
  - **当选择 Playwright**：  
    - 保持现有表单项：Notion Portal URL、每 N 次新会话、每 M 次换模型、时段内跑几轮任务链、任务链（列表 + 添加任务）。  
    - 与当前 `openEditModal` / `saveEditModal` 逻辑一致。  
  - **当选择 Queue**：  
    - **隐藏**：N/M、任务链（或整块折叠/隐藏）。  
    - **显示**：  
      - **Queue 数据库 URL**（必填，input type=url）。  
      - **发件人库 URL**（必填，**发件人库各自用**，每个 Queue 行业单独配置）。  
      - **每批条数**（可选，number，默认 20，10–30 建议范围）。  
    - 保存时：`ind.type = 'queue'`，`ind.queueDatabaseUrl = ...`，`ind.senderAccountsDatabaseUrl = ...`，`ind.batchSize = ...`；`notionUrl`、`tasks` 可置空或保留上次值（校验时 Queue 类型不校验 notionUrl/tasks，但需校验 queueDatabaseUrl、senderAccountsDatabaseUrl 必填）。  
  - **切换类型**：若用户从 Playwright 改为 Queue，可清空 notionUrl/tasks 或保留；从 Queue 改为 Playwright 可清空 queueDatabaseUrl 或保留。实现上以当前选择类型为准写回对应字段即可。

- **「添加行业」**  
  - 与现在一致：push 一个新行业对象；新建时 `type: 'playwright'`，其余字段同现有默认（notionUrl 空、tasks 一条等）。若希望新建时可选类型，可在列表旁增加「添加 Playwright 行业」「添加 Queue 行业」两个按钮，或保留一个「添加行业」并在弹窗里先选类型再填。

### 7.3 时间区间

- **不改**。仍为：起止时间（时/分）+ 下拉选择行业 id + 删除。  
- 下拉选项仍来自 `schedule.industries` 的 `id`；若某选项对应行业 `type === 'queue'`，则该时段内只会触发 **Queue Sender** 跑该 Queue，不会启动 Playwright 任务链。  
- 前端无需在时间区间卡片上区分「当前选的是 Playwright 还是 Queue」；后端/Queue Sender 进程根据 `getIndustryForNow()` 得到当前行业，再根据 `industry.type === 'queue'` 决定是否跑 Queue。

### 7.4 Queue Sender 服务：状态与启停

- **位置**：在 **header 操作区** 或 **单独一张 card**（推荐与「时间区间」并列或放在其下）。  
- **内容**：  
  - **Queue Sender 状态**：类似现有「脚本 运行中/已停止」，例如文案「Queue Sender：运行中」或「Queue Sender：已停止」。  
  - **启动 Queue Sender** 按钮：点击后 POST `/api/queue-sender/start`（或类似路径），服务端 spawn 常驻进程 `npx tsx src/queue-sender.ts`（或封装在 `dashboard-queue-sender-runner` 中），该进程读 schedule、按时段与行业类型决定是否拉取并发送。  
  - **停止 Queue Sender** 按钮：POST `/api/queue-sender/stop`，kill 上述子进程。  
- **与现有「启动/停止」的关系**：  
  - **两套独立**：现有「启动/停止」只控制 **Playwright 任务链**（`index.ts`）；新增「启动/停止 Queue Sender」只控制 **Queue Sender** 进程。  
  - 两套可同时运行（例如同一时段只可能绑定一个行业，要么 Playwright 要么 Queue，不会冲突；若某时段是 Playwright 行业则 index 跑，若是 Queue 行业则 queue-sender 跑）。  
- **状态轮询**：与现有 status 类似，例如每 3 秒 GET `/api/queue-sender/status`，更新「Queue Sender：运行中/已停止」与按钮 disabled 状态。

### 7.5 日志（已确认：合并展示）

- **采用合并**：Queue Sender 与 Playwright **共用**「最近运行日志」区域（**日志合并**）。  
- 实现要点：  
  - 后端：API 返回的 runs 需**区分来源**（例如每条 run 带 `kind: 'playwright' | 'queue-sender'`，或 `{ runs: [...], queueSenderRuns: [...] }` 前端合并展示）。  
  - 前端：在同一块「最近运行日志」里用 **tabs**（如「Playwright 运行」「Queue Sender 运行」）或列表内**标签**区分每条是哪种运行，点击后展示对应 stdout/stderr。  
- 后端需同时维护 Playwright 子进程与 Queue Sender 子进程的 runLogs，统一或分别存储均可，只要接口能返回两类 runs 供前端合并展示。

### 7.6 保存与加载

- **保存配置**：现有「保存配置」按钮会 `collectSchedule()` 后 POST `/api/schedule`。  
  - `collectSchedule()` 需扩展：从 DOM 收集行业时，若为 Queue 类型则收集 `type`、`queueDatabaseUrl`、**`senderAccountsDatabaseUrl`**（发件人库各自用）、`batchSize`；若为 Playwright 则收集现有字段。  
  - `mergeSchedule` / `validateSchedule` 需支持 `industry.type === 'queue'` 时校验 `queueDatabaseUrl`、`senderAccountsDatabaseUrl` 必填，不校验 notionUrl/tasks 非空。  
- **加载配置**：GET `/api/schedule` 返回的 schedule 已含 `industries[].type`、`queueDatabaseUrl`、`batchSize` 等；`openEditModal` 根据 `ind.type` 显示/隐藏表单项并回填 Queue 字段。

### 7.7 小结与可选点

- **必做**：行业类型（Playwright/Queue）、编辑弹窗按类型切换表单项、Queue 行业必填 Queue 数据库 URL **与发件人库 URL（各自用）**、时间区间不变、Queue Sender 独立启停与状态、schedule 读写支持 Queue 字段、**日志合并**（Playwright 与 Queue Sender 共用一块日志区域并用 tabs/标签区分）。  
- **可选**：新建行业时是否直接提供「添加 Queue 行业」入口。  
- **不做的**：不在时间区间卡片上为「当前选的是 Queue」做特殊样式（可选做标签）；不在同一套「启动/停止」里混用 Playwright 与 Queue（两套进程、两套按钮更清晰）。

---

## 8. 是否还有其他问题

- 发件人库的 **database_id** 与匹配字段（Email、password）已明确；若发件人库中还有其它必读属性（如 refresh_token 与 password 二选一等），实现时可按实际 schema 再补。
- Queue 库的 **Stop Reason** 为 **text** 类型，已确认写入错误原因。
- **发件人库**：已定为**各自用**（每个 Queue 行业必填 `senderAccountsDatabaseUrl`）；**日志**：已定为**合并**（Playwright 与 Queue Sender 共用「最近运行日志」，用 tabs 或标签区分）。  
- 除此以外无其他未决问题；可以据此写实现计划（PLAN）并开工。
