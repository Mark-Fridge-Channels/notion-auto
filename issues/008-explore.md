# 008 chainRunsPerSlot — 探索结论与待澄清

## 需求理解（是否清晰）

- **需求本身**：在行业上增加「本时段内跑几轮完整任务链」的控制（0=无限，1=跑 1 轮后等下一时段，2=跑 2 轮后等，…）。计数粒度是「完整一轮任务链」；跑满 N 轮后在本时段内不再启动新轮，等待直到离开当前时段（`getIndustryForNow()` 变为另一行业或 null）。
- **结论**：需求清晰，与现有「任务链跑完立刻从头再跑」的差异明确，0 表示保持现行为。

---

## 与现有实现的对接点

| 位置 | 现状 | 对接方式 |
|------|------|----------|
| **index.ts 主循环** | 外层 `for(;;)`，每轮开头 `getIndustryForNow`，若换行业则切 URL/New chat 并重置 runCount/sessionRuns/N/M；内层按 `currentIndustry.tasks` 顺序执行，每任务按 `runCount` 次 typeAndSend；任务链结束后无 break，直接下一轮。 | 增加「本时段已跑链轮数」`chainRunsInSlot`；跑完一整轮任务链后 +1；若 `chainRunsPerSlot > 0` 且 `chainRunsInSlot >= chainRunsPerSlot` 则进入「等待离开当前时段」循环（如 sleep 1min + `getIndustryForNow` 直到 ≠ currentIndustry 或 null），再 continue 到外层；切换行业时重置 `chainRunsInSlot`；再次落入同一行业（如另一时段或次日同一时段）时也重置。 |
| **schedule.ts** | `ScheduleIndustry` 有 id、notionUrl、N/M 区间、tasks；`normalizeIndustry` 补默认值；`validateIndustry` 校验；`getIndustryForNow` 按 timeSlots 顺序取第一个包含当前小时的 slot 对应行业。 | 在 `ScheduleIndustry` 增加 `chainRunsPerSlot: number`；`getDefaultSchedule`、`normalizeIndustry` 默认 0；`validateIndustry` 校验非负整数。 |
| **server.ts 行业弹窗** | `openEditModal` 回填 id、notionUrl、N/M、tasks；`saveEditModal` 从 DOM 收集并写回；新建行业对象含 N/M、tasks，无 chainRunsPerSlot。 | 弹窗增加「时段内跑几轮（0=一直跑）」输入；openEditModal 回填、saveEditModal 收集并写入；新建行业默认 `chainRunsPerSlot: 0`。 |
| **progress.json** | 仅 totalDone、conversationRuns、completed；恢复重启不恢复任务进度，从任务 1 开始。 | 不持久化「本时段已跑轮数」；重启后该时段计数从 0 开始。 |

---

## 边界与约束

1. **同一行业出现在多个 time slot**  
   例如 0–3 和 10–15 都是 industryA。在 0–3 跑满 1 轮后等待，到 3 点离开；10 点再次落入 industryA 时视为新区段，重置「本时段已跑轮数」。与 issue 中「再次落入同一行业时也应视为新区段」一致。

2. **跨天时段（如 22–6）**  
   `getIndustryForNow` 已支持（startHour > endHour 表示跨天）。跑满 N 轮后等待直到不在该行业或 null（例如到 6 点后），逻辑无需特殊处理。

3. **当前时间未落入任何区间**  
   主循环已有：`industryNow == null` 时 sleep 60s 并 continue。「等待离开当前时段」时若变为 null，下一轮会进入这段逻辑，一致。

4. **重叠区间**  
   若两个 slot 时间重叠，`getIndustryForNow` 按 timeSlots 顺序取第一个匹配的行业。「当前时段」由该语义唯一确定，无需改 schedule 解析。

5. **恢复重启**  
   进度不包含「本时段已跑轮数」；重启后从当前时间对应行业、任务 1 开始，`chainRunsInSlot` 从 0 开始。因此若在跑第 1 轮中途崩溃，重启后本时段会再跑最多 N 轮（可能比「未崩溃时」多跑一点），不会少跑。

---

## 已明确、无需再澄清

- 计数粒度：完整一轮任务链（所有 task 按顺序各执行完自己的 runCount）。
- 0 = 无限循环（现行为）；≥1 = 跑满 N 轮后在本时段内不再跑，等待离开当前时段。
- 重置时机：切换行业时重置；离开当前时段后再次落入同一行业时也重置。
- 等待方式：轮询 `getIndustryForNow`（可配合 sleep）直到 ≠ currentIndustry 或 null，再继续主循环。

---

## 已确认（来自你的回复）

1. **不持久化，但必须「跑完才算一轮」**  
   - 不持久化「本时段已跑轮数」；重启后从 0 开始。  
   - **实现约束**：只有在一整轮任务链**全部跑完**后才给「本时段已跑轮数」+1。即：task1、task2、task3 必须都按顺序执行完（各自 runCount 次），才算 1 轮；若中途崩溃/退出，这一轮**不计数**，重启后从任务 1 重新跑，跑完再计 1 轮。  
   - 代码位置：在 `index.ts` 里只在**内层任务链 for 循环完整结束后**做 `chainRunsInSlot++` 及后续「是否等待离开时段」判断，不在单个 task 或单次 typeAndSend 后增加。

2. **等待离开时段时的轮询间隔**  
   - 采用 **1 分钟**：在「等待离开当前时段」的循环里，每次检查前 `sleep(60_000)`，再调用 `getIndustryForNow`，直到结果 ≠ currentIndustry 或 null。

---

## 小结

- 需求与澄清均已明确：不持久化；一轮仅在内层任务链完整跑完后计数；等待间隔 1 分钟。可据此实现。
