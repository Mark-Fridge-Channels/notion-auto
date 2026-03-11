/**
 * Zoho Mail API：发信（新邮件、回复）与读信（列收件箱、取单封），产出与 gmail-read 的 InboundMessageParsed 同构结构。
 * 使用 refresh_token 换 access_token；区域由 env ZOHO_REGION（默认 com）决定 token URL 与 API base。
 */

import type { InboundMessageParsed, InboundMessageFlags } from "./gmail-read.js";

const ZOHO_REGION_DEFAULT = "com";

function getZohoRegion(): string {
  const r = process.env.ZOHO_REGION?.trim()?.toLowerCase();
  return r === "eu" || r === "com.cn" ? r : ZOHO_REGION_DEFAULT;
}

function getZohoTokenUrl(region: string): string {
  const domain = region === "com.cn" ? "zoho.com.cn" : `zoho.${region}`;
  return `https://accounts.${domain}/oauth/v2/token`;
}

function getZohoMailBaseUrl(region: string): string {
  const domain = region === "com.cn" ? "zoho.com.cn" : `zoho.${region}`;
  return `https://mail.${domain}`;
}

/**
 * 使用 refresh_token 换取 access_token。需 env：ZOHO_CLIENT_ID、ZOHO_CLIENT_SECRET；ZOHO_REDIRECT_URI 须与注册一致（可选，默认 https://localhost）。
 */
export async function getZohoAccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.ZOHO_CLIENT_ID?.trim();
  const clientSecret = process.env.ZOHO_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new Error("缺少 ZOHO_CLIENT_ID 或 ZOHO_CLIENT_SECRET 环境变量");
  const region = getZohoRegion();
  const redirectUri = process.env.ZOHO_REDIRECT_URI?.trim() || "https://localhost";
  const url = getZohoTokenUrl(region);
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "refresh_token",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Zoho token 请求失败: ${res.status} ${t}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("Zoho 未返回 access_token");
  return data.access_token;
}

async function zohoApiGet(accessToken: string, path: string): Promise<unknown> {
  const region = getZohoRegion();
  const base = getZohoMailBaseUrl(region);
  const url = `${base}${path.startsWith("/") ? path : `/api${path}`}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Zoho API GET 失败: ${res.status} ${t}`);
  }
  return res.json();
}

async function zohoApiPost(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const region = getZohoRegion();
  const base = getZohoMailBaseUrl(region);
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? path : `/api${path}`}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Zoho-oauthtoken ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Zoho API POST 失败: ${res.status} ${t}`);
  }
  return res.json();
}

/**
 * 获取当前用户第一个账号的 accountId（用于发信/读信）。
 */
export async function getZohoAccountId(accessToken: string): Promise<string> {
  const raw = await zohoApiGet(accessToken, "/api/accounts");
  const data = (raw as { data?: Array<{ accountId?: string; id?: string }> }).data;
  if (!Array.isArray(data) || data.length === 0)
    throw new Error("Zoho Get All Accounts 未返回账号");
  const first = data[0];
  const id = first?.accountId ?? first?.id;
  if (!id) throw new Error("Zoho 账号对象缺少 accountId/id");
  return String(id);
}

/**
 * 获取收件箱 folderId。需先有 accountId。
 */
export async function getZohoInboxFolderId(
  accessToken: string,
  accountId: string,
): Promise<string> {
  const raw = await zohoApiGet(accessToken, `/api/accounts/${accountId}/folders`);
  const data = (raw as { data?: Array<{ folderType?: string; folderId?: string }> }).data;
  if (!Array.isArray(data))
    throw new Error("Zoho Get Folders 未返回 data");
  const inbox = data.find((f) => (f.folderType ?? "").toLowerCase() === "inbox");
  if (!inbox?.folderId) throw new Error("Zoho 未找到 Inbox folderId");
  return String(inbox.folderId);
}

/** 发信结果：messageId 与 threadId（Zoho 列表项含 threadId，新邮件返回可能无 threadId，调用方可用 messageId 占位） */
export interface ZohoSendResult {
  messageId: string;
  threadId: string;
}

/**
 * 新邮件（Cold1）。若 API 返回 messageId 则用其作为 threadId 占位；未返回时用占位，与 M365 一致，避免因响应结构差异导致抛错。
 */
export async function sendZohoCold1(
  accessToken: string,
  accountId: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<ZohoSendResult> {
  const raw = await zohoApiPost(accessToken, `/api/accounts/${accountId}/messages`, {
    fromAddress: from,
    toAddress: to,
    subject,
    content: htmlBody,
    mailFormat: "html",
  });
  const res = raw as { data?: { messageId?: string } };
  const messageId = (res.data?.messageId ?? "").trim();
  const threadId = messageId || "zoho-sent";
  return { messageId: messageId || threadId, threadId };
}

/**
 * 回复同一 thread（Zoho 按 messageId 回复即归入同一会话）。
 */
export async function sendZohoReply(
  accessToken: string,
  accountId: string,
  messageId: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<ZohoSendResult> {
  await zohoApiPost(accessToken, `/api/accounts/${accountId}/messages/${messageId}`, {
    action: "reply",
    fromAddress: from,
    toAddress: to,
    subject,
    content: htmlBody,
    mailFormat: "html",
  });
  return { messageId, threadId: messageId };
}

/** 列表项：id、threadId 及可选元数据（用于 getZohoMessageAndParse） */
export interface ZohoMessageListItem {
  id: string;
  threadId: string;
  fromAddress?: string;
  toAddress?: string;
  subject?: string;
  summary?: string;
  receivedTime?: string;
}

export async function listZohoInboxMessageIds(
  accessToken: string,
  accountId: string,
  folderId: string,
  maxResults: number = 50,
): Promise<ZohoMessageListItem[]> {
  const limit = Math.min(Math.max(1, maxResults), 200);
  const raw = await zohoApiGet(
    accessToken,
    `/api/accounts/${accountId}/messages/view?folderId=${encodeURIComponent(folderId)}&limit=${limit}&sortBy=date&sortorder=false`,
  );
  const data = (raw as { data?: Array<Record<string, unknown>> }).data;
  if (!Array.isArray(data)) return [];
  return data.map((m) => ({
    id: String(m.messageId ?? m.message_id ?? ""),
    threadId: String(m.threadId ?? m.thread_id ?? m.messageId ?? m.message_id ?? ""),
    fromAddress: typeof m.fromAddress === "string" ? m.fromAddress : undefined,
    toAddress: typeof m.toAddress === "string" ? m.toAddress : undefined,
    subject: typeof m.subject === "string" ? m.subject : undefined,
    summary: typeof m.summary === "string" ? m.summary : undefined,
    receivedTime: typeof m.receivedTime === "string" ? m.receivedTime : undefined,
  })).filter((x) => x.id);
}

/** 简单 HTML 转纯文本（与 gmail-read 对齐） */
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

function truncateWithHeadTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head - 50;
  return s.slice(0, head) + "\n\n... [truncated] ...\n\n" + s.slice(-tail);
}

/**
 * 取单封邮件内容并解析为 InboundMessageParsed。Zoho 只返回 HTML 正文，无完整 headers，故 auto_submitted/precedence 等为 null；listMeta 来自列表接口可带 from/to/subject/summary/receivedTime。
 */
export async function getZohoMessageAndParse(
  accessToken: string,
  accountId: string,
  folderId: string,
  messageId: string,
  bodyPlainMaxChars: number,
  listMeta?: ZohoMessageListItem,
): Promise<InboundMessageParsed | null> {
  const raw = await zohoApiGet(
    accessToken,
    `/api/accounts/${accountId}/folders/${folderId}/messages/${messageId}/content`,
  );
  const res = raw as { data?: { messageId?: unknown; content?: string } };
  const html = res.data?.content;
  const bodyPlain = truncateWithHeadTail(htmlToPlainText(html ?? ""), bodyPlainMaxChars);
  const from = (listMeta?.fromAddress ?? "").trim() || "unknown";
  const to = (listMeta?.toAddress ?? "").trim() || "";
  const subject = (listMeta?.subject ?? "").trim();
  const snippet = (listMeta?.summary ?? bodyPlain.slice(0, 200)).trim();
  const receivedTime = listMeta?.receivedTime;
  const receivedAt = receivedTime ? new Date(Number(receivedTime)) : new Date();
  const fromL = from.toLowerCase();
  const isMailerDaemonOrPostmaster =
    fromL.includes("mailer-daemon") || fromL.includes("postmaster");
  const flags: InboundMessageFlags = {
    has_x_auto_response_suppress: false,
    precedence_bulk_or_list: false,
  };
  return {
    gmail_message_id: String(messageId),
    thread_id: String(listMeta?.threadId ?? messageId),
    from_email: from,
    to_email: to,
    received_at: receivedAt,
    subject,
    snippet,
    body_plain: bodyPlain,
    auto_submitted: null,
    precedence: null,
    is_mailer_daemon_or_postmaster: isMailerDaemonOrPostmaster,
    has_multipart_report: false,
    flags,
  };
}
