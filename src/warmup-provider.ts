import type { WarmupCredentialRecord, WarmupQueueItem } from "./notion-warmup.js";
import type { WarmupPlannedEventType } from "./warmup-constants.js";
import { getGmailMessageMetadata } from "./gmail-read.js";
import {
  addGoogleContact,
  getGmailClient,
  getGooglePeopleClient,
  markGmailMessageRead,
  markGmailThreadRead,
  plainToHtml,
  sendCold1,
  sendFollowup,
  starGmailMessage,
  starGmailThread,
} from "./gmail-send.js";
import {
  addZohoContact,
  flagZohoThread,
  getZohoAccessToken,
  getZohoAccountId,
  markZohoMessageRead,
  markZohoThreadRead,
  sendZohoCold1,
  sendZohoReply,
} from "./zoho-mail.js";
import {
  addM365Contact,
  findLatestM365MessageIdByConversation,
  flagM365Message,
  getM365AccessToken,
  markM365MessageRead,
  sendM365Cold1,
  sendM365Reply,
} from "./m365-mail.js";
import {
  createCardDavContact,
  markImapMessageRead,
  replyWithSmtpMessage,
  sendSmtpMessage,
  starImapMessage,
} from "./smtp-mail.js";
import {
  buildWarmupRuntimeCredential,
  type WarmupProviderKey,
  type WarmupRuntimeCredential,
} from "./warmup-runtime.js";

export type WarmupSupportedProvider = WarmupProviderKey;

export interface WarmupActionDescriptor {
  eventType: WarmupPlannedEventType;
  requiresSubject: boolean;
  requiresBody: boolean;
  requiresReplyToMessageId: boolean;
}

export interface WarmupActionExecutionResult {
  provider: WarmupProviderKey;
  eventType: WarmupPlannedEventType;
  messageId: string;
  threadId: string;
  metadata: Record<string, unknown>;
}

export interface WarmupProviderExecutionContext {
  item: WarmupQueueItem;
  credential: WarmupCredentialRecord;
  runtime: WarmupRuntimeCredential;
}

export interface WarmupProviderAdapter {
  provider: WarmupSupportedProvider;
  supports(eventType: WarmupPlannedEventType): boolean;
  execute(context: WarmupProviderExecutionContext): Promise<WarmupActionExecutionResult>;
}

export const warmupActionRegistry: Record<WarmupPlannedEventType, WarmupActionDescriptor> = {
  Send: {
    eventType: "Send",
    requiresSubject: true,
    requiresBody: true,
    requiresReplyToMessageId: false,
  },
  Open: {
    eventType: "Open",
    requiresSubject: false,
    requiresBody: false,
    requiresReplyToMessageId: false,
  },
  Reply: {
    eventType: "Reply",
    requiresSubject: true,
    requiresBody: true,
    requiresReplyToMessageId: true,
  },
  Star: {
    eventType: "Star",
    requiresSubject: false,
    requiresBody: false,
    requiresReplyToMessageId: false,
  },
  "Add Contact": {
    eventType: "Add Contact",
    requiresSubject: false,
    requiresBody: false,
    requiresReplyToMessageId: false,
  },
  Wait: {
    eventType: "Wait",
    requiresSubject: false,
    requiresBody: false,
    requiresReplyToMessageId: false,
  },
};

function getActorMailbox(item: WarmupQueueItem, runtime: WarmupRuntimeCredential): string {
  return runtime.mailboxAddress || item.actorMailboxId || item.account;
}

function getCounterpartyMailbox(item: WarmupQueueItem): string {
  return item.counterpartyMailboxId || item.target;
}

function buildContactDisplayName(item: WarmupQueueItem): string {
  const candidate = getCounterpartyMailbox(item).split("@")[0]?.trim();
  return candidate || item.target || item.counterpartyMailboxId || "Warmup Contact";
}

function ensureRefreshToken(runtime: WarmupRuntimeCredential): string {
  const token = runtime.refreshToken.trim();
  if (!token) throw new Error(`${runtime.providerLabel || runtime.provider || "provider"} 缺少 refresh_token`);
  return token;
}

function ensureMessageIdOrThread(item: WarmupQueueItem): void {
  if (!item.replyToMessageId.trim() && !item.threadId.trim()) {
    throw new Error(`${item.plannedEventType} 缺少 reply_to_message_id 或 thread_id`);
  }
}

class GmailAdapter implements WarmupProviderAdapter {
  provider: WarmupSupportedProvider = "Gmail";

  supports(_eventType: WarmupPlannedEventType): boolean {
    return true;
  }

  async execute(context: WarmupProviderExecutionContext): Promise<WarmupActionExecutionResult> {
    const refreshToken = ensureRefreshToken(context.runtime);
    const { gmail, userId } = getGmailClient(refreshToken);
    const from = getActorMailbox(context.item, context.runtime);
    const to = getCounterpartyMailbox(context.item);
    const htmlBody = plainToHtml(context.item.body);
    switch (context.item.plannedEventType) {
      case "Send": {
        const result = await sendCold1(gmail, userId, from, to, context.item.subject, htmlBody);
        return { provider: this.provider, eventType: "Send", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "gmail_send" } };
      }
      case "Reply": {
        const metadata = context.item.replyToMessageId.trim()
          ? await getGmailMessageMetadata(gmail, userId, context.item.replyToMessageId.trim())
          : null;
        const threadId = context.item.threadId.trim() || metadata?.threadId || "";
        if (!threadId) throw new Error("Gmail Reply 缺少 thread_id");
        const result = await sendFollowup(
          gmail,
          userId,
          threadId,
          context.item.replyToMessageId.trim(),
          from,
          to,
          context.item.subject,
          htmlBody,
        );
        return { provider: this.provider, eventType: "Reply", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "gmail_reply" } };
      }
      case "Open": {
        ensureMessageIdOrThread(context.item);
        if (context.item.replyToMessageId.trim()) {
          await markGmailMessageRead(gmail, userId, context.item.replyToMessageId.trim());
          const metadata = await getGmailMessageMetadata(gmail, userId, context.item.replyToMessageId.trim());
          return {
            provider: this.provider,
            eventType: "Open",
            messageId: context.item.replyToMessageId.trim(),
            threadId: metadata?.threadId || context.item.threadId.trim() || context.item.replyToMessageId.trim(),
            metadata: { mode: "gmail_message_read" },
          };
        }
        await markGmailThreadRead(gmail, userId, context.item.threadId.trim());
        return {
          provider: this.provider,
          eventType: "Open",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "gmail_thread_read" },
        };
      }
      case "Star": {
        ensureMessageIdOrThread(context.item);
        if (context.item.replyToMessageId.trim()) {
          await starGmailMessage(gmail, userId, context.item.replyToMessageId.trim());
          const metadata = await getGmailMessageMetadata(gmail, userId, context.item.replyToMessageId.trim());
          return {
            provider: this.provider,
            eventType: "Star",
            messageId: context.item.replyToMessageId.trim(),
            threadId: metadata?.threadId || context.item.threadId.trim() || context.item.replyToMessageId.trim(),
            metadata: { mode: "gmail_message_star" },
          };
        }
        await starGmailThread(gmail, userId, context.item.threadId.trim());
        return {
          provider: this.provider,
          eventType: "Star",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "gmail_thread_star" },
        };
      }
      case "Add Contact": {
        const people = getGooglePeopleClient(refreshToken);
        const contactId = await addGoogleContact(people, to, buildContactDisplayName(context.item));
        return {
          provider: this.provider,
          eventType: "Add Contact",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "google_people_contact", contactId },
        };
      }
      case "Wait":
        return {
          provider: this.provider,
          eventType: "Wait",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "noop" },
        };
    }
  }
}

class ZohoAdapter implements WarmupProviderAdapter {
  provider: WarmupSupportedProvider = "Zoho";

  supports(_eventType: WarmupPlannedEventType): boolean {
    return true;
  }

  async execute(context: WarmupProviderExecutionContext): Promise<WarmupActionExecutionResult> {
    const accessToken = await getZohoAccessToken(ensureRefreshToken(context.runtime));
    const accountId = await getZohoAccountId(accessToken);
    const from = getActorMailbox(context.item, context.runtime);
    const to = getCounterpartyMailbox(context.item);
    const htmlBody = plainToHtml(context.item.body);
    switch (context.item.plannedEventType) {
      case "Send": {
        const result = await sendZohoCold1(accessToken, accountId, from, to, context.item.subject, htmlBody);
        return { provider: this.provider, eventType: "Send", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "zoho_send", accountId } };
      }
      case "Reply": {
        const result = await sendZohoReply(
          accessToken,
          accountId,
          context.item.replyToMessageId.trim(),
          from,
          to,
          context.item.subject,
          htmlBody,
        );
        return { provider: this.provider, eventType: "Reply", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "zoho_reply", accountId } };
      }
      case "Open": {
        ensureMessageIdOrThread(context.item);
        if (context.item.replyToMessageId.trim()) {
          await markZohoMessageRead(accessToken, accountId, context.item.replyToMessageId.trim());
          return {
            provider: this.provider,
            eventType: "Open",
            messageId: context.item.replyToMessageId.trim(),
            threadId: context.item.threadId.trim() || context.item.replyToMessageId.trim(),
            metadata: { mode: "zoho_message_read", accountId },
          };
        }
        await markZohoThreadRead(accessToken, accountId, context.item.threadId.trim());
        return {
          provider: this.provider,
          eventType: "Open",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "zoho_thread_read", accountId },
        };
      }
      case "Star": {
        ensureMessageIdOrThread(context.item);
        const threadId = context.item.threadId.trim() || context.item.replyToMessageId.trim();
        await flagZohoThread(accessToken, accountId, threadId);
        return {
          provider: this.provider,
          eventType: "Star",
          messageId: context.item.replyToMessageId.trim(),
          threadId,
          metadata: { mode: "zoho_thread_flag", accountId, flagId: "2" },
        };
      }
      case "Add Contact": {
        const contactId = await addZohoContact(accessToken, to, buildContactDisplayName(context.item));
        return {
          provider: this.provider,
          eventType: "Add Contact",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "zoho_contact_create", accountId, contactId },
        };
      }
      case "Wait":
        return {
          provider: this.provider,
          eventType: "Wait",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "noop", accountId },
        };
    }
  }
}

class M365Adapter implements WarmupProviderAdapter {
  provider: WarmupSupportedProvider = "Microsoft 365";

  supports(_eventType: WarmupPlannedEventType): boolean {
    return true;
  }

  async execute(context: WarmupProviderExecutionContext): Promise<WarmupActionExecutionResult> {
    const accessToken = await getM365AccessToken(ensureRefreshToken(context.runtime));
    const from = getActorMailbox(context.item, context.runtime);
    const to = getCounterpartyMailbox(context.item);
    const htmlBody = plainToHtml(context.item.body);
    switch (context.item.plannedEventType) {
      case "Send": {
        const result = await sendM365Cold1(accessToken, from, to, context.item.subject, htmlBody);
        return { provider: this.provider, eventType: "Send", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "m365_send" } };
      }
      case "Reply": {
        const result = await sendM365Reply(accessToken, context.item.replyToMessageId.trim(), htmlBody);
        return { provider: this.provider, eventType: "Reply", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "m365_reply" } };
      }
      case "Open": {
        ensureMessageIdOrThread(context.item);
        const messageId = context.item.replyToMessageId.trim()
          || (context.item.threadId.trim() ? await findLatestM365MessageIdByConversation(accessToken, context.item.threadId.trim()) || "" : "");
        if (!messageId) throw new Error("Microsoft 365 Open 无法定位 message_id");
        await markM365MessageRead(accessToken, messageId);
        return {
          provider: this.provider,
          eventType: "Open",
          messageId,
          threadId: context.item.threadId.trim() || messageId,
          metadata: { mode: "m365_message_read" },
        };
      }
      case "Star": {
        ensureMessageIdOrThread(context.item);
        const messageId = context.item.replyToMessageId.trim()
          || (context.item.threadId.trim() ? await findLatestM365MessageIdByConversation(accessToken, context.item.threadId.trim()) || "" : "");
        if (!messageId) throw new Error("Microsoft 365 Star 无法定位 message_id");
        await flagM365Message(accessToken, messageId);
        return {
          provider: this.provider,
          eventType: "Star",
          messageId,
          threadId: context.item.threadId.trim() || messageId,
          metadata: { mode: "m365_message_flagged" },
        };
      }
      case "Add Contact": {
        const contactId = await addM365Contact(accessToken, to, buildContactDisplayName(context.item));
        return {
          provider: this.provider,
          eventType: "Add Contact",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "m365_contact_create", contactId },
        };
      }
      case "Wait":
        return {
          provider: this.provider,
          eventType: "Wait",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "noop" },
        };
    }
  }
}

class SmtpAdapter implements WarmupProviderAdapter {
  provider: WarmupSupportedProvider = "SMTP";

  supports(_eventType: WarmupPlannedEventType): boolean {
    return true;
  }

  async execute(context: WarmupProviderExecutionContext): Promise<WarmupActionExecutionResult> {
    const smtp = context.runtime.authConfig.smtp;
    if (!smtp) throw new Error("SMTP provider 缺少 auth_config_json.smtp 配置");
    const to = getCounterpartyMailbox(context.item);
    const htmlBody = plainToHtml(context.item.body);
    switch (context.item.plannedEventType) {
      case "Send": {
        const result = await sendSmtpMessage(smtp, to, context.item.subject, htmlBody);
        return { provider: this.provider, eventType: "Send", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "smtp_send", host: smtp.host } };
      }
      case "Reply": {
        const result = await replyWithSmtpMessage(
          smtp,
          to,
          context.item.subject,
          htmlBody,
          context.item.replyToMessageId.trim(),
        );
        return { provider: this.provider, eventType: "Reply", messageId: result.messageId, threadId: result.threadId, metadata: { mode: "smtp_reply", host: smtp.host } };
      }
      case "Open": {
        const imap = context.runtime.authConfig.imap;
        if (!imap) throw new Error("SMTP Open 缺少 auth_config_json.imap 配置");
        const uid = await markImapMessageRead(imap, {
          messageId: context.item.replyToMessageId.trim(),
          subject: context.item.subject.trim(),
          counterpartyEmail: to,
          allowSubjectSearch: context.runtime.authConfig.lookup.fallbackToSubjectSearch,
          allowCounterpartySearch: context.runtime.authConfig.lookup.fallbackToCounterpartySearch,
        });
        return {
          provider: this.provider,
          eventType: "Open",
          messageId: context.item.replyToMessageId.trim(),
          threadId: context.item.threadId.trim() || uid,
          metadata: { mode: "imap_seen", uid, mailbox: imap.mailbox },
        };
      }
      case "Star": {
        const imap = context.runtime.authConfig.imap;
        if (!imap) throw new Error("SMTP Star 缺少 auth_config_json.imap 配置");
        const uid = await starImapMessage(imap, {
          messageId: context.item.replyToMessageId.trim(),
          subject: context.item.subject.trim(),
          counterpartyEmail: to,
          allowSubjectSearch: context.runtime.authConfig.lookup.fallbackToSubjectSearch,
          allowCounterpartySearch: context.runtime.authConfig.lookup.fallbackToCounterpartySearch,
        });
        return {
          provider: this.provider,
          eventType: "Star",
          messageId: context.item.replyToMessageId.trim(),
          threadId: context.item.threadId.trim() || uid,
          metadata: { mode: "imap_flagged", uid, mailbox: imap.mailbox, flag: imap.starFlag },
        };
      }
      case "Add Contact": {
        const cardDav = context.runtime.authConfig.cardDav;
        if (!cardDav) throw new Error("SMTP Add Contact 缺少 auth_config_json.contacts/carddav 配置");
        const location = await createCardDavContact(cardDav, to, buildContactDisplayName(context.item));
        return {
          provider: this.provider,
          eventType: "Add Contact",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "carddav_contact_create", location },
        };
      }
      case "Wait":
        return {
          provider: this.provider,
          eventType: "Wait",
          messageId: "",
          threadId: context.item.threadId.trim(),
          metadata: { mode: "noop", host: smtp.host },
        };
    }
  }
}

export const warmupProviderAdapters: WarmupProviderAdapter[] = [
  new GmailAdapter(),
  new ZohoAdapter(),
  new M365Adapter(),
  new SmtpAdapter(),
];

export function getWarmupActionDescriptor(eventType: WarmupPlannedEventType): WarmupActionDescriptor {
  return warmupActionRegistry[eventType];
}

export function getWarmupProviderAdapter(provider: WarmupProviderKey | null): WarmupProviderAdapter | null {
  if (!provider) return null;
  return warmupProviderAdapters.find((adapter) => adapter.provider === provider) ?? null;
}

export function createWarmupProviderExecutionContext(
  item: WarmupQueueItem,
  credential: WarmupCredentialRecord,
): WarmupProviderExecutionContext {
  return {
    item,
    credential,
    runtime: buildWarmupRuntimeCredential(credential),
  };
}

