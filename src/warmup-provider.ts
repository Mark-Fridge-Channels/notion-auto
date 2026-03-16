/**
 * Warmup Provider：Warmup Executor 执行邮件操作的适配层。
 * 当前仅支持 Mail Automation Agent（minimal-server），所有动作通过 POST /command 调用 Thunderbird 扩展。
 */

import type { WarmupCredentialRecord, WarmupQueueItem } from "./notion-warmup.js";
import type { WarmupPlannedEventType } from "./warmup-constants.js";
import { command } from "./mail-automation-agent-client.js";
import { buildWarmupRuntimeCredential, type WarmupProviderKey, type WarmupRuntimeCredential } from "./warmup-runtime.js";

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
  /** Mail Automation Agent Add Contact 使用的默认通讯录 ID；env 或 queue-sender.json entry 传入 */
  defaultAddressBookId?: string;
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

const FOLDER_INBOX = "INBOX";

/** 将扩展返回的 error.code 映射为 queue-sender failItem 使用的 reason 字符串 */
function mapAgentErrorToReason(code: string): string {
  switch (code) {
    case "TIMEOUT":
      return "timeout";
    case "CONTEXT_NOT_SET":
      return "credential_not_found";
    case "NOT_FOUND":
      return "not_found";
    case "VALIDATION":
    case "API_ERROR":
    default:
      return "api_error";
  }
}

/** 封装 command 调用，失败时抛出带 reason 的 Error 供 queue-sender 捕获并 failItem */
async function runCommand<T>(
  action: string,
  payload: Record<string, unknown>,
  options?: { idempotencyKey?: string },
): Promise<{ success: true; data: T }> {
  try {
    const res = await command<T>(action, payload, options);
    if (!res.success || res.result === undefined) {
      const code = res.error?.code ?? "API_ERROR";
      throw new Error(`${mapAgentErrorToReason(code)}: ${res.error?.message ?? "unknown"}`);
    }
    return { success: true, data: res.result };
  } catch (e) {
    if (e instanceof Error) {
      const msg = e.message;
      if (msg.includes("credential_not_found") || msg.includes("timeout") || msg.includes("not_found") || msg.includes("api_error")) {
        throw e;
      }
      if (msg.includes("超时") || e.name === "AbortError") throw new Error(`timeout: ${e.message}`);
      if (msg.includes("Mail Automation Agent")) {
        const code = msg.includes("CONTEXT_NOT_SET") ? "credential_not_found" : msg.includes("NOT_FOUND") ? "not_found" : msg.includes("TIMEOUT") ? "timeout" : "api_error";
        throw new Error(`${code}: ${e.message}`);
      }
    }
    throw e;
  }
}

interface SwitchAccountResult {
  accountId: string;
  identityId?: string;
  accountName?: string;
  identityEmail?: string;
  folders?: Array<{ id: string; path: string; name: string }>;
}

class MailAutomationAgentAdapter implements WarmupProviderAdapter {
  provider: WarmupSupportedProvider = "MailAutomationAgent";

  supports(eventType: WarmupPlannedEventType): boolean {
    return eventType === "Send" || eventType === "Reply" || eventType === "Open" || eventType === "Star" || eventType === "Add Contact" || eventType === "Wait";
  }

  async execute(context: WarmupProviderExecutionContext): Promise<WarmupActionExecutionResult> {
    const { item, credential } = context;
    const email = getActorMailbox(item, context.runtime);
    const to = getCounterpartyMailbox(item);

    const switchRes = await runCommand<SwitchAccountResult>("switch_account_context", { email });
    const accountId = switchRes.data.accountId;

    switch (item.plannedEventType) {
      case "Send": {
        const res = await runCommand<{ headerMessageId?: string; stableIdentifiers?: unknown }>(
          "send_email",
          {
            to,
            subject: item.subject,
            plainTextBody: item.body,
            isPlainText: true,
          },
        );
        const headerMessageId = res.data.headerMessageId ?? "";
        return {
          provider: this.provider,
          eventType: "Send",
          messageId: headerMessageId,
          threadId: headerMessageId,
          metadata: { mode: "mail_automation_agent_send", stableIdentifiers: res.data.stableIdentifiers },
        };
      }
      case "Reply": {
        const headerMessageId = item.replyToMessageId.trim();
        const res = await runCommand<{ messageId?: string; headerMessageId?: string; replyResult?: unknown; stableIdentifiers?: unknown }>(
          "reply_message",
          {
            accountId,
            headerMessageId,
            folderPath: FOLDER_INBOX,
            plainTextBody: item.body,
            isPlainText: true,
          },
          { idempotencyKey: `reply-${headerMessageId}` },
        );
        const mid = res.data.headerMessageId ?? res.data.messageId ?? "";
        return {
          provider: this.provider,
          eventType: "Reply",
          messageId: mid,
          threadId: mid,
          metadata: { mode: "mail_automation_agent_reply", replyResult: res.data.replyResult, stableIdentifiers: res.data.stableIdentifiers },
        };
      }
      case "Open": {
        if (!item.replyToMessageId.trim() && !item.subject.trim()) {
          throw new Error("api_error: Open 需要 reply_to_message_id 或 subject");
        }
        const payload: Record<string, unknown> = {
          accountId,
          folderPath: FOLDER_INBOX,
        };
        if (item.replyToMessageId.trim()) {
          payload.headerMessageId = item.replyToMessageId.trim();
        } else {
          payload.subject = item.subject;
          if (to) payload.from = to;
        }
        const res = await runCommand<{ messageId?: string; tabId?: number; windowId?: number; stableIdentifiers?: { headerMessageId?: string } }>(
          "open_message",
          payload,
        );
        const mid = res.data.stableIdentifiers?.headerMessageId ?? res.data.messageId ?? "";
        return {
          provider: this.provider,
          eventType: "Open",
          messageId: mid,
          threadId: item.threadId.trim() || mid,
          metadata: { mode: "mail_automation_agent_open", tabId: res.data.tabId, windowId: res.data.windowId },
        };
      }
      case "Star": {
        const payload: Record<string, unknown> = { accountId, starred: true };
        if (item.replyToMessageId.trim()) {
          payload.headerMessageId = item.replyToMessageId.trim();
        } else if (item.subject.trim()) {
          payload.folderPath = FOLDER_INBOX;
          payload.subject = item.subject;
        } else {
          throw new Error("api_error: Star 需要 reply_to_message_id 或 subject");
        }
        const res = await runCommand<{ messageId?: string; previousState?: unknown; newState?: unknown; stableIdentifiers?: unknown }>("star_message", payload);
        const mid = (res.data.stableIdentifiers as { headerMessageId?: string } | undefined)?.headerMessageId ?? res.data.messageId ?? "";
        return {
          provider: this.provider,
          eventType: "Star",
          messageId: mid,
          threadId: item.threadId.trim() || mid,
          metadata: { mode: "mail_automation_agent_star", previousState: res.data.previousState, newState: res.data.newState },
        };
      }
      case "Add Contact": {
        const parentId = context.defaultAddressBookId?.trim();
        if (!parentId) throw new Error("api_error: Add Contact 需要配置 defaultAddressBookId（env 或 queue-sender.json）");
        const res = await runCommand<{ contactId?: string; parentId?: string; duplicate?: boolean; stableIdentifiers?: unknown }>("add_contact", {
          email: to,
          parentId,
          displayName: buildContactDisplayName(item),
        });
        return {
          provider: this.provider,
          eventType: "Add Contact",
          messageId: "",
          threadId: item.threadId.trim(),
          metadata: { mode: "mail_automation_agent_add_contact", contactId: res.data.contactId, duplicate: res.data.duplicate },
        };
      }
      case "Wait":
        return {
          provider: this.provider,
          eventType: "Wait",
          messageId: "",
          threadId: item.threadId.trim(),
          metadata: { mode: "noop" },
        };
    }
  }
}

const mailAutomationAgentAdapter = new MailAutomationAgentAdapter();

export function getWarmupActionDescriptor(eventType: WarmupPlannedEventType): WarmupActionDescriptor {
  return warmupActionRegistry[eventType];
}

/** 始终返回 Mail Automation Agent 适配器，不再按 platform 选择多平台。 */
export function getWarmupProviderAdapter(_provider?: WarmupProviderKey | null): WarmupProviderAdapter {
  return mailAutomationAgentAdapter;
}

export function createWarmupProviderExecutionContext(
  item: WarmupQueueItem,
  credential: WarmupCredentialRecord,
  options?: { defaultAddressBookId?: string },
): WarmupProviderExecutionContext {
  return {
    item,
    credential,
    runtime: buildWarmupRuntimeCredential(credential),
    defaultAddressBookId: options?.defaultAddressBookId,
  };
}
