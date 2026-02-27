# Queue Sender：时间到了但 email list 还没发完 — 分析与可选方案

## 当前实现摘要

- **时间区间**：`schedule.timeSlots` 定义「左闭右开」时段（如 9:00–12:00），`getIndustryForNow(schedule)` 用**当前时间**判断是否落在某 slot、并返回对应行业；未落在任何 slot 返回 `null`。
- **Queue Sender 主循环**（`queue-sender.ts` main）：
  1. 调用 `getIndustryForNow(schedule)`。
  2. 若 `industry == null`（当前不在任何时段）→ `sleep(60s)`，不拉取、不发送，然后继续循环。
  3. 若当前行业不是 Queue 类型 → 同样 sleep 60s，继续。
  4. 否则执行 `runOneRound()`：拉取最多 `batchSize` 条 Pending，按发送者分组，**每个发送者本轮至多发 1 条**（节流），然后返回建议 `sleepMs`（通常几分钟），主循环 `sleep(sleepMs)` 后进入下一轮。
- **一轮的粒度**：不是「把整批 100 条发完」，而是「每发送者最多 1 条 + 节流间隔」。所以「email list 没发完」是常态：多轮才会慢慢消化队列；每轮结束会 sleep 再进入下一轮。

---

## 场景：「时间到了」但队列还没发完

- **时间到了**：当前时间离开配置的 Queue 时段（例如 12:00 结束，当前 12:01）。
- **还没发完**：Notion Queue 里仍有 Pending 项。

### 当前实际行为

1. **只在循环入口检查时间**  
   是否在时段内，只在每次 `for (;;)` 迭代开头用 `getIndustryForNow` 判断。**不会**在 `runOneRound` 内部、或某条 `processOne` 前后再查一次时间。

2. **时间到后的表现**  
   - 下一轮循环时 `getIndustryForNow` 为 `null` → 不再调用 `runOneRound`，只 sleep 60s，如此反复，直到下一个时段再开始发送。  
   - 未发完的 Pending 一直留在 Notion，下次进入 Queue 时段会继续被拉取、发送。  
   - **没有**「时间到了就停当前轮」或「时间到了就中止进程」的逻辑。

3. **可能的「越界一发」**  
   - 若在 11:59 进入 `runOneRound`，对多个发送者各发 1 条，或 sleep 前时间已过 12:00，则下一轮醒来时已经出 slot，不会再多发。  
   - 若在 11:59:50 开始 `processOne(某条)`，该条可能到 12:00:05 才发完；**这一条会发出去**，因为 runOneRound 内部不检查时间。  
   - 即：**最多可能多发出「当前轮已开始处理的那几条」**，不会整批继续发。

---

## 可选处理策略

| 策略 | 含义 | 实现要点 | 备注 |
|------|------|----------|------|
| **A. 保持现状** | 只在循环入口看是否在时段内；出时段就只 sleep，不拉新、不主动停当前轮。 | 无需改代码；在文档中说明「可能多发出当前轮已开始的几条」。 | 实现简单；可能有少量「刚过点仍发出」的邮件。 |
| **B. 轮内严格不超时** | 进入时段内才跑 `runOneRound`，且**在本轮内每条发送前**再查一次时间，若已出时段则立即结束本轮、不再发更多。 | 1）在 main 里把当前 slot 的结束时间（或 `getIndustryForNow` 的判定结果）传给 `runOneRound`；2）在 `runOneRound` 的 `for (const [senderKey, list] of bySender)` 里，在每次 `processOne` 前用 `getIndustryForNow(schedule)` 或当前时间与 slot 结束时间比较，若已出时段则 `break` 并返回。 | 能避免「时间到后还新开 processOne」；已进入 processOne 的那条仍可能发完（不中断 Gmail 请求）。 |
| **C. 整轮不超时** | 只在「本轮开始」时检查是否仍在时段内；若 sleep 后醒来已超时，则本就不会进入 runOneRound（当前已是这样）。再可选：在 runOneRound **开头**再查一次，若已出时段则直接 return，不拉取、不发送。 | 在 `runOneRound` 最前面调用 `getIndustryForNow(schedule)`（需传入 schedule），若为 null 或非当前 industry 则立即 return `{ sleepMs: SLEEP_NO_SLOT_MS }` 或让 main 自己处理。 | 避免「醒来已出 slot 却仍执行了一轮拉取+发送」的边界情况（例如时钟跳变、或 schedule 在运行中被改）。 |
| **D. 宽限时间（grace period）** | 时段结束后再允许跑 N 分钟，用于「把当前轮发完」或「只把已拉取的这批发完」。 | 在 `getIndustryForNow` 或单独函数里实现「当前时间在 [slotEnd, slotEnd + graceMs] 内仍视为可发送」；Queue Sender 用该逻辑决定是否进入 runOneRound。 | 需配置 grace（如 5 分钟）和明确语义（只发当前轮？还是到 grace 结束为止多轮？）。 |

---

## 建议与待定

- **若可接受「最多多出当前轮几条」**：选 **A**，仅文档说明即可。  
- **若希望严格不超出时段（仅允许已开始的 processOne 发完）**：在 **A** 基础上做 **B**（轮内每条前检查时间）；可选加上 **C**（runOneRound 开头再查一次）。  
- **若希望时间到后还有短时间「收尾」**：再考虑 **D**，并约定 grace 语义（例如仅允许完成当前轮、不再拉新批）。

实现 **B/C** 时需注意：

- `runOneRound` 目前只接收 `(notion, industry, throttle, senderStates)`，不接收 `schedule`。若在 runOneRound 内调用 `getIndustryForNow(schedule)`，需要 main 传入 `schedule`，或在 runOneRound 内重新 `loadSchedule`（有轻微重复加载，可接受）。
- Slot 结束时间：`getIndustryForNow` 只返回「当前是否在某个 slot」，不直接返回结束时间。若要做「当前时间 < slotEnd 才发」，需要从 `schedule.timeSlots` 里根据当前 slot 算出 end 时刻（或扩展 getIndustryForNow 返回 end 时间）。

---

## 涉及文件

| 文件 | 可能改动 |
|------|----------|
| `src/queue-sender.ts` | main 循环逻辑；可选：向 runOneRound 传入 schedule 或 slotEnd；runOneRound 内每条发送前或开头做时间检查。 |
| `src/schedule.ts` | 可选：新增「根据当前 slot 返回结束时间」或带 grace 的判定，供 queue-sender 使用。 |

---

## 小结

- **现状**：时间到了之后，Queue Sender 只会在下一轮循环时发现「不在时段」并停止拉取/发送；未发完的留在 Queue 下次时段再发；可能出现「刚过点仍发出当前轮已开始的几条」。
- **是否需要改**：取决于是否接受上述边界行为；若需严格不超时或带 grace，可按上表选 B/C/D 之一实现并配文档。
