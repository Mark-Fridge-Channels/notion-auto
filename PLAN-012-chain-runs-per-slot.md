# Feature Implementation Plan: 时段内任务链执行次数（chainRunsPerSlot）

**Overall Progress:** `100%`

## TLDR

在行业配置中增加 `chainRunsPerSlot`：0 = 时段内一直重复跑任务链（现行为），≥1 = 时段内跑满 N 轮完整任务链后等待直到离开当前时段。一轮仅在所有 task 按顺序全部跑完后计数；不持久化；等待时每 1 分钟检查一次。

## Critical Decisions

- **计数时机**：只在「内层任务链 for 循环完整结束」后做 `chainRunsInSlot++` 及是否等待，确保 task1→task2→task3 都跑完才算一轮。
- **不持久化**：`chainRunsInSlot` 仅内存变量；恢复重启后从 0 开始，中途崩溃的那轮不计数。
- **等待间隔**：跑满 N 轮后「等待离开当前时段」时，每次 `sleep(60_000)` 再调 `getIndustryForNow`，直到 ≠ currentIndustry 或 null。
- **重置「本时段已跑轮数」**：切换行业时重置；从「等待离开时段」退出后再次落入同一行业时也重置（用标志位区分「刚离开过该时段」）。

---

## Tasks

- [x] 🟩 **Step 1: schedule 类型与校验（schedule.ts）**
  - [x] 🟩 在 `ScheduleIndustry` 接口增加 `chainRunsPerSlot: number`（0 = 本时段内一直跑）
  - [x] 🟩 `getDefaultSchedule()` 的默认行业增加 `chainRunsPerSlot: 0`
  - [x] 🟩 `normalizeIndustry` 中读取并回写 `chainRunsPerSlot`，缺省为 0（兼容旧 JSON）
  - [x] 🟩 `validateIndustry` 中校验 `chainRunsPerSlot` 为非负整数

- [x] 🟩 **Step 2: 主循环逻辑（index.ts）**
  - [x] 🟩 在 runCount/sessionRuns 附近增加 `chainRunsInSlot = 0` 与标志位（如 `leftCurrentSlot = false`）
  - [x] 🟩 每轮开头：若 `industryNow.id !== currentIndustry.id` 则切换行业并置 `chainRunsInSlot = 0`、`leftCurrentSlot = false`；若 `industryNow.id === currentIndustry.id && leftCurrentSlot` 则置 `chainRunsInSlot = 0`、`leftCurrentSlot = false`（再次落入同一行业视为新区段）
  - [x] 🟩 内层「按 tasks 顺序执行」的 for 循环**完整结束后**：`chainRunsInSlot++`；若 `(currentIndustry.chainRunsPerSlot ?? 0) > 0 && chainRunsInSlot >= currentIndustry.chainRunsPerSlot` 则进入「等待离开当前时段」循环（`await sleep(60_000)` + `getIndustryForNow(schedule)` 直到为 null 或不等于 `currentIndustry`），退出等待后设 `leftCurrentSlot = true`，再 `continue` 到外层
  - [x] 🟩 保证 `chainRunsPerSlot === 0` 或未配置时行为与现有一致（不进入等待，直接下一轮任务链）

- [x] 🟩 **Step 3: Dashboard 行业弹窗（server.ts）**
  - [x] 🟩 行业编辑弹窗中增加一行：「时段内跑几轮任务链（0=一直跑）」+ number 输入，id 如 `modalChainRunsPerSlot`，min=0
  - [x] 🟩 `openEditModal` 回填 `ind.chainRunsPerSlot ?? 0`
  - [x] 🟩 `saveEditModal` 从该 input 读取并写入 `ind.chainRunsPerSlot`（非负整数，非法时用 0）
  - [x] 🟩 新建行业（「添加行业」与时间区间选「+ 新建行业」）时，新行业对象增加 `chainRunsPerSlot: 0`

- [x] 🟩 **Step 4: 示例配置（schedule.example.json）**
  - [x] 🟩 示例行业中增加 `"chainRunsPerSlot": 0` 字段（或注释说明）
