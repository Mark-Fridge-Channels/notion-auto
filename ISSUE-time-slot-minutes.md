# 优化：时间区间支持选择分钟

## TL;DR

时间区间目前只能选整点（如 9–12），希望支持到分钟（如 9:30–12:45），便于更精细地划分时段。

## 当前状态 vs 期望

| 项目 | 当前 | 期望 |
|------|------|------|
| 数据模型 | `TimeSlot` 仅有 `startHour`、`endHour`（0–23 / 0–24） | 增加 `startMinute`/`endMinute`（0–59）；小时仅 0–23，止 23:59 表示「到当日结束」 |
| 区间判断 | `getIndustryForNow()` 仅用当前 `hour` 与 slot 比较 | 用「当前时刻（时+分）」与区间起止（时+分）比较，左闭右开 |
| Dashboard | 时间区间只有「起」「止」两个数字框，单位是小时 | 每个区间可输入起止的时+分（例如 9:30、12:45） |

## 涉及文件

- **`src/schedule.ts`** — `TimeSlot` 类型、校验、`getIndustryForNow()` / `waitUntilInSlot()` 的区间逻辑；默认/merge 需支持新区间字段
- **`src/server.ts`** — Dashboard 时间区间 UI：渲染、回填、收集（`syncTimeSlotsFromDOM`、`renderTimeSlots`、`collectSchedule` 中的 timeSlots 部分）

## 实现要点

- **向后兼容**：若配置里没有分钟字段，视为 0 分（行为与现有一致）。
- **跨天**：保持现有语义（end < start 表示跨天），比较时用「当日分钟数」或「总分钟数 mod 24*60」一致即可。
- **校验**：start/end 的 hour 均为 0–23、minute 均为 0–59，且区间逻辑左闭右开。

## 已确认的实现约定（探索阶段确认）

1. **小时仅 0–23，不出现 24**
   - 配置与 UI 中小时一律为 0–23。
   - 「到当日结束」：用户选止 **23 时 59 分**；存储为 `endHour=23, endMinute=59`；比较时将该 end 视为**独占上界 24:00**（即 1440 分钟），从而 23:59 仍在区间内。除此以外，end 的 (hour, minute) 直接换算为分钟数作为独占上界。

2. **Dashboard 输入方式：方案 A**
   - 每个时间区间一行：**起（时、分）** + **止（时、分）**，共四个数字框（时 0–23，分 0–59）。

3. **精度**
   - 只到分钟，不支持秒。

4. **文档与示例**
   - 在 README 和/或 `schedule.example.json` 中增加带 `startMinute` / `endMinute` 的示例与说明。

## 类型 / 优先级 / 工作量

- **类型**：improvement（功能增强）
- **优先级**：normal
- **工作量**：medium（改类型 + 校验 + 解析逻辑 + Dashboard 表单与收集）
