import type { WarmupCredentialRecord } from "./notion-warmup.js";

export type WarmupProviderKey = "Gmail" | "Zoho" | "Microsoft 365" | "SMTP" | "MailAutomationAgent";

export interface WarmupSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
}

export interface WarmupImapConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  mailbox: string;
  starFlag: string;
}

export interface WarmupCardDavConfig {
  baseUrl: string;
  username: string;
  password: string;
  bearerToken: string;
}

export interface WarmupMessageLookupConfig {
  useReplyToMessageId: boolean;
  useThreadId: boolean;
  fallbackToSubjectSearch: boolean;
  fallbackToCounterpartySearch: boolean;
}

export interface WarmupAuthConfig {
  raw: Record<string, unknown>;
  providerHint: string;
  smtp: WarmupSmtpConfig | null;
  imap: WarmupImapConfig | null;
  cardDav: WarmupCardDavConfig | null;
  lookup: WarmupMessageLookupConfig;
}

export interface WarmupRuntimeCredential {
  provider: WarmupProviderKey | null;
  providerLabel: string;
  mailboxAddress: string;
  displayName: string;
  password: string;
  refreshToken: string;
  accessToken: string;
  authType: string;
  authConfig: WarmupAuthConfig;
  raw: WarmupCredentialRecord;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return fallback;
}

function asInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function firstNonEmpty(...values: Array<unknown>): string {
  for (const value of values) {
    const text = asString(value);
    if (text) return text;
  }
  return "";
}

function parseAuthConfigJson(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return asObject(parsed) ?? {};
  } catch {
    return {};
  }
}

function normalizeProviderName(input: string): WarmupProviderKey | null {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "gmail" || normalized === "google" || normalized === "google workspace") return "Gmail";
  if (normalized === "zoho" || normalized === "zoho mail") return "Zoho";
  if (
    normalized === "m365" ||
    normalized === "microsoft365" ||
    normalized === "microsoft 365" ||
    normalized === "office365" ||
    normalized === "office 365" ||
    normalized === "outlook"
  ) {
    return "Microsoft 365";
  }
  if (normalized === "smtp" || normalized === "imap" || normalized === "smtp+imap") return "SMTP";
  return null;
}

function buildSmtpConfig(record: WarmupCredentialRecord, root: Record<string, unknown>): WarmupSmtpConfig | null {
  const smtpRaw = asObject(root.smtp) ?? {};
  const host = firstNonEmpty(smtpRaw.host, root.smtp_host);
  if (!host) return null;
  const username = firstNonEmpty(smtpRaw.username, smtpRaw.user, record.loginUsername, record.account, record.mailboxId);
  const password = firstNonEmpty(smtpRaw.password, record.password);
  return {
    host,
    port: asInteger(smtpRaw.port, 587),
    secure: asBoolean(smtpRaw.secure, false),
    username,
    password,
    fromEmail: firstNonEmpty(smtpRaw.fromEmail, smtpRaw.from_email, record.account, record.mailboxId, username),
    fromName: firstNonEmpty(smtpRaw.fromName, smtpRaw.from_name),
  };
}

function buildImapConfig(record: WarmupCredentialRecord, root: Record<string, unknown>): WarmupImapConfig | null {
  const imapRaw = asObject(root.imap) ?? {};
  const host = firstNonEmpty(imapRaw.host);
  if (!host) return null;
  return {
    host,
    port: asInteger(imapRaw.port, 993),
    secure: asBoolean(imapRaw.secure, true),
    username: firstNonEmpty(imapRaw.username, imapRaw.user, record.loginUsername, record.account, record.mailboxId),
    password: firstNonEmpty(imapRaw.password, record.password),
    mailbox: firstNonEmpty(imapRaw.mailbox, "INBOX"),
    starFlag: firstNonEmpty(imapRaw.starFlag, imapRaw.star_flag, "\\Flagged"),
  };
}

function buildCardDavConfig(root: Record<string, unknown>): WarmupCardDavConfig | null {
  const cardDavRaw = asObject(root.contacts) ?? asObject(root.carddav) ?? {};
  const type = firstNonEmpty(cardDavRaw.type, "carddav").toLowerCase();
  if (type !== "carddav") return null;
  const baseUrl = firstNonEmpty(cardDavRaw.baseUrl, cardDavRaw.base_url);
  if (!baseUrl) return null;
  return {
    baseUrl,
    username: firstNonEmpty(cardDavRaw.username, cardDavRaw.user),
    password: firstNonEmpty(cardDavRaw.password),
    bearerToken: firstNonEmpty(cardDavRaw.bearerToken, cardDavRaw.bearer_token),
  };
}

function buildLookupConfig(root: Record<string, unknown>): WarmupMessageLookupConfig {
  const lookupRaw = asObject(root.messageLookup) ?? asObject(root.lookup) ?? {};
  return {
    useReplyToMessageId: asBoolean(lookupRaw.useReplyToMessageId, true),
    useThreadId: asBoolean(lookupRaw.useThreadId, true),
    fallbackToSubjectSearch: asBoolean(lookupRaw.fallbackToSubjectSearch, true),
    fallbackToCounterpartySearch: asBoolean(lookupRaw.fallbackToCounterpartySearch, true),
  };
}

export function parseWarmupAuthConfig(record: WarmupCredentialRecord): WarmupAuthConfig {
  const root = parseAuthConfigJson(record.authConfigJson);
  return {
    raw: root,
    providerHint: firstNonEmpty(root.provider, root.providerName, root.provider_name),
    smtp: buildSmtpConfig(record, root),
    imap: buildImapConfig(record, root),
    cardDav: buildCardDavConfig(root),
    lookup: buildLookupConfig(root),
  };
}

export function buildWarmupRuntimeCredential(record: WarmupCredentialRecord): WarmupRuntimeCredential {
  const authConfig = parseWarmupAuthConfig(record);
  const provider = normalizeProviderName(firstNonEmpty(record.platform, authConfig.providerHint, record.authType));
  const mailboxAddress = firstNonEmpty(record.account, record.mailboxId, record.loginUsername, authConfig.smtp?.fromEmail);
  return {
    provider,
    providerLabel: firstNonEmpty(record.platform, authConfig.providerHint, record.authType),
    mailboxAddress,
    displayName: firstNonEmpty(record.account, record.mailboxId, record.loginUsername, authConfig.smtp?.fromName),
    password: record.password,
    refreshToken: record.refreshToken,
    accessToken: record.accessToken,
    authType: record.authType,
    authConfig,
    raw: record,
  };
}

