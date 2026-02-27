# Queue Sender 正文换行修复

**Overall Progress:** `100%`

## TLDR
修复 Sender Queue 发送时邮件正文换行丢失：Notion Email Body（多行文本）在取数时保留段间换行，发送前将纯文本转为 HTML（\n→\<br\>）以便在 text/html 下正确显示。

## Critical Decisions
- **Email Body 取数**：仅对 Email Body 使用「段间用 \n 拼接」的 getRichTextWithNewlines，其它属性保持 getRichText，避免影响 Subject 等单行字段。
- **正文格式**：沿用 text/html 发送，复用与 Reply Tasks 一致的 plainToHtml（转义 + 换行→\<br\>），统一放在 gmail-send 并供 queue-sender、reply-tasks-send 使用。

## Tasks

- [x] 🟩 **Step 1: notion-queue 对 Email Body 保留换行**
  - [x] 🟩 新增 getRichTextWithNewlines(prop)，rich_text 段用 "\n" 拼接
  - [x] 🟩 pageToQueueItem 中 emailBody 改用 getRichTextWithNewlines(props["Email Body"]).trim()

- [x] 🟩 **Step 2: 发送前纯文本转 HTML**
  - [x] 🟩 gmail-send 中新增并导出 plainToHtml(plain)
  - [x] 🟩 reply-tasks-send 改为从 gmail-send 导入 plainToHtml，删除本地实现
  - [x] 🟩 queue-sender 发信前对 item.emailBody 使用 plainToHtml 再传入 sendCold1/sendFollowup
