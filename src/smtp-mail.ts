import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import type { WarmupCardDavConfig, WarmupImapConfig, WarmupSmtpConfig } from "./warmup-runtime.js";

export interface SmtpSendResult {
  messageId: string;
  threadId: string;
}

export interface ImapLookupInput {
  messageId: string;
  subject: string;
  counterpartyEmail: string;
  allowSubjectSearch: boolean;
  allowCounterpartySearch: boolean;
}

function normalizeHeaderMessageId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("<") ? trimmed : `<${trimmed}>`;
}

function formatFromHeader(config: WarmupSmtpConfig): string {
  return config.fromName
    ? `"${config.fromName.replace(/"/g, '\\"')}" <${config.fromEmail}>`
    : config.fromEmail;
}

function createTransport(config: WarmupSmtpConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
  });
}

export async function sendSmtpMessage(
  config: WarmupSmtpConfig,
  to: string,
  subject: string,
  htmlBody: string,
): Promise<SmtpSendResult> {
  const transporter = createTransport(config);
  const info = await transporter.sendMail({
    from: formatFromHeader(config),
    to,
    subject,
    html: htmlBody,
  });
  const messageId = info.messageId?.trim();
  if (!messageId) throw new Error("SMTP 发信未返回 messageId");
  return {
    messageId,
    threadId: messageId,
  };
}

export async function replyWithSmtpMessage(
  config: WarmupSmtpConfig,
  to: string,
  subject: string,
  htmlBody: string,
  replyToMessageId: string,
): Promise<SmtpSendResult> {
  const transporter = createTransport(config);
  const normalizedReplyTo = normalizeHeaderMessageId(replyToMessageId);
  const info = await transporter.sendMail({
    from: formatFromHeader(config),
    to,
    subject,
    html: htmlBody,
    inReplyTo: normalizedReplyTo,
    references: [normalizedReplyTo],
  });
  const messageId = info.messageId?.trim();
  if (!messageId) throw new Error("SMTP 回复未返回 messageId");
  return {
    messageId,
    threadId: normalizedReplyTo || messageId,
  };
}

async function withImapClient<T>(config: WarmupImapConfig, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.username,
      pass: config.password,
    },
  });
  await client.connect();
  try {
    await client.mailboxOpen(config.mailbox);
    return await fn(client);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function pickLatestUid(candidates: number[]): number | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => b - a)[0] ?? null;
}

function intersectUids(left: number[], right: number[]): number[] {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value));
}

function normalizeSearchResult(result: number[] | false): number[] {
  return Array.isArray(result) ? result : [];
}

async function locateImapUid(client: ImapFlow, lookup: ImapLookupInput): Promise<number | null> {
  const normalizedMessageId = normalizeHeaderMessageId(lookup.messageId);
  if (normalizedMessageId) {
    const byMessageId = normalizeSearchResult(
      await client.search({ header: { "message-id": normalizedMessageId } }),
    );
    const messageUid = pickLatestUid(byMessageId);
    if (messageUid != null) return messageUid;
  }

  const subjectMatches: number[] =
    lookup.allowSubjectSearch && lookup.subject.trim()
      ? normalizeSearchResult(await client.search({ subject: lookup.subject.trim() }))
      : [];
  const addressMatches: number[] =
    lookup.allowCounterpartySearch && lookup.counterpartyEmail.trim()
      ? [
          ...normalizeSearchResult(await client.search({ from: lookup.counterpartyEmail.trim() })),
          ...normalizeSearchResult(await client.search({ to: lookup.counterpartyEmail.trim() })),
        ]
      : [];

  if (subjectMatches.length > 0 && addressMatches.length > 0) {
    const intersection = intersectUids(subjectMatches, addressMatches);
    const uid = pickLatestUid(intersection);
    if (uid != null) return uid;
  }

  return pickLatestUid(subjectMatches) ?? pickLatestUid(addressMatches);
}

export async function markImapMessageRead(
  config: WarmupImapConfig,
  lookup: ImapLookupInput,
): Promise<string> {
  return withImapClient(config, async (client) => {
    const uid = await locateImapUid(client, lookup);
    if (uid == null) throw new Error("IMAP 未找到目标邮件");
    await client.messageFlagsAdd(uid, ["\\Seen"]);
    return String(uid);
  });
}

export async function starImapMessage(
  config: WarmupImapConfig,
  lookup: ImapLookupInput,
): Promise<string> {
  return withImapClient(config, async (client) => {
    const uid = await locateImapUid(client, lookup);
    if (uid == null) throw new Error("IMAP 未找到目标邮件");
    await client.messageFlagsAdd(uid, [config.starFlag || "\\Flagged"]);
    return String(uid);
  });
}

function createCardDavAuthHeaders(config: WarmupCardDavConfig): HeadersInit {
  if (config.bearerToken) {
    return {
      Authorization: `Bearer ${config.bearerToken}`,
    };
  }
  if (config.username && config.password) {
    return {
      Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`,
    };
  }
  return {};
}

function buildVCard(email: string, displayName: string): string {
  const safeName = displayName.trim() || email.trim();
  const nameParts = safeName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] ?? safeName;
  const lastName = nameParts.slice(1).join(" ");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${safeName}`,
    `N:${lastName};${firstName};;;`,
    `EMAIL;TYPE=INTERNET:${email.trim()}`,
    "END:VCARD",
    "",
  ].join("\r\n");
}

export async function createCardDavContact(
  config: WarmupCardDavConfig,
  email: string,
  displayName: string,
): Promise<string> {
  const baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`;
  const resourcePath = `${baseUrl}${randomUUID()}.vcf`;
  const response = await fetch(resourcePath, {
    method: "PUT",
    headers: {
      "Content-Type": "text/vcard; charset=utf-8",
      ...createCardDavAuthHeaders(config),
    },
    body: buildVCard(email, displayName),
  });
  if (!response.ok && response.status !== 201 && response.status !== 204) {
    const text = await response.text();
    throw new Error(`CardDAV 创建联系人失败: ${response.status} ${text}`);
  }
  return response.headers.get("Location")?.trim() || resourcePath;
}

