# 探索：监听邮件写入 Inbound 是否已按 Provider 分支并回写

## 结论：**是，已实现**

当前 Inbound Listener 已做到：
1. **按发件人库的 Provider 列**决定用哪家厂商 API 拉取邮件（Gmail / Zoho / Microsoft 365）；
2. **写入 📥 Inbound Messages（IM）时**，把该 mailbox 对应的 Provider 写入 IM 表的 **Provider** 列。

---

## 数据流（简要）

| 步骤 | 数据来源 | 行为 |
|------|----------|------|
| 1 | 配置 `inbound-listener.json` | 每个 group 有 `sender_accounts_database_url`、`mailboxes[]`（发件人库的 Email）。 |
| 2 | 发件人库（Notion） | 对每个 mailbox 调 `fetchSenderCredentials(notion, sender_url, mailbox)`，得到 `{ email, password, provider }`；**provider 来自发件人库该行的 Provider 列**（无或空则 "Gmail"）。 |
| 3 | 按 provider 分支 | `provider === "Gmail"` → gmail-read 列收件箱 + 解析；`"Zoho"` → zoho-mail；`"Microsoft 365"` → m365-mail。得到与 `InboundMessageParsed` 同构的数据。 |
| 4 | 写 IM | `processOneMessage(..., provider)` 内调 `createInboundMessageRow(..., { ..., provider: provider || "Gmail" })`；**notion-inbound 写入 IM 表时设置属性 `"Provider": { select: { name: providerName } }`**，即**回写到 IM 的 Provider 列**。 |

因此：
- **「根据 Provider 列进行不同厂商的处理」**：用的是**发件人库**的 Provider 列（每行一个邮箱对应一个 provider），按该值选择 Gmail / Zoho / M365 的读信实现。
- **「回写到 inbound 列」**：每条新写入的 IM 行都会带上 **Provider** 属性，值即为当前拉取该邮件时使用的 provider（来自发件人库该行），方便后续 Reply 发信时从 IM 读 Provider 选 API。

---

## 代码位置（便于核对）

- **读 Provider（发件人库）**：`notion-queue.ts` 的 `fetchSenderCredentials` → `getProviderFromProps(props)`，返回 `SenderCredentials.provider`。
- **按 Provider 分支拉信**：`inbound-listener.ts` 主循环约 383–442 行，`const provider = (creds.provider ?? "Gmail").trim() || "Gmail"`，然后 `if (provider === "Gmail")` / `else if (provider === "Zoho")` / `else if (provider === "Microsoft 365")`。
- **写 IM 时传入 provider**：`inbound-listener.ts` 的 `processOneMessage(..., provider)` 约 314–330 行，调用 `createInboundMessageRow(..., { ..., provider: provider || "Gmail" })`。
- **回写到 IM 的 Provider 列**：`notion-inbound.ts` 的 `createInboundMessageRow`，约 95、110 行，`providerName = (params.provider ?? "Gmail").trim() || "Gmail"`，`"Provider": { select: { name: providerName } }`。

---

## 小结

- 监听邮件写入 Inbound 时，**已经**根据**发件人库的 Provider 列**做不同厂商（Gmail/Zoho/M365）的拉信处理。
- 写入的每条 IM 行**已经**带有 **Provider** 列的回写，值与发件人库该行一致，供 Reply 等逻辑使用。

无需再改实现即可满足「按 Provider 处理 + 回写到 IM 的 Provider 列」的需求。
