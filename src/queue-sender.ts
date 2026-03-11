/**
 * Queue Sender 常驻进程：从 queue-sender.json 读取多条 Queue 配置，每轮按顺序对每条拉取 Pending 并发送。
 * 由 Dashboard 启停；不再依赖 schedule 时段。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import {
  parseDatabaseId,
  queryQueuePending,
  updateQueuePageSuccess,
  updateQueuePageFailure,
  fetchSenderCredentials,
  type QueueItem,
} from "./notion-queue.js";
import { getGmailClient, plainToHtml, sendCold1, sendFollowup } from "./gmail-send.js";
import {
  getZohoAccessToken,
  getZohoAccountId,
  sendZohoCold1,
  sendZohoReply,
} from "./zoho-mail.js";
import {
  getM365AccessToken,
  sendM365Cold1,
  sendM365Reply,
} from "./m365-mail.js";
import { loadQueueSenderConfigOrDefault } from "./queue-sender-config.js";
import type { QueueSenderEntry } from "./queue-sender-config.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 3;
/** 每轮固定间隔（分钟级轮询） */
const ROUND_INTERVAL_MS = 60_000;

/** Planned Send At 发送窗口：仅当计划时间落在 [now-5min, now] 内才发送 */
const PLANNED_SEND_WINDOW_MS = 5 * 60 * 1000;

/** 从 env 读取节流参数（仅每日上限）；按发送者独立生效 */
function getThrottleConfig(): { maxPerDay: number } {
  const maxPerDay = Math.max(1, parseInt(process.env.QUEUE_THROTTLE_MAX_PER_DAY ?? "50", 10)) || 50;
  return { maxPerDay };
}

/** 单发送者节流状态：仅按自然日滚动，每日上限 */
interface SenderThrottleState {
  countThisDay: number;
  dayStart: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 给定时间的当日 0 点（本地）时间戳 */
function startOfDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * 按自然日滚动：若已进入新日则重置计数，返回是否在每日限额内可发。
 */
function rollAndCanSend(
  state: SenderThrottleState,
  now: Date,
  maxPerDay: number,
): { state: SenderThrottleState; canSend: boolean } {
  const day0 = startOfDay(now);
  let { countThisDay, dayStart } = state;
  if (day0 > state.dayStart) {
    countThisDay = 0;
    dayStart = day0;
  }
  const canSend = countThisDay < maxPerDay;
  return {
    state: { ...state, countThisDay, dayStart },
    canSend,
  };
}

/** 处理单条：取凭据、发信、回写。 */
async function processOne(
  notion: Client,
  item: QueueItem,
  senderAccountsDatabaseUrl: string,
): Promise<void> {
  const senderUrl = senderAccountsDatabaseUrl.trim();
  if (!senderUrl) {
    await updateQueuePageFailure(notion, item.pageId, {
      stopReason: "发件人库 URL 未配置",
      needsReview: true,
      emailStatusPending: true,
    });
    return;
  }
  logger.info(`处理 page=${item.pageId} 正在取发件人凭据 senderAccount=${item.senderAccount}…`);
  const creds = await fetchSenderCredentials(notion, senderUrl, item.senderAccount);
  if (!creds) {
    logger.warn(`page=${item.pageId} 未找到发件人凭据 Sender Account=${item.senderAccount}`);
    await updateQueuePageFailure(notion, item.pageId, {
      stopReason: `未找到发件人凭据: Sender Account=${item.senderAccount}`,
      needsReview: true,
      emailStatusPending: true,
    });
    return;
  }
  logger.info(`page=${item.pageId} 凭据已取到 provider=${creds.provider}，准备发信 to=${item.email}`);
  const isFollowup = Boolean(item.threadId && item.threadId.trim());
  if (isFollowup && !(item.messageIdLast && item.messageIdLast.trim())) {
    await updateQueuePageFailure(notion, item.pageId, {
      stopReason: "Missing Message ID Last for followup (References)",
      needsReview: true,
      emailStatusPending: true,
    });
    return;
  }
  const provider = (creds.provider ?? "Gmail").trim() || "Gmail";
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) logger.info(`page=${item.pageId} 重试发信 ${attempt}/${MAX_RETRIES}`);
      let result: { messageId: string; threadId: string };

      if (provider === "Gmail") {
        const { gmail, userId } = getGmailClient(creds.password);
        if (isFollowup && item.threadId && item.messageIdLast) {
          result = await sendFollowup(
            gmail,
            userId,
            item.threadId,
            item.messageIdLast,
            creds.email,
            item.email,
            item.emailSubject,
            plainToHtml(item.emailBody),
          );
        } else {
          result = await sendCold1(
            gmail,
            userId,
            creds.email,
            item.email,
            item.emailSubject,
            plainToHtml(item.emailBody),
          );
        }
      } else if (provider === "Zoho") {
        const accessToken = await getZohoAccessToken(creds.password);
        const accountId = await getZohoAccountId(accessToken);
        const htmlBody = plainToHtml(item.emailBody);
        if (isFollowup && item.messageIdLast) {
          result = await sendZohoReply(
            accessToken,
            accountId,
            item.messageIdLast,
            creds.email,
            item.email,
            item.emailSubject,
            htmlBody,
          );
        } else {
          result = await sendZohoCold1(
            accessToken,
            accountId,
            creds.email,
            item.email,
            item.emailSubject,
            htmlBody,
          );
        }
      } else if (provider === "Microsoft 365") {
        const accessToken = await getM365AccessToken(creds.password);
        const htmlBody = plainToHtml(item.emailBody);
        if (isFollowup && item.messageIdLast) {
          result = await sendM365Reply(accessToken, item.messageIdLast, htmlBody);
        } else {
          result = await sendM365Cold1(
            accessToken,
            creds.email,
            item.email,
            item.emailSubject,
            htmlBody,
          );
        }
      } else {
        await updateQueuePageFailure(notion, item.pageId, {
          stopReason: `不支持的 Provider: ${provider}，仅支持 Gmail / Zoho / Microsoft 365`,
          needsReview: true,
          emailStatusPending: true,
        });
        return;
      }

      await updateQueuePageSuccess(notion, item.pageId, {
        sentAt: new Date(),
        threadId: result.threadId,
        messageId: result.messageId || result.threadId,
        subjectLast: item.emailSubject,
      });
      logger.info(`Queue 发送成功 page=${item.pageId} to=${item.email} messageId=${result.messageId}`);
      return;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      const msg = lastError.message || String(e);
      const isTransient =
        /timeout|ECONNRESET|429|5\d{2}/i.test(msg) || msg.includes("rate limit");
      if (!isTransient || attempt === MAX_RETRIES) {
        await updateQueuePageFailure(notion, item.pageId, {
          stopReason: msg.slice(0, 2000),
          needsReview: true,
          emailStatusPending: true,
          stopFlag: !isTransient,
        });
        logger.warn(`Queue 发送失败 page=${item.pageId} ${msg}`);
        return;
      }
      logger.warn(`Queue 发送临时失败 page=${item.pageId} 重试 ${attempt}/${MAX_RETRIES} ${msg}`);
      await sleep(2000 * attempt);
    }
  }
  if (lastError) {
    await updateQueuePageFailure(notion, item.pageId, {
      stopReason: lastError.message.slice(0, 2000),
      needsReview: true,
      emailStatusPending: true,
    });
  }
}

/**
 * 按发送者分组，同一发送者内保持 Queued At 顺序（items 已按 Queued At 升序）。
 */
function groupBySender(items: QueueItem[]): Map<string, QueueItem[]> {
  const map = new Map<string, QueueItem[]>();
  for (const item of items) {
    const key = item.senderAccount.trim() || "(empty)";
    const list = map.get(key);
    if (list) list.push(item);
    else map.set(key, [item]);
  }
  return map;
}

/**
 * 对单条配置执行一轮：拉取该 Queue 库（5 分钟窗口）→ 按发送者分组 → 每发送者至多发 1 条（满足每日节流则 processOne）。
 * 共用 senderStates，同一发件人跨多条配置共享每日上限。
 */
async function runOneRound(
  notion: Client,
  entry: QueueSenderEntry,
  throttle: ReturnType<typeof getThrottleConfig>,
  senderStates: Map<string, SenderThrottleState>,
): Promise<void> {
  const queueDbId = parseDatabaseId(entry.queue_database_url);
  const batchSize = Math.min(100, Math.max(1, entry.batch_size ?? 20));
  const now = new Date();
  const items = await queryQueuePending(notion, queueDbId, batchSize, now, {
    plannedSendWindowMs: PLANNED_SEND_WINDOW_MS,
  });
  if (items.length === 0) return;
  const bySender = groupBySender(items);
  const senderUrl = entry.sender_accounts_database_url.trim();

  for (const [senderKey, list] of bySender) {
    if (list.length === 0) continue;
    let state = senderStates.get(senderKey);
    if (state == null) {
      state = { countThisDay: 0, dayStart: startOfDay(now) };
    }
    const { state: rolled, canSend } = rollAndCanSend(state, now, throttle.maxPerDay);
    senderStates.set(senderKey, rolled);
    if (!canSend) continue;
    const item = list[0];
    try {
      await processOne(notion, item, senderUrl);
      senderStates.set(senderKey, {
        ...rolled,
        countThisDay: rolled.countThisDay + 1,
      });
    } catch (e) {
      logger.warn(`处理 Queue 项失败 page=${item.pageId}`, e instanceof Error ? e.message : e);
    }
  }
}

/** 主循环：每轮加载配置，对每条 entry 顺序执行一轮拉取+发送，然后固定 sleep 1 分钟。 */
async function main(): Promise<void> {
  const throttle = getThrottleConfig();
  const senderStates = new Map<string, SenderThrottleState>();
  logger.info(
    "Queue Sender 已启动，配置来自 queue-sender.json；每轮跑所有 Queue，Planned Send At 5 分钟窗口、每分钟轮询；节流仅每日上限",
  );
  for (;;) {
    try {
      const config = await loadQueueSenderConfigOrDefault();
      if (config.entries.length === 0) {
        await sleep(ROUND_INTERVAL_MS);
        continue;
      }
      const token = process.env.NOTION_API_KEY;
      if (!token?.trim()) {
        logger.warn("未配置 NOTION_API_KEY，跳过本轮");
        await sleep(ROUND_INTERVAL_MS);
        continue;
      }
      const notion = new Client({ auth: token });
      for (const entry of config.entries) {
        await runOneRound(notion, entry, throttle, senderStates);
      }
      await sleep(ROUND_INTERVAL_MS);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isNetwork =
        /socket disconnected|TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|ECONNREFUSED/i.test(msg);
      if (isNetwork)
        logger.warn(`Queue Sender 本轮异常：疑似网络连接问题，下轮将重试。原始错误: ${msg.slice(0, 120)}`);
      else logger.warn("Queue Sender 本轮异常", e);
      await sleep(ROUND_INTERVAL_MS);
    }
  }
}

main().catch((e) => {
  logger.error("Queue Sender 退出", e);
  process.exit(1);
});
