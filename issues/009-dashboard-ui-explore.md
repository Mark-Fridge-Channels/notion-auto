# Issue 009 补充：Dashboard UI 维护 autoClickDuringOutputWait

## 1. 现有 Dashboard 与 schedule 的衔接

| 位置 | 作用 |
|------|------|
| **GET /api/schedule** | 返回完整 schedule 对象（含 `autoClickDuringOutputWait`，若后端 merge 已支持则已有该字段） |
| **POST /api/schedule** | body 为 partial schedule，服务端 `mergeSchedule(body)` 后 `validateSchedule` 再写盘 |
| **全局设置卡片** | 第一张 card，含「间隔秒数」「登录等待」「最大重试」；数据通过 `fillGlobal(schedule)` 填表，通过 `collectSchedule()` 从 DOM 收集 |
| **fillGlobal(schedule)** | 用 `schedule.intervalMinMs/Max、loginWaitMs、maxRetries` 填对应 input，加载时调用 |
| **collectSchedule()** | 从 `intervalSecondsMin/Max、loginWaitSeconds、maxRetries` 及 `timeSlotsContainer`、`currentSchedule.industries` 拼出对象，返回给保存/启动 |

结论：后端已支持 `autoClickDuringOutputWait` 的 merge 与校验；只需在 Dashboard 的**全局设置**中增加该字段的展示与编辑，并在 `fillGlobal` / `collectSchedule` 中读写即可。

## 2. UI 形态选择

- **方案 A（每行一个输入 + 删除 + 添加）**  
  - 与「时间区间」「任务链」一致：一个容器内多行，每行一个 input（按钮名称）+「删除」按钮，底部「添加一项」。  
  - 优点：顺序清晰、可逐项删改，符合「按列表顺序依次检测」的说明。  
  - 缺点：多几行 DOM 与脚本。

- **方案 B（单 textarea，一行一个）**  
  - 一个 textarea，占位符说明「每行一个按钮名称」。  
  - 优点：实现简单。  
  - 缺点：顺序依赖换行，易误删/误改，且与现有「列表行」风格不统一。

**建议**：采用 **方案 A**，与时间区间、任务链的交互一致，且便于展示「按列表顺序」的提示。

## 3. 具体接入点（server.ts）

- **HTML（全局设置 card 内）**  
  - 在「最大重试次数」那一行之后新增一行（或一块）：  
    - 文案：**等待输出期间自动点击的按钮**；  
    - 说明（hint）：**将按列表顺序依次检测并点击出现的按钮。填写按钮上显示的文字，精确匹配。**  
  - 容器：`<div id="autoClickButtonsContainer" class="..."></div>`（可复用现有 row/列表样式）。  
  - 按钮：`<button type="button" id="btnAddAutoClickButton" class="primary">添加一项</button>`。

- **每行结构**  
  - 一行：`<input type="text" data-key="name" placeholder="例如 Delete pages">` + `<button type="button" data-remove-auto-click class="danger">删除</button>`，外层可用 `class="auto-click-row"` 或与现有 row 一致便于样式统一。

- **fillGlobal(schedule)**  
  - 读取 `schedule.autoClickDuringOutputWait`（若缺省则为 `[]`）。  
  - 清空 `autoClickButtonsContainer`，按数组顺序为每项插入一行，input 的 value 为该字符串。  
  - 若数组为空，可渲染 0 行（或 1 行空 input，视产品偏好；建议 0 行，通过「添加一项」增加）。

- **collectSchedule()**  
  - 遍历 `autoClickButtonsContainer` 内所有行（如 `.auto-click-row` 或带 `data-key="name"` 的 input）。  
  - 取每个 input 的 value.trim()，过滤掉空字符串，得到字符串数组。  
  - 在返回对象中增加 `autoClickDuringOutputWait: 该数组`（可为 `[]`，与后端 merge 行为一致）。

- **事件**  
  - 「添加一项」：在容器末尾插入一行，input 为空，删除按钮点击时移除该行（不需立刻调 `syncScheduleUI`，因为当前没有其它依赖该列表的实时同步；保存时由 collectSchedule 收集即可）。  
  - 若希望「保存前」实时反映到内存里的 currentSchedule，可在添加/删除时更新 `currentSchedule.autoClickDuringOutputWait` 并可选地调用 `syncScheduleUI()`；否则仅保存/启动时通过 collectSchedule 收集亦可。

## 4. 约束与边界

- **校验**：后端已对 `autoClickDuringOutputWait` 做数组与非空字符串校验；前端可选在 collectSchedule 时过滤空串，与 merge 行为一致。  
- **顺序**：列表顺序即检测/点击顺序，UI 上通过「添加」「删除」和行顺序体现，无需额外说明。  
- **兼容**：旧 schedule 无该字段时，fillGlobal 用 `[]` 即可，collectSchedule 未收集时后端 merge 为 `undefined`，行为为「不自动点击」。

## 5. 小结

- 在**全局设置**卡片中增加「等待输出期间自动点击的按钮」区块：列表行（每行一个名称 + 删除）+「添加一项」，并加说明文案。  
- **fillGlobal** 根据 `schedule.autoClickDuringOutputWait` 渲染行；**collectSchedule** 从该区块收集字符串数组并写入返回对象的 `autoClickDuringOutputWait`。  
- 无需改后端 API 或 merge/validate 逻辑，仅扩展 Dashboard 单页的 HTML 与脚本。
