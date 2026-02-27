# 时间区间重叠：Playwright-A 未跑完时 Queue-B 已启动

**类型**: improvement  
**优先级**: normal  
**预估工时**: small  

---

## TL;DR

时间区间配置为 15:00–15:15 执行 Playwright-A、15:16–15:30 执行 Queue-B 时，若 A 的任务链在 15:15 之后仍未执行完，Queue Sender 会按当前时间在 15:16 开始执行 B，导致两段逻辑在时间上重叠。需要一种简单方式避免「B 在 A 尚未结束时就开始」。

---

## 当前状态 vs 期望结果

| 当前 | 期望 |
|------|------|
| Playwright 仅在**每轮任务链开始前**检查时间并切换行业；任务链执行过程中不会中途切 slot | 行为可保留 |
| Queue Sender 每轮循环都调 `getIndustryForNow(schedule)`，到 15:16 即认为进入 B 的 slot，立即开始跑 queue-B | B 不应在 A 尚未结束时就开始（或提供可配置的缓冲） |
| 两进程独立，无协调；到点即按「当前时间」各自切换 | 在实现成本可控前提下，避免时间重叠或提供缓解手段 |

**期望**：在不大改架构的前提下，用最简单方式减少或消除「A 还在跑、B 已启动」的冲突（例如 Queue 延后启动、或配置缓冲时间等）。

---

## 相关文件

- `src/queue-sender.ts` — 每轮 `getIndustryForNow` 后若为 queue 行业即执行，无「等上一 slot 收尾」逻辑
- `src/index.ts` — 仅在每轮任务链开始前检查时间（约 123–131 行），任务链执行中不检查
- `src/schedule.ts` — `getIndustryForNow()` 纯按当前时间判定 slot，无进程间状态

---

## 可选方案（由简到繁）

1. **配置层面（无代码改动）**  
   将 B 的起始时间设晚于 A 结束时间一定缓冲（如 15:15 → 15:20），给 A 留足收尾时间。  
   - 优点：零实现成本  
   - 缺点：依赖人工估算，无法精确对齐 A 实际跑完时间  

2. **Queue Sender：进入新 Queue slot 时固定缓冲**  
   若当前 slot 由「上一 slot 为 Playwright」切换而来（或无法得知上一 slot 类型时，统一在进入 queue slot 时），先 `sleep(缓冲毫秒)`（如 5 分钟，可配）再开始本 slot 的拉取与发送。  
   - 优点：实现简单、可配置、能显著减少重叠  
   - 缺点：缓冲固定，可能多等或少等  

3. **进程间协调**  
   Dashboard 或共享状态（如文件）记录「Playwright 当前是否在运行 + 当前/上一 slot 行业 id」；Queue Sender 在进入新 queue slot 时读取并等待「Playwright 已停或已非上一 Playwright slot」再开始。  
   - 优点：更精确  
   - 缺点：需要共享状态与约定，实现与维护成本较高  

---

## 风险与备注

- 若采用方案 2：缓冲时间建议可配置（如 schedule 顶层 `queueSlotStartDelayMs` 或 env），默认 0 保持现有行为，需要时设为 5 分钟等。  
- Playwright 端「任务链中不切 slot」的设计可保留，避免中途关页面导致体验与状态复杂化。
