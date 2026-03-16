/**
 * Warmup Executor Dry Run：读取 queue-sender.json 中配置的 Warmup 数据层，消费通过审计的
 * `Email Warmup Queue` 行，进行资格判断与状态推进，并回写 Queue / Execution Log /
 * Warmup Conversation Event Log。V1 不真实发送邮件。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import type { WarmupExecutorEntry } from "./queue-sender-config.js";
import { loadQueueSenderConfigOrDefault } from "./queue-sender-config.js";
import {
  buildContentExcerpt,
  createConversationEventEntry,
  createExecutionLogEntry,
  evaluateBandwidthGuard,
  findBandwidthRecordForAction,
  getBandwidthRecordByPageId,
  hasConversationEvent,
  hasExecutionLogEvent,
  logQueueSkip,
  lookupDependencyStatus,
  queryWarmupQueueCandidates,
  resolveWarmupCredential,
  updateWarmupQueuePage,
  type WarmupQueueItem,
} from "./notion-warmup.js";
import { logger } from "./logger.js";
import {
  buildExecutionExternalEventId,
  buildSyntheticMessageId,
  getWarmupEventMapping,
  isCredentialEligible,
  WARMUP_PLATFORM_EMAIL,
  WARMUP_STATUS_CANCELLED,
  WARMUP_STATUS_FAILED,
  WARMUP_STATUS_SENT,
  type WarmupExecutionEventType,
} from "./warmup-constants.js";
import { healthCheck } from "./mail-automation-agent-client.js";
import {
  createWarmupProviderExecutionContext,
  getWarmupActionDescriptor,
  getWarmupProviderAdapter,
  type WarmupActionExecutionResult,
} from "./warmup-provider.js";

const ROUND_INTERVAL_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateExecutorRunId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `exec-${ts}-${rand}`;
}

function getFailureNextStepRule(): string {
  return "manual_review_required";
}

function getSuccessNextStepRule(item: WarmupQueueItem): string {
  return item.nextStepRule.trim() || "completed";
}

function getSuccessStep(item: WarmupQueueItem): string {
  return `${item.plannedEventType.toLowerCase().replace(/\s+/g, "_")}_completed`;
}

async function failItem(
  notion: Client,
  item: WarmupQueueItem,
  executorRunId: string,
  currentStep: string,
): Promise<void> {
  await updateWarmupQueuePage(notion, item.pageId, {
    status: WARMUP_STATUS_FAILED,
    currentStep,
    nextStepRule: getFailureNextStepRule(),
    executorRunId,
    lastExecutorSyncAt: new Date(),
  });
}

async function maybeWriteLogs(
  notion: Client,
  entry: WarmupExecutorEntry,
  item: WarmupQueueItem,
  executorRunId: string,
  policyVersion: string,
  strategyVersion: string,
  result: WarmupActionExecutionResult,
): Promise<void> {
  const mapping = getWarmupEventMapping(item.plannedEventType);
  if (!mapping.executionEventType || !mapping.conversationEventType || !mapping.actionType) {
    return;
  }
  const eventType: WarmupExecutionEventType = mapping.executionEventType;
  const externalEventId = buildExecutionExternalEventId(executorRunId, item.taskId, eventType);
  const messageId = result.messageId || (
    item.plannedEventType === "Send" || item.plannedEventType === "Reply"
      ? buildSyntheticMessageId(item.taskId)
      : undefined
  );
  const metadataJson = JSON.stringify({
    dry_run: false,
    planned_event_type: item.plannedEventType,
    platform: WARMUP_PLATFORM_EMAIL,
    provider: result.provider,
    subject_present: Boolean(item.subject.trim()),
    body_present: Boolean(item.body.trim()),
    reply_to_message_id: item.replyToMessageId || null,
    execution: result.metadata,
  });
  const contentExcerpt = buildContentExcerpt(item);

  if (!(await hasExecutionLogEvent(notion, entry.execution_log_database_url, item.taskId, externalEventId))) {
    await createExecutionLogEntry(notion, entry.execution_log_database_url, {
      name: `${item.plannedEventType} ${item.taskId}`,
      accountId: item.actorMailboxId || item.account,
      actionType: mapping.actionType,
      eventType,
      result: "success",
      queueTaskId: item.taskId,
      taskId: item.taskId,
      relationshipId: item.relationshipId,
      threadId: result.threadId || item.threadId,
      actorMailboxId: item.actorMailboxId || item.account,
      counterpartyMailboxId: item.counterpartyMailboxId || item.target,
      direction: mapping.direction,
      executeTime: new Date(),
      externalEventId,
      messageId,
      contentExcerpt,
      eventMetadataJson: metadataJson,
      policyVersion,
      strategyVersion,
    });
  }

  if (!(await hasConversationEvent(notion, entry.conversation_event_log_database_url, item.taskId, externalEventId))) {
    await createConversationEventEntry(notion, entry.conversation_event_log_database_url, {
      eventTitle: `${item.plannedEventType} ${item.taskId}`,
      observedAt: new Date(),
      eventType: mapping.conversationEventType,
      direction: mapping.direction,
      relationshipId: item.relationshipId,
      threadId: result.threadId || item.threadId,
      actorMailboxId: item.actorMailboxId || item.account,
      counterpartyMailboxId: item.counterpartyMailboxId || item.target,
      queueTaskId: item.taskId,
      externalEventId,
      eventMetadataJson: metadataJson,
      contentExcerpt,
    });
  }
}

async function processOne(
  notion: Client,
  entry: WarmupExecutorEntry,
  item: WarmupQueueItem,
  executorRunId: string,
): Promise<void> {
  if (item.executorRunId.trim() || item.lastExecutorSyncAt) {
    logQueueSkip(item, "already_synced");
    return;
  }

  if (item.dependsOnTaskId.trim()) {
    const dependency = await lookupDependencyStatus(notion, entry.queue_database_url, item.dependsOnTaskId);
    if (!dependency.found) {
      logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=missing_dependency`);
      await failItem(notion, item, executorRunId, "missing_dependency");
      return;
    }
    if (dependency.status === WARMUP_STATUS_CANCELLED) {
      logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=blocked_by_cancelled_dependency`);
      await failItem(notion, item, executorRunId, "blocked_by_cancelled_dependency");
      return;
    }
    if (dependency.status === WARMUP_STATUS_FAILED) {
      logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=blocked_by_failed_dependency`);
      await failItem(notion, item, executorRunId, "blocked_by_failed_dependency");
      return;
    }
    if (dependency.status !== WARMUP_STATUS_SENT) {
      logQueueSkip(item, "dependency_not_ready");
      return;
    }
  }

  const credential = await resolveWarmupCredential(
    notion,
    entry.credential_registry_database_url,
    item.actorMailboxId || item.account,
  );
  if (!credential) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=credential_not_found actor=${item.actorMailboxId || item.account}`);
    await failItem(notion, item, executorRunId, "credential_not_found");
    return;
  }
  if (!isCredentialEligible(credential.executorEnabled, credential.credentialStatus)) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=credential_not_eligible executor_enabled=${credential.executorEnabled} status=${credential.credentialStatus}`);
    await failItem(notion, item, executorRunId, "credential_not_eligible");
    return;
  }

  const actionDescriptor = getWarmupActionDescriptor(item.plannedEventType);
  if (actionDescriptor.requiresSubject && !item.subject.trim()) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=missing_subject`);
    await failItem(notion, item, executorRunId, "missing_subject");
    return;
  }
  if (actionDescriptor.requiresBody && !item.body.trim()) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=missing_body`);
    await failItem(notion, item, executorRunId, "missing_body");
    return;
  }
  if (actionDescriptor.requiresReplyToMessageId && !item.replyToMessageId.trim()) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=missing_reply_to_message_id`);
    await failItem(notion, item, executorRunId, "missing_reply_to_message_id");
    return;
  }

  const defaultAddressBookId =
    entry.mail_automation_agent_default_address_book_id?.trim() ||
    process.env.MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID?.trim() ||
    undefined;
  const providerContext = createWarmupProviderExecutionContext(item, credential, { defaultAddressBookId });
  const adapter = getWarmupProviderAdapter(providerContext.runtime.provider);
  if (!adapter) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=unsupported_provider provider=${providerContext.runtime.provider}`);
    await failItem(notion, item, executorRunId, "unsupported_provider");
    return;
  }
  if (!adapter.supports(item.plannedEventType)) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=unsupported_action event_type=${item.plannedEventType}`);
    await failItem(notion, item, executorRunId, "unsupported_action");
    return;
  }

  const mapping = getWarmupEventMapping(item.plannedEventType);
  let bandwidth = credential.bandwidthDetailPageId
    ? await getBandwidthRecordByPageId(notion, entry.bandwidth_detail_database_url, credential.bandwidthDetailPageId)
    : null;

  const requiresBandwidthLookup = item.plannedEventType === "Send" || item.plannedEventType === "Reply";
  if (!bandwidth && requiresBandwidthLookup && mapping.actionType) {
    bandwidth = await findBandwidthRecordForAction(
      notion,
      entry.bandwidth_detail_database_url,
      item.actorMailboxId || item.account,
      mapping.actionType,
    );
    if (!bandwidth) {
      logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=missing_bandwidth_detail`);
      await failItem(notion, item, executorRunId, "missing_bandwidth_detail");
      return;
    }
  }

  const bandwidthReason = evaluateBandwidthGuard(bandwidth, new Date());
  if (bandwidthReason) {
    logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=${bandwidthReason}`);
    await failItem(notion, item, executorRunId, bandwidthReason);
    return;
  }

  const executionResult = await adapter.execute(providerContext);

  await updateWarmupQueuePage(notion, item.pageId, {
    status: WARMUP_STATUS_SENT,
    currentStep: getSuccessStep(item),
    nextStepRule: getSuccessNextStepRule(item),
    executorRunId,
    lastExecutorSyncAt: new Date(),
  });
  await maybeWriteLogs(
    notion,
    entry,
    item,
    executorRunId,
    bandwidth?.policyVersion ?? "",
    bandwidth?.strategyVersion ?? "",
    executionResult,
  );
  logger.info(
    `Warmup 执行成功 task_id=${item.taskId} event=${item.plannedEventType} provider=${executionResult.provider}`,
  );
}

async function runOneRound(notion: Client, entry: WarmupExecutorEntry): Promise<void> {
  if (
    !entry.queue_database_url.trim() ||
    !entry.credential_registry_database_url.trim() ||
    !entry.execution_log_database_url.trim() ||
    !entry.conversation_event_log_database_url.trim() ||
    !entry.bandwidth_detail_database_url.trim()
  ) {
    logger.warn(`Warmup Executor 配置不完整，已跳过 name=${entry.name}`);
    return;
  }
  const now = new Date();
  const executorRunId = generateExecutorRunId();
  const items = await queryWarmupQueueCandidates(notion, entry.queue_database_url, {
    now,
    batchSize: Math.min(100, Math.max(1, entry.batch_size ?? 20)),
  });
  if (items.length === 0) {
    logger.info(`Warmup Executor 本轮无候选任务 entry=${entry.name}`);
    return;
  }
  logger.info(`Warmup Executor 本轮候选数 entry=${entry.name} count=${items.length}`);
  for (const item of items) {
    try {
      await processOne(notion, entry, item, executorRunId);
    } catch (error) {
      const reason =
        error instanceof Error && /^(timeout|credential_not_found|not_found|api_error):/.test(error.message)
          ? error.message.slice(0, error.message.indexOf(":"))
          : "executor_exception";
      logger.info(`Warmup Queue 任务失败 task_id=${item.taskId} reason=${reason}`);
      logger.warn(
        `Warmup Executor 处理失败 task_id=${item.taskId}`,
        error instanceof Error ? error.message : error,
      );
      await failItem(notion, item, executorRunId, reason);
    }
  }
}

async function main(): Promise<void> {
  logger.info("Warmup Executor 已启动，配置来自 queue-sender.json；每分钟轮询真实库并执行真实动作");
  try {
    await healthCheck();
  } catch (error) {
    logger.error(error instanceof Error ? error : String(error));
    process.exit(1);
  }
  for (;;) {
    try {
      const config = await loadQueueSenderConfigOrDefault();
      if (config.entries.length === 0) {
        await sleep(ROUND_INTERVAL_MS);
        continue;
      }
      const token = process.env.NOTION_API_KEY?.trim();
      if (!token) {
        logger.warn("未配置 NOTION_API_KEY，Warmup Executor 跳过本轮");
        await sleep(ROUND_INTERVAL_MS);
        continue;
      }
      const notion = new Client({ auth: token });
      for (const entry of config.entries) {
        await runOneRound(notion, entry);
      }
    } catch (error) {
      logger.warn("Warmup Executor 本轮异常", error);
    }
    await sleep(ROUND_INTERVAL_MS);
  }
}

main().catch((error) => {
  logger.error(`Warmup Executor 退出: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
