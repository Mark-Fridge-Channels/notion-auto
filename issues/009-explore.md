# Issue 009 探索：等待输出期间可配置「自动点击按钮」

## 1. 需求理解

- **原 issue**：发送对话后、在等待 AI 输出结束（等发送按钮再次出现）这段时间内，若页面弹出「Delete pages」按钮则自动点击。
- **你的补充**：改为**用户可配置**「遇到什么按钮就自动点击」，而不是写死 Delete pages。因此需要明确：**按钮元素定位如何设计，才能既让用户能配置，又稳定可维护**。

## 2. 与现有代码的衔接

| 位置 | 现状 | 影响 |
|------|------|------|
| **配置来源** | 主流程用 `Schedule`（`schedule.json`），由 `loadSchedule()` 加载；Dashboard 编辑的也是同一份 schedule。 | 新配置应放在 **Schedule 顶层**（与 `intervalMinMs`、`loginWaitMs` 同级），这样 CLI（`--config`）与 Dashboard 共用。 |
| **等待逻辑** | `typeAndSend()` 内：点击发送 → `page.locator(SEND_BUTTON).first().waitFor({ state: "visible", timeout: WAIT_SUBMIT_READY_MS })`。 | 需把这段「单次 waitFor」改成「在总超时内轮询：若出现配置的按钮则点击，直到发送按钮可见或超时」。`typeAndSend` 目前只收 `(page, text)`，若配置在 schedule 里，需要把 **schedule 或其中的「自动点击按钮列表」** 传进来（或从上层 tryTypeAndSend 传入）。 |
| **selectors** | 现有选择器都是代码内常量（`SEND_BUTTON`、`NEW_CHAT_BUTTON` 等）。 | 用户配置的按钮**不再**放在 selectors.ts 里写死，而是**由配置驱动**；selectors 里可只保留「如何根据一条配置项解析成 Locator」的辅助逻辑（若有）。 |

**结论**：配置项建议为 Schedule 顶层字段，例如 `autoClickDuringOutputWait?: ButtonSpec[]`；执行时在 `typeAndSend`（或抽出的「带自动点击的等待」函数）中根据该列表轮询并点击。

## 3. 按钮元素定位如何实现（核心）

用户需要能「描述一个按钮」，程序据此在 Playwright 里定位并点击。可选方案如下。

### 方案 A：仅支持「CSS 选择器」字符串

- **配置示例**：`["div[role=\"button\"]:has-text('Delete pages')", "..."]` 或 `["[data-testid='delete-pages']"]`
- **实现**：`page.locator(selector).first()`，可见则 click。
- **优点**：灵活，一种方式覆盖所有情况。
- **缺点**：对非技术用户不友好；选择器易写错、易随 Notion 改版失效；若用户从 DevTools 复制复杂选择器可能含引号/转义问题。

### 方案 B：仅支持「role + 可访问名称」（Playwright 推荐）

- **配置示例**：`[{ "role": "button", "name": "Delete pages" }]`（name 即可访问名，通常为文本或 aria-label）。
- **实现**：`page.getByRole('button', { name: 'Delete pages' }).first()`。
- **优点**：语义清晰、贴近无障碍、对 Notion 的 DOM 结构变化相对不敏感；用户只需填「角色+名称」。
- **缺点**：若 Notion 某按钮没有正确 role/name，就配不了；需要约定 name 的匹配方式（精确 / 包含 / 正则）。

### 方案 C：结构化多类型（selector / role+name / aria-label）

- **配置示例**：
  - `{ "type": "selector", "value": "div[role='button']" }`
  - `{ "type": "roleName", "role": "button", "name": "Delete pages" }`
  - `{ "type": "ariaLabel", "value": "Delete pages" }`
- **实现**：根据 `type` 分别用 `page.locator(value)`、`page.getByRole(role, { name })`、`page.getByLabel(value)`（或 `[aria-label="..."]`）。
- **优点**：高级用户可用 selector，普通用户用 role+name 或 aria-label；可扩展更多 type。
- **缺点**：配置结构和校验更复杂；需要文档说明各 type 的用法。

### 方案 D：统一用「角色 + 文本」，文本支持多种匹配

- **配置示例**：`[{ "role": "button", "text": "Delete pages" }]`，可选 `"textMatch": "exact" | "contains" | "regex"`。
- **实现**：用 `getByRole('button', { name: ... })`，Playwright 的 name 本身支持子串；regex 需自己用 `locator('div').filter({ hasText: /.../ })` 等组合。
- **优点**：对「Delete pages」这类已知文案友好，且多数情况 role+text 足够。
- **缺点**：和方案 B 本质类似，主要差别在是否暴露「匹配方式」给用户。

---

## 4. 已确认方案（产品拍板）

- **定位方式**：**role 固定为 button**，用户**只填按钮 name**（页面上看到的文字），不暴露 role 配置。
- **name 匹配**：**精确匹配**。实现时用 `page.getByRole('button', { name: /^...$/ })`，使可访问名与配置的 name 完全一致。
- **多按钮**：一般不会出现多个按钮；若配置了多条，按**配置顺序**依次检索并定位，找到可见的就点击，然后继续等待/下一轮轮询。同一轮内按列表顺序处理。
- **页面上提示**：在配置该功能的**页面（如 Dashboard 的 schedule 编辑处）**上，需要明确提示用户：「将按列表顺序依次检测并点击出现的按钮」，避免用户误以为会同时点多个或随机点。

## 5. 配置结构（定稿）

Schedule 顶层增加：

```ts
// Schedule 新增：仅按钮名称，role 固定为 "button"
autoClickDuringOutputWait?: string[];
```

- 默认：`undefined` 或 `[]` 表示不自动点击任何按钮，行为与现在一致。
- 校验：数组每项为非空字符串；非法则报错或忽略并打日志。
- **实现定位**：对每项 `name` 用 `page.getByRole('button', { name: new RegExp('^' + escapeRegex(name) + '$') }).first()` 得到 Locator；轮询时 `locator.isVisible()` 为 true 则 `locator.click()`。多按钮按数组顺序依次检查。

## 6. 用户如何填写（仅填按钮 name）

- **只需填「按钮 name」**：即页面上看到的按钮文字，与界面显示**完全一致**（精确匹配）。例如 `"Delete pages"`。
- **role**：不暴露给用户，程序内固定为 **`"button"`**（覆盖绝大多数可点击按钮场景）。

**Delete pages 示例**：在 schedule 里写：

```json
"autoClickDuringOutputWait": ["Delete pages"]
```

若以后要自动点其它按钮：只把页面上该按钮的**文字**按原样填入数组即可。

## 7. 其它约束与边界

- **时机**：仅在与当前「等待发送按钮再次出现」的同一时间窗口内检测并点击；不改变总超时 `WAIT_SUBMIT_READY_MS`，不重置计时。
- **轮询间隔**：建议 1–2 秒检查一次配置的按钮，避免过于频繁的 DOM 查询。
- **多次出现**：同一轮等待内，若某配置按钮多次出现（如 Notion 多次弹同一按钮），应支持「出现就点、点完继续等」直到发送按钮可见或超时。
- **点击失败**：某次 click 若抛错（如元素被移走），建议 catch 后只打日志并继续等待，不因此终止整轮。
- **Dashboard**：若以后要在 Web 上编辑 schedule，需在 UI 和 `mergeSchedule` 中支持 `autoClickDuringOutputWait` 的读写，并**在页面上提示**：「将按列表顺序依次检测并点击出现的按钮」。可先只做 JSON 配置，UI 后补时记得加该提示。

---

**探索结论**：方案已定，无遗留问题，可进入实现阶段。
