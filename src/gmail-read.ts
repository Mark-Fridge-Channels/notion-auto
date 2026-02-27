/**
 * Gmail API 读邮件：用于 Inbound Listener 轮询入站（INBOX、排除 SENT），解析 message 与 body_plain。
 * 使用 gmail.readonly scope；refresh_token 来自发件人库，需用户授权时勾选「查看邮件」。
 * Gmail 请求带重试，缓解 TLS/网络瞬时断开（如 "socket disconnected before secure TLS connection was established"）。
 */

import { google } from "googleapis";
import type { gmail_v1 } from "googleapis";

const GMAIL_RETRY_MAX = 3;
const GMAIL_RETRY_DELAY_MS = 2000;

/** 是否为可重试的网络/TLS 类错误 */
function isRetryableNetworkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /ECONNRESET|ETIMEDOUT|socket disconnected|TLS|ECONNREFUSED|socket hang up|network/i.test(msg) ||
    (err as { code?: string }).code === "ECONNRESET"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 带重试的 Gmail API 调用：遇网络/TLS 瞬时失败时重试最多 GMAIL_RETRY_MAX 次，间隔 GMAIL_RETRY_DELAY_MS。
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= GMAIL_RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < GMAIL_RETRY_MAX && isRetryableNetworkError(e)) {
        await sleep(GMAIL_RETRY_DELAY_MS);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * 使用 refresh_token 获取带读权限的 Gmail 客户端。
 * 需在授权时申请 gmail.readonly（查看邮件），否则无法拉取入站。
 * 需配置 env：GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET。
 */
export function getGmailClientForRead(refreshToken: string): { gmail: gmail_v1.Gmail; userId: string } {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("缺少 GMAIL_CLIENT_ID 或 GMAIL_CLIENT_SECRET 环境变量");
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
  oauth2.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: "v1", auth: oauth2 });
  return { gmail, userId: "me" };
}

/** 用于分类与分析的辅助标志（不参与 Auto Reply 判断的仅作记录） */
export interface InboundMessageFlags {
  /** X-Auto-Response-Suppress 存在则 true，供后续分析邮件生态/对方系统类型 */
  has_x_auto_response_suppress: boolean;
  /** Precedence 为 bulk 或 list 时 true，仅作弱信号记录，不单独判 Auto Reply */
  precedence_bulk_or_list: boolean;
}

/** 单条入站消息标准化结构（供 Notion IM 写入与路由使用） */
export interface InboundMessageParsed {
  gmail_message_id: string;
  thread_id: string;
  from_email: string;
  to_email: string;
  received_at: Date;
  subject: string;
  snippet: string;
  body_plain: string;
  /** Header Auto-Submitted 原始值（如 auto-replied, auto-generated），用于第一层 Auto 判定 */
  auto_submitted: string | null;
  /** Header Precedence 原始值（如 auto_reply, bulk, list），仅 auto_reply 作第一层 Auto 强信号 */
  precedence: string | null;
  /** From 为 mailer-daemon / postmaster 时 true，进入退信分支 */
  is_mailer_daemon_or_postmaster: boolean;
  /** 根或任意 part 的 mimeType 为 multipart/report 时 true，退信候选 */
  has_multipart_report: boolean;
  /** 辅助标志，供分析与后续扩展 */
  flags: InboundMessageFlags;
}

/**
 * 列出入站邮件：INBOX 且排除 SENT；按内部日期倒序，最多 maxResults 条。
 * 返回 message id 列表；完整内容需再调 getMessageAndParse。
 * 遇 TLS/网络瞬时失败时自动重试。
 */
export async function listInboxMessageIds(
  gmail: gmail_v1.Gmail,
  userId: string,
  maxResults: number = 50,
): Promise<{ id: string; threadId: string }[]> {
  return withRetry(async () => {
    const res = await gmail.users.messages.list({
      userId,
      q: "in:inbox -in:sent",
      maxResults: Math.min(Math.max(1, maxResults), 500),
    });
    const list = res.data.messages ?? [];
    return list.map((m) => ({ id: m.id!, threadId: m.threadId ?? "" }));
  });
}

/**
 * 拉取单条 message 完整内容并解析为 InboundMessageParsed。
 * body_plain：优先 text/plain part；无则取 text/html 转纯文本（去 tag、br/p→换行）；再应用截断。
 * 遇 TLS/网络瞬时失败时自动重试。
 */
export async function getMessageAndParse(
  gmail: gmail_v1.Gmail,
  userId: string,
  messageId: string,
  bodyPlainMaxChars: number,
): Promise<InboundMessageParsed | null> {
  const res = await withRetry(() =>
    gmail.users.messages.get({
      userId,
      id: messageId,
      format: "full",
    }),
  );
  const msg = res.data;
  if (!msg.id || !msg.threadId) return null;
  const headers = (msg.payload?.headers ?? []) as Array<{ name?: string; value?: string }>;
  const from = getHeader(headers, "From") ?? "";
  const to = getHeader(headers, "To") ?? "";
  const deliveredTo = getHeader(headers, "Delivered-To");
  const toEmail = (deliveredTo ?? to).trim() || to.trim();
  const subject = getHeader(headers, "Subject") ?? "";
  const internalDate = msg.internalDate ? Number(msg.internalDate) : Date.now();
  const receivedAt = new Date(internalDate);
  const snippet = (msg.snippet ?? "").trim();
  const bodyPlain = extractBodyPlain(msg.payload, bodyPlainMaxChars);

  const autoSubmitted = getHeader(headers, "Auto-Submitted");
  const precedenceRaw = getHeader(headers, "Precedence");
  const precedence = precedenceRaw ? precedenceRaw.trim().toLowerCase() : null;
  const hasXAutoResponseSuppress = getHeader(headers, "X-Auto-Response-Suppress") != null;

  const fromL = from.toLowerCase();
  const isMailerDaemonOrPostmaster =
    fromL.includes("mailer-daemon") || fromL.includes("postmaster");
  const hasMultipartReport = hasMultipartReportMimeType(msg.payload);

  const flags: InboundMessageFlags = {
    has_x_auto_response_suppress: hasXAutoResponseSuppress,
    precedence_bulk_or_list: precedence === "bulk" || precedence === "list",
  };

  return {
    gmail_message_id: msg.id,
    thread_id: msg.threadId,
    from_email: from.trim(),
    to_email: toEmail,
    received_at: receivedAt,
    subject: subject.trim(),
    snippet,
    body_plain: bodyPlain,
    auto_submitted: autoSubmitted,
    precedence,
    is_mailer_daemon_or_postmaster: isMailerDaemonOrPostmaster,
    has_multipart_report: hasMultipartReport,
    flags,
  };
}

function getHeader(headers: Array<{ name?: string; value?: string }>, name: string): string | null {
  const lower = name.toLowerCase();
  const h = headers.find((x) => (x.name ?? "").toLowerCase() === lower);
  return h?.value?.trim() ?? null;
}

/**
 * 递归检查 payload 根或任意 part 的 mimeType 是否为 multipart/report（退信 DSN 等）。
 */
function hasMultipartReportMimeType(payload: gmail_v1.Schema$MessagePart | undefined): boolean {
  if (!payload) return false;
  const mime = (payload.mimeType ?? "").toLowerCase();
  if (mime === "multipart/report") return true;
  const parts = payload.parts ?? [];
  for (const p of parts) {
    if ((p.mimeType ?? "").toLowerCase() === "multipart/report") return true;
    if (hasMultipartReportMimeType(p)) return true;
  }
  return false;
}

/**
 * 从 payload 提取纯文本：优先 text/plain；无则 text/html 转纯文本；截断为 maxChars，超长保留开头+结尾。
 */
function extractBodyPlain(payload: gmail_v1.Schema$MessagePart | undefined, maxChars: number): string {
  let text = "";
  if (payload?.parts?.length) {
    const plainPart = payload.parts.find((p) => (p.mimeType ?? "").toLowerCase() === "text/plain");
    const htmlPart = payload.parts.find((p) => (p.mimeType ?? "").toLowerCase() === "text/html");
    if (plainPart?.body?.data) {
      text = decodeBase64Url(plainPart.body.data);
    } else if (htmlPart?.body?.data) {
      text = htmlToPlainText(decodeBase64Url(htmlPart.body.data));
    }
  } else if (payload?.body?.data) {
    const mime = (payload.mimeType ?? "").toLowerCase();
    const raw = decodeBase64Url(payload.body.data);
    if (mime === "text/plain") text = raw;
    else if (mime === "text/html") text = htmlToPlainText(raw);
    else text = raw;
  }
  return truncateWithHeadTail(text, maxChars);
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

/** 简单 html 转纯文本：去标签，br/p 换行 */
function htmlToPlainText(html: string): string {
  let s = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<p\s[^>]*>/gi, "\n")
    .replace(/<p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<div\s[^>]*>/gi, "\n")
    .replace(/<div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 超长保留开头+结尾（结尾常有 STOP/签名/DSN） */
function truncateWithHeadTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 50; // 50 for "... [truncated] ..."
  return s.slice(0, head) + "\n\n... [truncated] ...\n\n" + s.slice(-tail);
}
