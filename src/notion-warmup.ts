import type { Client } from "@notionhq/client";
import { logger } from "./logger.js";
import {
  WARMUP_AUDIT_KEEP,
  WARMUP_CREDENTIAL_STATUS_VALID,
  WARMUP_PLATFORM_EMAIL,
  WARMUP_STATUS_CANCELLED,
  WARMUP_STATUS_FAILED,
  WARMUP_STATUS_PENDING,
  WARMUP_STATUS_SENT,
  type WarmupConversationEventType,
  type WarmupDirection,
  type WarmupExecutionEventType,
  type WarmupPlannedEventType,
} from "./warmup-constants.js";

type NotionQueryResponse = Awaited<ReturnType<Client["databases"]["query"]>>;
type NotionUpdateProps = Parameters<Client["pages"]["update"]>[0]["properties"];
type NotionCreateProps = Parameters<Client["pages"]["create"]>[0]["properties"];

export interface WarmupQueueItem {
  pageId: string;
  queueItem: string;
  taskId: string;
  account: string;
  target: string;
  actorMailboxId: string;
  counterpartyMailboxId: string;
  threadId: string;
  relationshipId: string;
  plannedEventType: WarmupPlannedEventType;
  plannedAction: string;
  roleInChain: string;
  dependsOnTaskId: string;
  executeWindowStart: Date | null;
  executeWindowEnd: Date | null;
  status: string;
  auditDecision: string;
  auditReason: string;
  auditRunId: string;
  auditedAt: Date | null;
  currentStep: string;
  nextStepRule: string;
  chainPlanJson: string;
  requiredInteractionsJson: string;
  timeoutRuleJson: string;
  contentTemplateRef: string;
  evidenceRequirement: string;
  executorRunId: string;
  lastExecutorSyncAt: Date | null;
  legacyTaskType: string;
  platformLegacy: string;
  subject: string;
  body: string;
  replyToMessageId: string;
}

export interface WarmupCredentialRecord {
  pageId: string;
  mailboxId: string;
  account: string;
  loginUsername: string;
  password: string;
  refreshToken: string;
  accessToken: string;
  secretRef: string;
  authConfigJson: string;
  sessionRef: string;
  platform: string;
  authType: string;
  credentialStatus: string;
  executorEnabled: boolean;
  bandwidthDetailPageId: string | null;
  warmupMailboxPoolPageId: string | null;
}

export interface WarmupBandwidthRecord {
  pageId: string;
  account: string;
  platform: string;
  actionType: string;
  allowed: boolean;
  riskState: string;
  readinessStatus: string;
  cooldownUntil: Date | null;
  policyVersion: string;
  strategyVersion: string;
}

export interface WarmupExecutionLogPayload {
  name: string;
  accountId: string;
  actionType: string;
  eventType: WarmupExecutionEventType;
  result: "success" | "failed";
  queueTaskId: string;
  taskId: string;
  relationshipId: string;
  threadId: string;
  actorMailboxId: string;
  counterpartyMailboxId: string;
  direction: WarmupDirection;
  executeTime: Date;
  externalEventId: string;
  messageId?: string;
  contentExcerpt: string;
  eventMetadataJson: string;
  anomalyType?: string;
  policyVersion?: string;
  strategyVersion?: string;
}

export interface WarmupConversationLogPayload {
  eventTitle: string;
  observedAt: Date;
  eventType: WarmupConversationEventType;
  direction: WarmupDirection;
  relationshipId: string;
  threadId: string;
  actorMailboxId: string;
  counterpartyMailboxId: string;
  queueTaskId: string;
  externalEventId: string;
  eventMetadataJson: string;
  contentExcerpt: string;
}

export interface WarmupQueueUpdatePayload {
  status: typeof WARMUP_STATUS_PENDING | typeof WARMUP_STATUS_SENT | typeof WARMUP_STATUS_FAILED | typeof WARMUP_STATUS_CANCELLED;
  currentStep: string;
  nextStepRule: string;
  executorRunId: string;
  lastExecutorSyncAt: Date;
}

interface QueryQueueOptions {
  now: Date;
  batchSize: number;
}

interface QueryDependencyResult {
  found: boolean;
  status: string;
}

export function parseDatabaseId(url: string): string {
  const s = (url || "").trim();
  const dbMatch = s.match(/[?&]db=([a-f0-9-]{32,36})/i);
  if (dbMatch) return dbMatch[1].replace(/-/g, "");
  const pathMatch = s.match(/([a-f0-9]{32})/i);
  if (pathMatch) return pathMatch[1];
  throw new Error(`无法从 URL 解析 database_id: ${url}`);
}

function toNotionDbId(databaseIdOrUrl: string): string {
  const databaseId = parseDatabaseId(databaseIdOrUrl);
  return databaseId.length === 32
    ? `${databaseId.slice(0, 8)}-${databaseId.slice(8, 12)}-${databaseId.slice(12, 16)}-${databaseId.slice(16, 20)}-${databaseId.slice(20, 32)}`
    : databaseId;
}

function getPlainText(prop: unknown): string {
  if (prop && typeof prop === "object") {
    if ("title" in prop) {
      const arr = (prop as { title?: Array<{ plain_text?: string }> }).title;
      if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("").trim();
    }
    if ("rich_text" in prop) {
      const arr = (prop as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
      if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("").trim();
    }
  }
  return "";
}

function getSelectName(prop: unknown): string {
  if (prop && typeof prop === "object" && "select" in prop) {
    return (prop as { select?: { name?: string } }).select?.name?.trim() ?? "";
  }
  if (prop && typeof prop === "object" && "status" in prop) {
    return (prop as { status?: { name?: string } }).status?.name?.trim() ?? "";
  }
  return getPlainText(prop);
}

function getCheckbox(prop: unknown): boolean {
  if (prop && typeof prop === "object" && "checkbox" in prop) {
    return Boolean((prop as { checkbox?: boolean }).checkbox);
  }
  return false;
}

function getNumber(prop: unknown): number | null {
  if (prop && typeof prop === "object" && "number" in prop) {
    const value = (prop as { number?: number | null }).number;
    return typeof value === "number" ? value : null;
  }
  return null;
}

function getDateStart(prop: unknown): Date | null {
  if (prop && typeof prop === "object" && "date" in prop) {
    const start = (prop as { date?: { start?: string } | null }).date?.start;
    if (!start) return null;
    return parseNotionDateValue(start);
  }
  return null;
}

function getDateRange(prop: unknown): { start: Date | null; end: Date | null } {
  if (prop && typeof prop === "object" && "date" in prop) {
    const date = (prop as { date?: { start?: string; end?: string } | null }).date;
    return {
      start: date?.start ? parseNotionDateValue(date.start) : null,
      end: date?.end ? parseNotionDateValue(date.end) : null,
    };
  }
  return { start: null, end: null };
}

function parseNotionDateValue(value: string): Date {
  const trimmed = value.trim();
  const hasTimeZone = /Z$|[+-]\d{2}:?\d{2}$/.test(trimmed);
  if (hasTimeZone) return new Date(trimmed);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) {
    const tz = process.env.EXECUTE_WINDOW_TZ?.trim() || "+08:00";
    return new Date(trimmed + tz);
  }
  return new Date(trimmed);
}

function getRelationIds(prop: unknown): string[] {
  if (prop && typeof prop === "object" && "relation" in prop) {
    const relation = (prop as { relation?: Array<{ id?: string }> }).relation;
    if (Array.isArray(relation)) {
      return relation.map((item) => item.id ?? "").filter(Boolean);
    }
  }
  return [];
}

function getDateTimeIso(value: Date): string {
  return value.toISOString();
}

function getRichTextContent(value: string) {
  return [{ type: "text" as const, text: { content: value.slice(0, 2000) } }];
}

function getTitleContent(value: string) {
  return [{ type: "text" as const, text: { content: value.slice(0, 2000) } }];
}

function isExecuteWindowActive(start: Date | null, end: Date | null, now: Date): boolean {
  if (start && end) return start.getTime() <= now.getTime() && now.getTime() <= end.getTime();
  if (start && !end) return now.getTime() >= start.getTime();
  return false;
}

/** Resolve property value by trying multiple keys (Notion API uses the UI column name as key, e.g. "Planned Event Type" or "planned_event_type"). */
function getProp(props: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(props, k) && props[k] != null) return props[k];
  }
  return undefined;
}

function parseQueueItem(page: { id: string; properties: Record<string, unknown> }): WarmupQueueItem | null {
  const props = page.properties;
  const eventType = (getSelectName(getProp(props, "planned_event_type", "Planned Event Type")) ||
    getSelectName(getProp(props, "planned_action", "Planned Action"))) as WarmupPlannedEventType;
  if (!eventType) return null;
  const executeWindow = getDateRange(props["Execute Window"]);
  const taskId = getPlainText(props["Task ID"]);
  return {
    pageId: page.id,
    queueItem: getPlainText(props["Queue Item"]),
    taskId,
    account: getPlainText(props["Account"]),
    target: getPlainText(props["Target"]),
    actorMailboxId: getPlainText(props["actor_mailbox_id"]) || getPlainText(props["Account"]),
    counterpartyMailboxId: getPlainText(props["counterparty_mailbox_id"]) || getPlainText(props["Target"]),
    threadId: getPlainText(props["thread_id"]),
    relationshipId: getPlainText(props["relationship_id"]),
    plannedEventType: eventType,
    plannedAction: getSelectName(getProp(props, "planned_action", "Planned Action")),
    roleInChain: getSelectName(props["role_in_chain"]),
    dependsOnTaskId: getPlainText(props["depends_on_task_id"]),
    executeWindowStart: executeWindow.start,
    executeWindowEnd: executeWindow.end,
    status: getSelectName(props["Status"]),
    auditDecision: getSelectName(props["audit_decision"]),
    auditReason: getPlainText(props["audit_reason"]),
    auditRunId: getPlainText(props["audit_run_id"]),
    auditedAt: getDateStart(props["audited_at"]),
    currentStep: getPlainText(props["current_step"]),
    nextStepRule: getPlainText(props["next_step_rule"]),
    chainPlanJson: getPlainText(props["chain_plan_json"]),
    requiredInteractionsJson: getPlainText(props["required_interactions_json"]),
    timeoutRuleJson: getPlainText(props["timeout_rule_json"]),
    contentTemplateRef: getPlainText(props["content_template_ref"]),
    evidenceRequirement: getPlainText(props["evidence_requirement"]),
    executorRunId: getPlainText(props["executor_run_id"]),
    lastExecutorSyncAt: getDateStart(props["last_executor_sync_at"]),
    legacyTaskType: getSelectName(props["Legacy Task Type"]) || getPlainText(props["Legacy Task Type"]),
    platformLegacy: getSelectName(props["Platform (Legacy)"]) || getPlainText(props["Platform (Legacy)"]),
    subject: getPlainText(props["subject"]),
    body: getPlainText(props["body"]),
    replyToMessageId: getPlainText(props["reply_to_message_id"]),
  };
}

export async function queryWarmupQueueCandidates(
  notion: Client,
  queueDatabaseUrl: string,
  options: QueryQueueOptions,
): Promise<WarmupQueueItem[]> {
  const response = await notion.databases.query({
    database_id: toNotionDbId(queueDatabaseUrl),
    sorts: [{ property: "Execute Window", direction: "ascending" }],
    page_size: Math.min(Math.max(1, options.batchSize), 100),
  });
  const items: WarmupQueueItem[] = [];
  for (const page of response.results) {
    if (!("properties" in page)) continue;
    const props = page.properties as Record<string, unknown>;
    const item = parseQueueItem({ id: page.id, properties: props });
    if (!item) {
      const eventTypeKeys = ["planned_event_type", "Planned Event Type", "planned_action", "Planned Action"];
      const eventTypeValues = Object.fromEntries(
        eventTypeKeys.map((k) => [k, props[k] != null ? getSelectName(props[k]) || "(empty)" : "(missing)"])
      );
      const rawEventType = props["planned_event_type"];
      const rawPlannedAction = props["planned_action"];
      const rawSnippet = (v: unknown) => (v === undefined ? "undefined" : JSON.stringify(v).slice(0, 400));
      logger.info(
        `Warmup Queue 候选过滤 page_id=${page.id} reason=parse_fail ` +
          `property_keys=[${Object.keys(props).join(",")}] ` +
          `event_type_sources=${JSON.stringify(eventTypeValues)} ` +
          `raw_planned_event_type=${rawSnippet(rawEventType)} ` +
          `raw_planned_action=${rawSnippet(rawPlannedAction)}`
      );
      continue;
    }
    if (item.status !== WARMUP_STATUS_PENDING) {
      logger.info(`Warmup Queue 候选过滤 task_id=${item.taskId} reason=status_not_pending status=${item.status}`);
      continue;
    }
    if (item.auditDecision !== WARMUP_AUDIT_KEEP) {
      logger.info(`Warmup Queue 候选过滤 task_id=${item.taskId} reason=audit_not_keep audit_decision=${item.auditDecision}`);
      continue;
    }
    if (!item.auditRunId || !item.auditedAt) {
      logger.info(`Warmup Queue 候选过滤 task_id=${item.taskId} reason=audit_missing`);
      continue;
    }
    if (!isExecuteWindowActive(item.executeWindowStart, item.executeWindowEnd, options.now)) {
      logger.info(
        `Warmup Queue 候选过滤 task_id=${item.taskId} reason=execute_window_inactive window_start=${item.executeWindowStart?.toISOString() ?? "null"} window_end=${item.executeWindowEnd?.toISOString() ?? "null"}`,
      );
      continue;
    }
    items.push(item);
  }
  return items;
}

export async function lookupDependencyStatus(
  notion: Client,
  queueDatabaseUrl: string,
  dependsOnTaskId: string,
): Promise<QueryDependencyResult> {
  const dependencyId = dependsOnTaskId.trim();
  if (!dependencyId) return { found: true, status: WARMUP_STATUS_SENT };
  const response = await notion.databases.query({
    database_id: toNotionDbId(queueDatabaseUrl),
    filter: { property: "Task ID", rich_text: { equals: dependencyId } },
    page_size: 1,
  });
  const page = response.results[0];
  if (!page || !("properties" in page)) return { found: false, status: "" };
  return {
    found: true,
    status: getSelectName(page.properties["Status"]),
  };
}

export async function resolveWarmupCredential(
  notion: Client,
  credentialRegistryDatabaseUrl: string,
  actorMailboxId: string,
): Promise<WarmupCredentialRecord | null> {
  const response = await notion.databases.query({
    database_id: toNotionDbId(credentialRegistryDatabaseUrl),
    page_size: 100,
  });
  const normalizedActor = actorMailboxId.trim();
  for (const page of response.results) {
    if (!("properties" in page)) continue;
    const props = page.properties;
    const mailboxId = getPlainText(props["mailbox_id"]);
    const account = getPlainText(props["account"]);
    if (mailboxId !== normalizedActor && account !== normalizedActor) continue;
    return {
      pageId: page.id,
      mailboxId,
      account,
      loginUsername: getPlainText(props["login_username"]),
      password: getPlainText(props["password"]),
      refreshToken: getPlainText(props["refresh_token"]),
      accessToken: getPlainText(props["access_token"]),
      secretRef: getPlainText(props["secret_ref"]),
      authConfigJson: getPlainText(props["auth_config_json"]),
      sessionRef: getPlainText(props["session_ref"]),
      platform: getSelectName(props["platform"]),
      authType: getSelectName(props["auth_type"]),
      credentialStatus: getPlainText(props["credential_status"]) || WARMUP_CREDENTIAL_STATUS_VALID,
      executorEnabled: getCheckbox(props["executor_enabled"]),
      bandwidthDetailPageId: getRelationIds(props["BandWidth Detail"])[0] ?? null,
      warmupMailboxPoolPageId: getRelationIds(props["Warmup Mailbox Pool"])[0] ?? null,
    };
  }
  return null;
}

export async function getBandwidthRecordByPageId(
  notion: Client,
  bandwidthDatabaseUrl: string,
  pageId: string,
): Promise<WarmupBandwidthRecord | null> {
  if (!pageId) return null;
  const page = await notion.pages.retrieve({ page_id: pageId });
  if (!("properties" in page)) return null;
  return {
    pageId,
    account: getPlainText(page.properties["account"]),
    platform: getSelectName(page.properties["platform"]),
    actionType: getSelectName(page.properties["action_type"]),
    allowed: getCheckbox(page.properties["allowed"]),
    riskState: getSelectName(page.properties["risk_state"]),
    readinessStatus: getSelectName(page.properties["readiness_status"]),
    cooldownUntil: getDateStart(page.properties["cooldown_until"]),
    policyVersion: getPlainText(page.properties["policy_version"]),
    strategyVersion: getPlainText(page.properties["strategy_version"]),
  };
}

export async function findBandwidthRecordForAction(
  notion: Client,
  bandwidthDatabaseUrl: string,
  actorMailboxId: string,
  actionType: string,
): Promise<WarmupBandwidthRecord | null> {
  const response = await notion.databases.query({
    database_id: toNotionDbId(bandwidthDatabaseUrl),
    page_size: 100,
  });
  const normalizedActor = actorMailboxId.trim();
  for (const page of response.results) {
    if (!("properties" in page)) continue;
    const platform = getSelectName(page.properties["platform"]);
    const account = getPlainText(page.properties["account"]);
    const currentActionType = getSelectName(page.properties["action_type"]);
    if (platform !== WARMUP_PLATFORM_EMAIL) continue;
    if (account !== normalizedActor) continue;
    if (currentActionType !== actionType) continue;
    return {
      pageId: page.id,
      account,
      platform,
      actionType: currentActionType,
      allowed: getCheckbox(page.properties["allowed"]),
      riskState: getSelectName(page.properties["risk_state"]),
      readinessStatus: getSelectName(page.properties["readiness_status"]),
      cooldownUntil: getDateStart(page.properties["cooldown_until"]),
      policyVersion: getPlainText(page.properties["policy_version"]),
      strategyVersion: getPlainText(page.properties["strategy_version"]),
    };
  }
  return null;
}

export async function updateWarmupQueuePage(
  notion: Client,
  pageId: string,
  payload: WarmupQueueUpdatePayload,
): Promise<void> {
  const props: NotionUpdateProps = {
    Status: { select: { name: payload.status } },
    current_step: { rich_text: getRichTextContent(payload.currentStep) },
    next_step_rule: { rich_text: getRichTextContent(payload.nextStepRule) },
    executor_run_id: { rich_text: getRichTextContent(payload.executorRunId) },
    last_executor_sync_at: { date: { start: getDateTimeIso(payload.lastExecutorSyncAt) } },
  };
  await notion.pages.update({ page_id: pageId, properties: props });
}

export async function hasExecutionLogEvent(
  notion: Client,
  executionLogDatabaseUrl: string,
  queueTaskId: string,
  externalEventId: string,
): Promise<boolean> {
  const response = await notion.databases.query({
    database_id: toNotionDbId(executionLogDatabaseUrl),
    page_size: 100,
  });
  return response.results.some((page) => {
    if (!("properties" in page)) return false;
    return (
      getPlainText(page.properties["queue_task_id"]) === queueTaskId &&
      getPlainText(page.properties["external_event_id"]) === externalEventId
    );
  });
}

export async function createExecutionLogEntry(
  notion: Client,
  executionLogDatabaseUrl: string,
  payload: WarmupExecutionLogPayload,
): Promise<void> {
  const properties: NotionCreateProps = {
    Name: { title: getTitleContent(payload.name) },
    account_id: { rich_text: getRichTextContent(payload.accountId) },
    action_type: { select: { name: payload.actionType } },
    event_type: { select: { name: payload.eventType } },
    result: { select: { name: payload.result } },
    platform: { select: { name: WARMUP_PLATFORM_EMAIL } },
    task_type: { select: { name: "warmup" } },
    task_id: { rich_text: getRichTextContent(payload.taskId) },
    queue_task_id: { rich_text: getRichTextContent(payload.queueTaskId) },
    relationship_id: { rich_text: getRichTextContent(payload.relationshipId) },
    thread_id: { rich_text: getRichTextContent(payload.threadId) },
    actor_mailbox_id: { rich_text: getRichTextContent(payload.actorMailboxId) },
    counterparty_mailbox_id: { rich_text: getRichTextContent(payload.counterpartyMailboxId) },
    direction: { select: { name: payload.direction } },
    chain_step_no: { number: 0 },
    execute_time: { date: { start: getDateTimeIso(payload.executeTime) } },
    external_event_id: { rich_text: getRichTextContent(payload.externalEventId) },
    message_id: { rich_text: getRichTextContent(payload.messageId ?? "") },
    content_excerpt: { rich_text: getRichTextContent(payload.contentExcerpt) },
    event_metadata_json: { rich_text: getRichTextContent(payload.eventMetadataJson) },
  };
  if (payload.anomalyType) {
    properties["anomaly_type"] = { rich_text: getRichTextContent(payload.anomalyType) };
  }
  if (payload.policyVersion) {
    properties["policy_version"] = { rich_text: getRichTextContent(payload.policyVersion) };
  }
  if (payload.strategyVersion) {
    properties["strategy_version"] = { rich_text: getRichTextContent(payload.strategyVersion) };
  }
  await notion.pages.create({
    parent: { database_id: toNotionDbId(executionLogDatabaseUrl) },
    properties,
  });
}

export async function hasConversationEvent(
  notion: Client,
  conversationEventLogDatabaseUrl: string,
  queueTaskId: string,
  externalEventId: string,
): Promise<boolean> {
  const response = await notion.databases.query({
    database_id: toNotionDbId(conversationEventLogDatabaseUrl),
    page_size: 100,
  });
  return response.results.some((page) => {
    if (!("properties" in page)) return false;
    return (
      getPlainText(page.properties["queue_task_id"]) === queueTaskId &&
      getPlainText(page.properties["external_event_id"]) === externalEventId
    );
  });
}

export async function createConversationEventEntry(
  notion: Client,
  conversationEventLogDatabaseUrl: string,
  payload: WarmupConversationLogPayload,
): Promise<void> {
  await notion.pages.create({
    parent: { database_id: toNotionDbId(conversationEventLogDatabaseUrl) },
    properties: {
      Event: { title: getTitleContent(payload.eventTitle) },
      "Observed At": { date: { start: getDateTimeIso(payload.observedAt) } },
      "Event Type": { select: { name: payload.eventType } },
      Direction: { select: { name: payload.direction } },
      relationship_id: { rich_text: getRichTextContent(payload.relationshipId) },
      thread_id: { rich_text: getRichTextContent(payload.threadId) },
      actor_mailbox_id: { rich_text: getRichTextContent(payload.actorMailboxId) },
      counterparty_mailbox_id: { rich_text: getRichTextContent(payload.counterpartyMailboxId) },
      queue_task_id: { rich_text: getRichTextContent(payload.queueTaskId) },
      external_event_id: { rich_text: getRichTextContent(payload.externalEventId) },
      event_metadata_json: { rich_text: getRichTextContent(payload.eventMetadataJson) },
      content_excerpt: { rich_text: getRichTextContent(payload.contentExcerpt) },
    },
  });
}

export function evaluateBandwidthGuard(record: WarmupBandwidthRecord | null, now: Date): string | null {
  if (!record) return null;
  if (!record.allowed) return "bandwidth_not_allowed";
  if (record.readinessStatus === "Paused") return "bandwidth_paused";
  if (record.riskState === "Red") return "bandwidth_risk_red";
  if (record.cooldownUntil && record.cooldownUntil.getTime() > now.getTime()) return "bandwidth_cooldown_active";
  return null;
}

export function buildContentExcerpt(item: WarmupQueueItem): string {
  const raw = item.body.trim();
  if (!raw) return `(dry run: ${item.plannedEventType})`;
  return raw.slice(0, 2000);
}

export function logQueueSkip(item: WarmupQueueItem, reason: string): void {
  logger.info(`Warmup Queue 跳过 task_id=${item.taskId || "(empty)"} reason=${reason}`);
}

