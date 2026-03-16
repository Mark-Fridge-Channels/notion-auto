# Notion 任务队列 + 可配置执行与任务链集成

**类型:** Feature  
**优先级:** Normal  
**工作量:** Medium ~ Large  

---

## TL;DR

在现有「时间区间 + 行业任务链」基础上，增加 **Notion 数据库作为任务队列** 的能力：从 Notion DB 读取待执行任务（Action Name、File URL、Status 等），用 Playwright 打开对应 Notion 页面并执行，执行完后按配置更新状态或删除记录；所有 DB 地址与列名均通过 **配置页** 配置、不写死。同时与现有 **任务链** 集成：当使用 Notion 队列时，**时间一到只跑完当前任务即停**，不把队列里剩余任务全部跑完（与手动编辑的「跑满 N 轮任务链再停」区分开）。

---

## 当前状态 vs 期望

| 维度 | 当前 | 期望 |
|------|------|------|
| 任务来源 | 仅 `schedule.json` 里行业下的 `tasks[]`（手动编辑的任务链） | 支持额外来源：**Notion 数据库** 作为 task queue |
| 任务字段 | `content` + `runCount` | 队列任务：**Action Name**、**File URL**（Notion 页面地址）、**Status**（执行状态）等，列名可配置 |
| 执行方式 | Playwright 打开行业 `notionUrl`，按任务链 typeAndSend | Playwright 按队列行的 **File URL** 打开页面，按 **Action Name** 执行（例如输入+发送等），执行完更新 **Status** 或删除该行 |
| 配置 | 时间区间、行业、任务链在 Dashboard 编辑 `schedule.json` | 新增 **队列配置**：Notion 数据库 URL、列映射（Action Name / File URL / Status）、待执行状态值、完成后状态值、完成后是「更新状态」还是「删除记录」 |
| 停止语义 | 手动任务链：可配置 `chainRunsPerSlot`，跑满 N 轮后等离开时段 | **Notion 队列模式**：时间到后 **只跑完当前正在执行的那条** 就停，不继续拉取并执行队列中剩余任务 |

---

## 需求要点（已从描述归纳）

1. **Notion 数据库 = 任务队列**  
   - 至少包含：Action Name、File URL（Notion 文件/页面地址）、Status（任务执行状态）。  
   - 列名不写死，通过配置绑定到「行为名 / 文件 URL / 状态」等语义。

2. **Playwright 自动化执行**  
   - 根据队列中的 **File URL** 打开对应 Notion 页面；  
   - 根据 **Action Name** 执行对应动作（例如：在 Notion AI 里输入并发送，或其它可扩展动作）；  
   - 执行完成后，根据配置：**更新 Status** 为某值，或 **删除该条记录**。

3. **配置页（不写死）**  
   - 在 Dashboard 或等价配置入口中持久化：  
     - Notion 数据库地址（或 view 地址）；  
     - 列映射：哪一列是 Action Name、哪一列是 File URL、哪一列是 Status；  
   - 以及：  
     - **待执行状态**：Status 等于哪些值时会进入执行队列；  
     - **完成后行为**：改成某状态值 / 或删除记录；  
   - 保存后可根据该配置自动运行（与现有「启动」流程一致）。

4. **与现有「任务链」的集成与区别**  
   - 现有任务链：`schedule.json` 里行业下 `tasks[]`，按顺序执行，可配 `chainRunsPerSlot`（跑满 N 轮后等离开时段）。  
   - 新增 Notion 队列作为 **另一种任务来源**：  
     - 若当前行业/时段使用 **Notion 队列**：  
       - **时间一到（离开当前时间区间）**：只把 **当前正在执行的那条任务** 跑完就停止，**不再**从队列取新任务执行；  
     - 与「手动编辑任务链 + 跑满 N 轮才停」形成明确区别：Notion 队列是「到点即停，仅保证当前任务完成」。

---

## 相关文件（需改动或新增）

- **配置与类型**  
  - `src/schedule.ts`：扩展 `Schedule` / 行业，或新增「Notion 队列」配置结构（DB URL、列映射、状态值、完成后行为）。  
  - 若队列配置单独存：可考虑 `queue.json` 或并入 `schedule.json` 的某块（如 `notionQueue` / 按行业绑定 queue 配置）。
- **Dashboard**  
  - `src/server.ts`：新增「Notion 任务队列」配置 UI（数据库地址、列名映射、待执行/完成后状态、更新 vs 删除），保存到上述配置。
- **执行逻辑**  
  - `src/index.ts`（或抽成 `src/queue-runner.ts` 等）：  
    - 在「按时间区间选行业」后，若该行业使用 Notion 队列，则：  
      - 从 Notion 拉取 Status ∈ 待执行状态 的行；  
      - 取一条 → 用 Playwright 打开 File URL → 按 Action Name 执行 → 更新状态或删除；  
      - 每次取任务前/执行完当前任务后检查时间；若已离开当前时段，则本任务完成后不再取新任务并退出循环。
- **Notion 数据读写**  
  - 采用 **Notion API**（`@notionhq/client`）：Integration Token（如 `NOTION_API_KEY`） + 数据库与列名配置；通过 API 查询 DB schema 得到列名 → 列 ID 映射。  
  - 写回：更新 Status 或删除行，均通过 API。

---

## 风险与注意事项

- **鉴权**：若用 Notion API，需在环境或配置中安全管理 `NOTION_API_KEY`（Integration Token），且 DB 需邀请该 Integration。  
- **列类型**：Notion API 里列为 type + 不同结构（title/url/select 等）；配置页若按「列名」映射，需处理「列名 ↔ 列 ID」的解析（API 查询 DB schema 后匹配）。  
- **并发**：仅单实例运行，无需「执行中」状态防重。

---

## 建议实现顺序（不强制）

1. 定义 Notion 队列配置结构（DB URL、列映射、状态值、完成后行为）并持久化（含 Dashboard 表单）。  
2. 实现「从 Notion 读待执行行」与「执行后更新/删除」（先选 API 或 Playwright 一种）。  
3. 在主循环中按行业/时段选择「任务链」或「Notion 队列」；若为队列，实现「取一条 → 执行 → 检查时间，到点则当前任务完成后退出」。  
4. 将 Action Name 与现有 typeAndSend 等动作解耦，做成可配置映射，便于后续扩展更多动作类型。

---

## 已约定（探索阶段澄清）

| 项 | 约定 |
|----|------|
| **读写方式** | Notion API（`@notionhq/client`），需 Integration Token，在 `.env` / env.example 中配置。 |
| **Action Name** | Notion 中为 **Text** 类型列。执行时在 Playwright 输入框输入 **`"@" + Action Name`**（程序拼接），即与现有 typeAndSend 一致。 |
| **File URL** | Notion 中为 URL 列，表示 Playwright 要打开的 Notion 页面；打开后在该页执行「输入 @ + Action Name 并发送」。 |
| **任务来源** | **二选一**：每个行业/时段要么用 schedule 任务链，要么用 Notion 队列，在行业配置中选择（如 `taskSource: "schedule" \| "notionQueue"`）。 |
| **队列配置** | **全局一份**：所有使用 Notion 队列的行业共用同一套配置（DB 地址、列名映射、状态值、完成后行为）。 |
| **到点停止** | 离开当前时间区间时：**跑完当前正在执行的那条任务** 再停，不再取新任务。 |
| **实例** | 仅单实例，无需「执行中」状态防重。 |
| **列配置** | 使用 **用户在 Notion 页面上看到的列名**；Status 为 **Select**，取值：**Queued**（待执行）/ **Done** / **Failed**。待执行状态 = Queued。 |

### 失败行为（已同意）

- **执行失败时**：Playwright 执行某条任务失败（超时、元素未找到等）时，将该行 Status 更新为 **Failed**，**不删除**该行。成功时按配置：更新为 Done 或删除记录。
---

*Issue 由 /create-issue 整理；探索阶段澄清已写入「已约定」。*
