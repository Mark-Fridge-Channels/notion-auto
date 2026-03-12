/**
 * Microsoft Graph 邮件 API：发信（新邮件、回复）与读信（列收件箱、取单封），产出与 gmail-read 的 InboundMessageParsed 同构结构。
 * 使用 refresh_token 换 access_token；tenant 由 env M365_TENANT（默认 common）决定。
 */

import type { InboundMessageParsed, InboundMessageFlags } from "./gmail-read.js";

const M365_TENANT_DEFAULT = "common";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

function getM365Tenant(): string {
  const t = process.env.M365_TENANT?.trim();
  return t || M365_TENANT_DEFAULT;
}

/**
 * 使用 refresh_token 换取 access_token。需 env：M365_CLIENT_ID、M365_CLIENT_SECRET；scope 含 offline_access、Mail.Read、Mail.Send。
 */
export async function getM365AccessToken(refreshToken: string): Promise<string> {
  const clientId = process.env.M365_CLIENT_ID?.trim();
  const clientSecret = process.env.M365_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret)
    throw new Error("缺少 M365_CLIENT_ID 或 M365_CLIENT_SECRET 环境变量");
  const tenant = getM365Tenant();
  const url = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    scope: "offline_access https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`M365 token 请求失败: ${res.status} ${t}`);
  }
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error("M365 未返回 access_token");
  return data.access_token;
}

async function graphGet(accessToken: string, path: string): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Graph GET 失败: ${res.status} ${t}`);
  }
  return res.json();
}

async function graphPost(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) {
    const t = await res.text();
    throw new Error(`Graph POST 失败: ${res.status} ${t}`);
  }
  if (res.status === 202) return {};
  return res.json();
}

async function graphPatch(
  accessToken: string,
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 200 && res.status !== 202 && res.status !== 204) {
    const t = await res.text();
    throw new Error(`Graph PATCH 失败: ${res.status} ${t}`);
  }
  if (res.status === 204 || res.status === 202) return {};
  return res.json();
}

/** 发信结果：Graph sendMail 不返回 messageId；reply 也不返回。调用方用占位或仅 threadId。 */
export interface M365SendResult {
  messageId: string;
  threadId: string;
}

/**
 * 新邮件（Cold1）。Graph sendMail 返回 202 无 body，不返回 messageId，故返回占位；Message ID Last 写入 Notion 后仅为占位，该行后续作 Followup 需真实 message id（如从已发送文件夹查），当前简化实现仅保证 Cold1 成功。
 */
export async function sendM365Cold1(
  accessToken: string,
  from: string,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<M365SendResult> {
  await graphPost(accessToken, "/me/sendMail", {
    message: {
      subject,
      body: { contentType: "HTML", content: htmlBody },
      toRecipients: [{ emailAddress: { address: to } }],
    },
    saveToSentItems: true,
  });
  return { messageId: "", threadId: "m365-cold1" };
}

/**
 * 回复同一会话。POST /me/messages/{id}/reply，body 含 comment（回复正文，可为 HTML）。
 */
export async function sendM365Reply(
  accessToken: string,
  messageId: string,
  htmlBody: string,
): Promise<M365SendResult> {
  await graphPost(accessToken, `/me/messages/${messageId}/reply`, {
    comment: htmlBody,
  });
  return { messageId, threadId: messageId };
}

export async function markM365MessageRead(accessToken: string, messageId: string): Promise<void> {
  await graphPatch(accessToken, `/me/messages/${messageId}`, {
    isRead: true,
  });
}

export async function flagM365Message(accessToken: string, messageId: string): Promise<void> {
  await graphPatch(accessToken, `/me/messages/${messageId}`, {
    flag: {
      flagStatus: "flagged",
    },
  });
}

export async function addM365Contact(
  accessToken: string,
  email: string,
  displayName: string,
): Promise<string> {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  const givenName = parts[0] ?? email;
  const surname = parts.slice(1).join(" ");
  const raw = await graphPost(accessToken, "/me/contacts", {
    givenName,
    surname,
    emailAddresses: [{ address: email, name: displayName || email }],
  });
  const data = raw as { id?: string };
  const contactId = data.id?.trim();
  if (!contactId) throw new Error("Graph Contacts 未返回 id");
  return contactId;
}

/** 列表项：id、conversationId（作 threadId 用）及可选元数据 */
export interface M365MessageListItem {
  id: string;
  threadId: string;
  subject?: string;
  from?: string;
  toRecipients?: Array<{ emailAddress?: { address?: string } }>;
  receivedDateTime?: string;
  bodyPreview?: string;
}

export async function listM365InboxMessageIds(
  accessToken: string,
  maxResults: number = 50,
): Promise<M365MessageListItem[]> {
  const top = Math.min(Math.max(1, maxResults), 1000);
  const raw = await graphGet(
    accessToken,
    `/me/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview`,
  );
  const value = (raw as { value?: Array<Record<string, unknown>> }).value;
  if (!Array.isArray(value)) return [];
  return value.map((m) => ({
    id: String(m.id ?? ""),
    threadId: String(m.conversationId ?? m.id ?? ""),
    subject: typeof m.subject === "string" ? m.subject : undefined,
    from: typeof (m.from as { emailAddress?: { address?: string } })?.emailAddress?.address === "string"
      ? (m.from as { emailAddress: { address: string } }).emailAddress.address
      : undefined,
    toRecipients: Array.isArray(m.toRecipients) ? m.toRecipients : undefined,
    receivedDateTime: typeof m.receivedDateTime === "string" ? m.receivedDateTime : undefined,
    bodyPreview: typeof m.bodyPreview === "string" ? m.bodyPreview : undefined,
  })).filter((x) => x.id);
}

export async function findLatestM365MessageIdByConversation(
  accessToken: string,
  conversationId: string,
): Promise<string | null> {
  const escapedConversationId = conversationId.replace(/'/g, "''");
  const filter = encodeURIComponent(`conversationId eq '${escapedConversationId}'`);
  const raw = await graphGet(
    accessToken,
    `/me/messages?$top=1&$orderby=receivedDateTime%20desc&$filter=${filter}&$select=id`,
  );
  const value = (raw as { value?: Array<{ id?: string }> }).value;
  const messageId = value?.[0]?.id?.trim();
  return messageId || null;
}

/**
 * 取单封邮件并解析为 InboundMessageParsed。使用 Prefer: outlook.body-content-type=text 请求纯文本；若无则用 body.content 做 HTML→纯文本。
 */
export async function getM365MessageAndParse(
  accessToken: string,
  messageId: string,
  bodyPlainMaxChars: number,
  listMeta?: M365MessageListItem,
): Promise<InboundMessageParsed | null> {
  const url = `${GRAPH_BASE}/me/messages/${messageId}?$select=id,conversationId,subject,from,toRecipients,receivedDateTime,bodyPreview,body`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      Prefer: "outlook.body-content-type=text",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Graph get message 失败: ${res.status} ${t}`);
  }
  const m = (await res.json()) as {
    id?: string;
    conversationId?: string;
    subject?: string;
    from?: { emailAddress?: { address?: string } };
    toRecipients?: Array<{ emailAddress?: { address?: string } }>;
    receivedDateTime?: string;
    bodyPreview?: string;
    body?: { contentType?: string; content?: string };
  };
  const fromAddr = m.from?.emailAddress?.address ?? listMeta?.from ?? "";
  const toAddr = (m.toRecipients?.[0]?.emailAddress?.address ?? listMeta?.toRecipients?.[0]?.emailAddress?.address ?? "").trim();
  const subject = (m.subject ?? listMeta?.subject ?? "").trim();
  const bodyContent = m.body?.content ?? "";
  const contentType = (m.body?.contentType ?? "").toLowerCase();
  let bodyPlain = bodyContent;
  if (contentType === "html") {
    bodyPlain = bodyContent
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<p[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }
  if (bodyPlain.length > bodyPlainMaxChars) {
    const head = Math.floor(bodyPlainMaxChars * 0.6);
    const tail = bodyPlainMaxChars - head - 50;
    bodyPlain = bodyPlain.slice(0, head) + "\n\n... [truncated] ...\n\n" + bodyPlain.slice(-tail);
  }
  const snippet = (m.bodyPreview ?? listMeta?.bodyPreview ?? bodyPlain.slice(0, 200)).trim();
  const receivedAt = m.receivedDateTime ? new Date(m.receivedDateTime) : new Date();
  const fromL = fromAddr.toLowerCase();
  const isMailerDaemonOrPostmaster =
    fromL.includes("mailer-daemon") || fromL.includes("postmaster");
  const flags: InboundMessageFlags = {
    has_x_auto_response_suppress: false,
    precedence_bulk_or_list: false,
  };
  return {
    gmail_message_id: String(m.id ?? messageId),
    thread_id: String(m.conversationId ?? listMeta?.threadId ?? messageId),
    from_email: fromAddr.trim(),
    to_email: toAddr,
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
