# 探索：Queue 任务发信逻辑是否需要在 Queue 的 Notion 库里新增 Provider

## 结论

**不需要。** 执行 Queue 任务发信时，Provider 完全来自**发件人库**（与 Sender Account 匹配的那一行），Queue 的 Notion 数据库**不需要**新增 Provider 列。

---

## 数据流简述

1. **Queue 表**  
   - 每条待发任务有例如：Email Status、Sender Account、Email（收件人）、Email Subject、Email Body、Planned Send At、Thread ID、Message ID Last 等。  
   - 解析函数 `pageToQueueItem`（notion-queue.ts）只读上述字段，**不读任何 Provider 属性**；`QueueItem` 类型也没有 `provider` 字段。

2. **发信时**  
   - `queue-sender.ts` 的 `processOne` 调用：  
     `fetchSenderCredentials(notion, senderUrl, item.senderAccount)`  
   - 入参是：发件人库 URL（来自 queue-sender 配置）、以及 **item.senderAccount**（来自该 Queue 行的 **Sender Account** 列）。

3. **fetchSenderCredentials**（notion-queue.ts）  
   - 在**发件人库**里按 **Email** 列等于 `senderAccount` 找一行（先 filter 查，必要时再内存匹配）。  
   - 找到后从**该发件人库行**读取：  
     - `email`（发件人邮箱）  
     - `password`（refresh_token 等）  
     - **provider**（`getProviderFromProps(props)`，即该行的 Provider 列；无或空则 `"Gmail"`）。  
   - 返回 `SenderCredentials { email, password, provider }`。

4. **queue-sender 分支**  
   - 使用 `creds.provider` 决定走 Gmail / Zoho / Microsoft 365 分支并发信。  
   - Provider 始终来自**发件人库那一行**，与 Queue 表无关。

---

## 设计上的合理性

- **发件人**与**厂商（Provider）**是一一对应关系：一个发件人账号只属于 Gmail、Zoho 或 M365 之一。  
- 该对应关系已保存在**发件人库**（每行有 Email、password、Provider）。  
- Queue 表只表达「用哪个发件人」（Sender Account = 发件人库的 Email），不需要也不应在 Queue 上再存一份 Provider；否则会重复且可能不一致。

---

## 小结

| 问题 | 答案 |
|------|------|
| Queue 的 Notion 库是否需要新增 Provider 列？ | **不需要** |
| Provider 从哪里来？ | 发件人库中与 Sender Account（Email）匹配的那一行的 Provider 列 |
| 当前代码是否从 Queue 表读 Provider？ | 否；Queue 解析与 QueueItem 均不包含 Provider |

无需对 Queue 的 Notion 数据库做任何与 Provider 相关的改动。
