# 探索：Queue 获取列表后不直接发送，而是保存到 Gmail 的 scheduled 按设定时间发

## 需求理解

- 当前：获取 Queue 列表（Planned Send At 已到）后，**立即**调用 Gmail API 发送。
- 期望：获取到列表后**不直接发送**，而是**保存到 Gmail 的「定时发送」**，由 Gmail 在设定好的时间（Planned Send At）发送。

## 结论：Gmail API 不支持「保存到 Gmail 的 scheduled」

- **Gmail 网页/客户端里的「定时发送」**没有对公网开放 API。官方文档与社区一致结论：
  - `users.messages.send`、`users.drafts.send` 都是**立即发送**，没有「在指定时间发送」的参数。
  - 不存在「把邮件加入 Gmail 内部定时发送队列」的接口（无 `sendAt`、无 scheduled 标签等）。
- 因此：**无法实现**「把 Queue 里的邮件保存到 Gmail 的 scheduled，由 Gmail 按设定时间发」—— 这一能力在 API 层面不存在。

## 当前实现实际在做什么

- 在 **notion-queue**：只查询 **Email Status=Pending** 且 **now >= Planned Send At** 的项（以及四 Flag、Subject/Body 等条件）。
- 在 **queue-sender**：对这批项**立即**调用 Gmail API 发送，并回写 Notion。
- 也就是说：**发送时机**是由我们控制的——只有「计划发送时间已到」的项才会被查出来并发送；发送动作是即时的，但**不会在计划时间之前**发送。

## 若目标是「更贴近设定时间发送」

若需求是「尽量在 Planned Send At 那一刻发」，而不是「交给 Gmail 的 Schedule send」：

- **可行方向**都在我们这边，不能依赖 Gmail 的定时发送：
  - 提高轮询频率（例如每 1 分钟跑一次 Queue Sender），使「到点」到「实际发送」的延迟更小。
  - 或引入按时间触发的调度（如 cron / 内部任务队列），在 Planned Send At 附近触发「只处理该条」的发送。
- 这些都属于**我们自己的调度逻辑**，仍然用 `messages.send` 即时发，而不是「存到 Gmail scheduled」。

## 若目标是「在 Gmail 里看到待发/定时邮件」

- 若希望用户在 Gmail 网页/客户端里能看到「待定时发送」的邮件：
  - 可以用 **drafts.create** 在 Gmail 里创建草稿，但 **drafts.send 仍是立即发送**，API 不能为草稿设置「发送时间」。
  - 所以只能做到「在我们这边记住 Planned Send At，到点再调用 drafts.send」—— 发送仍由我们触发，不是 Gmail 的 Schedule send。

## 总结

| 问题 | 答案 |
|------|------|
| 能否把邮件「保存到 Gmail 的 scheduled」按设定时间发？ | **不能**。Gmail API 不提供该能力。 |
| 当前是否已经按「计划时间」控制发送？ | **是**。只有 Planned Send At 已到的项才会被取出并发送。 |
| 想更贴近「设定时间」发送可以怎么做？ | 在我们这边做：更密轮询或按时间触发，仍用 `messages.send` 即时发。 |

---

探索结论：**「保存到 Gmail 的 scheduled」无法通过 API 实现**；若需更精确到设定时间发送，只能在现有架构上加强我们自己的调度（轮询频率或定时任务），不能依赖 Gmail 的定时发送功能。
