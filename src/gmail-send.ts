/**
 * Gmail API 发信：Cold1（新线程）与 Followup（同一 thread，In-Reply-To/References）。
 * 使用发件人库中的 refresh_token（存于 password 字段）与 env 中的 GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET 做 OAuth2。
 */

import { google } from "googleapis";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"];

/**
 * 使用 refresh_token 获取 Gmail 客户端（OAuth2）。
 * 需配置 env：GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET；refreshToken 来自发件人库的 password 字段。
 */
export function getGmailClient(refreshToken: string): { gmail: import("googleapis").gmail_v1.Gmail; userId: string } {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("缺少 GMAIL_CLIENT_ID 或 GMAIL_CLIENT_SECRET 环境变量");
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  return { gmail, userId: "me" };
}

/**
 * 纯文本转 HTML 正文：转义 & < >，换行 → <br>。
 * 用于以 text/html 发送时的正文，使 \n 在邮件客户端显示为换行。Queue Sender 与 Reply Tasks 共用。
 */
export function plainToHtml(plain: string): string {
  const escaped = String(plain)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(/\n/g, "<br>\n");
}

/** 将 MIME 字符串转为 Gmail API 要求的 base64url（无填充，+ -> -, / -> _） */
function toBase64Url(mime: string): string {
  const raw = Buffer.from(mime, "utf-8").toString("base64");
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成 Cold1 新邮件 MIME：To, Subject, Content-Type: text/html，无 thread 头。 */
function buildCold1Mime(from: string, to: string, subject: string, htmlBody: string): string {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject.replace(/\r?\n/g, " ")}`,
    "MIME-Version: 1.0",
    `Content-Type: text/html; charset="UTF-8"`,
    "",
    htmlBody.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
  ];
  return lines.join("\r\n");
}

/**
 * Cold1：新线程发送；返回 message.id 与 threadId。
 */
export async function sendCold1(
  gmail: import("googleapis").gmail_v1.Gmail,
  userId: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<{ messageId: string; threadId: string }> {
  const mime = buildCold1Mime(from, to, subject, htmlBody);
  const raw = toBase64Url(mime);
  const res = await gmail.users.messages.send({
    userId,
    requestBody: { raw },
  });
  const messageId = res.data.id;
  const threadId = res.data.threadId;
  if (!messageId || !threadId) throw new Error("Gmail API 未返回 message id 或 threadId");
  return { messageId, threadId };
}

/** 生成 Followup MIME：带 In-Reply-To、References，使 Gmail 归入同一 thread。 */
function buildFollowupMime(
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
  messageIdLast: string,
): string {
  const inReplyTo = messageIdLast.startsWith("<") ? messageIdLast : `<${messageIdLast}>`;
  const references = inReplyTo;
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject.replace(/\r?\n/g, " ")}`,
    `In-Reply-To: ${inReplyTo}`,
    `References: ${references}`,
    "MIME-Version: 1.0",
    `Content-Type: text/html; charset="UTF-8"`,
    "",
    htmlBody.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
  ];
  return lines.join("\r\n");
}

/**
 * 在同一 thread 内发送回复，仅传 threadId，不设 In-Reply-To/References（首版简化）。
 * Gmail 会根据 threadId 将邮件归入同一会话。
 */
export async function sendInThread(
  gmail: import("googleapis").gmail_v1.Gmail,
  userId: string,
  threadId: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<{ messageId: string; threadId: string }> {
  const mime = buildCold1Mime(from, to, subject, htmlBody);
  const raw = toBase64Url(mime);
  const res = await gmail.users.messages.send({
    userId,
    requestBody: { raw, threadId },
  });
  const messageId = res.data.id;
  const returnedThreadId = res.data.threadId;
  if (!messageId || !returnedThreadId) throw new Error("Gmail API 未返回 message id 或 threadId");
  return { messageId, threadId: returnedThreadId };
}

/**
 * Followup：在同一 thread 内发送；需传入 threadId 与 Message ID Last（用于 In-Reply-To/References）。
 */
export async function sendFollowup(
  gmail: import("googleapis").gmail_v1.Gmail,
  userId: string,
  threadId: string,
  messageIdLast: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<{ messageId: string; threadId: string }> {
  const mime = buildFollowupMime(from, to, subject, htmlBody, messageIdLast);
  const raw = toBase64Url(mime);
  const res = await gmail.users.messages.send({
    userId,
    requestBody: { raw, threadId },
  });
  const messageId = res.data.id;
  const returnedThreadId = res.data.threadId;
  if (!messageId || !returnedThreadId) throw new Error("Gmail API 未返回 message id 或 threadId");
  return { messageId, threadId: returnedThreadId };
}
