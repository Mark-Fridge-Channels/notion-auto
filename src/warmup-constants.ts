export const WARMUP_STATUS_PENDING = "Pending";
export const WARMUP_STATUS_SENT = "Sent";
export const WARMUP_STATUS_FAILED = "Failed";
export const WARMUP_STATUS_CANCELLED = "Cancelled";

export const WARMUP_AUDIT_KEEP = "Keep";
export const WARMUP_AUDIT_CANCEL = "Cancel";
export const WARMUP_AUDIT_MANUAL_REVIEW = "Manual Review";

export const WARMUP_PLATFORM_EMAIL = "Email";
export const WARMUP_TASK_TYPE = "warmup";
export const WARMUP_LEGACY_TASK_TYPE = "Warmup";

export const WARMUP_CREDENTIAL_STATUS_VALID = "valid";

export type WarmupPlannedEventType =
  | "Send"
  | "Open"
  | "Reply"
  | "Star"
  | "Add Contact"
  | "Wait";

export type WarmupExecutionEventType =
  | "sent"
  | "opened"
  | "replied"
  | "starred"
  | "contact_added";

export type WarmupConversationEventType =
  | "Sent"
  | "Opened"
  | "Replied"
  | "Starred"
  | "Contact added";

export type WarmupDirection = "Outbound" | "Inbound" | "Passive Interaction";

export interface WarmupEventMapping {
  executionEventType: WarmupExecutionEventType | null;
  conversationEventType: WarmupConversationEventType | null;
  direction: WarmupDirection;
  actionType: string | null;
}

export function getWarmupEventMapping(plannedEventType: WarmupPlannedEventType): WarmupEventMapping {
  switch (plannedEventType) {
    case "Send":
      return {
        executionEventType: "sent",
        conversationEventType: "Sent",
        direction: "Outbound",
        actionType: "Email Send",
      };
    case "Reply":
      return {
        executionEventType: "replied",
        conversationEventType: "Replied",
        direction: "Outbound",
        actionType: "Email Reply Handling",
      };
    case "Open":
      return {
        executionEventType: "opened",
        conversationEventType: "Opened",
        direction: "Passive Interaction",
        actionType: "Email Open",
      };
    case "Star":
      return {
        executionEventType: "starred",
        conversationEventType: "Starred",
        direction: "Passive Interaction",
        actionType: "Email Star",
      };
    case "Add Contact":
      return {
        executionEventType: "contact_added",
        conversationEventType: "Contact added",
        direction: "Passive Interaction",
        actionType: "Email Add Contact",
      };
    case "Wait":
      return {
        executionEventType: null,
        conversationEventType: null,
        direction: "Outbound",
        actionType: null,
      };
  }
}

export function isCredentialEligible(executorEnabled: boolean, credentialStatus: string): boolean {
  return executorEnabled && credentialStatus.trim().toLowerCase() === WARMUP_CREDENTIAL_STATUS_VALID;
}

export function buildDryRunExternalEventId(
  executorRunId: string,
  queueTaskId: string,
  eventType: string,
): string {
  return `dryrun:${executorRunId}:${queueTaskId}:${eventType}`;
}

export function buildDryRunMessageId(queueTaskId: string): string {
  return `dryrun-msg:${queueTaskId}`;
}

export function buildExecutionExternalEventId(
  executorRunId: string,
  queueTaskId: string,
  eventType: string,
): string {
  return `exec:${executorRunId}:${queueTaskId}:${eventType}`;
}

export function buildSyntheticMessageId(queueTaskId: string): string {
  return `exec-msg:${queueTaskId}`;
}

