/**
 * Queue Sender 常驻进程：按时段与行业类型，从 Notion Queue 取 Pending 项，用 Gmail API 发送并回写 Queue。
 * 由 Dashboard 启停；仅当当前时段绑定的行业为 Queue 类型时执行。
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
import { getGmailClient, sendCold1, sendFollowup } from "./gmail-send.js";
import { loadSchedule, getSchedulePath, getIndustryForNow } from "./schedule.js";
import type { ScheduleIndustry } from "./schedule.js";
import { logger } from "./logger.js";

const MAX_RETRIES = 3;
const SLEEP_NO_SLOT_MS = 60_000;
/** 无待发项时拉取 Notion 的间隔 */
const SLEEP_NO_PENDING_MS = 60_000;
/** 按 nextSendAt 休眠时的上限，避免过长 */
const SLEEP_MAX_MS = 24 * 60 * 60 * 1000;

/** 从 env 读取节流参数（未配置时用默认值）；按发送者独立生效 */
function getThrottleConfig(): {
  minIntervalMs: number;
  maxIntervalMs: number;
  maxPerHour: number;
  maxPerDay: number;
} {
  const minIntervalMs = Math.max(0, parseInt(process.env.QUEUE_THROTTLE_MIN_INTERVAL_MS ?? "180000", 10)) || 180000;
  const maxIntervalMs = Math.max(minIntervalMs, parseInt(process.env.QUEUE_THROTTLE_MAX_INTERVAL_MS ?? "300000", 10)) || 300000;
  const maxPerHour = Math.max(1, parseInt(process.env.QUEUE_THROTTLE_MAX_PER_HOUR ?? "10", 10)) || 10;
  const maxPerDay = Math.max(1, parseInt(process.env.QUEUE_THROTTLE_MAX_PER_DAY ?? "50", 10)) || 50;
  return { minIntervalMs, maxIntervalMs, maxPerHour, maxPerDay };
}

/** 单发送者节流状态：下次可发时间、本小时/今日已发数及对应时间起点（自然小时/自然日滚动） */
interface SenderThrottleState {
  nextSendAt: number;
  countThisHour: number;
  countThisDay: number;
  hourStart: number;
  dayStart: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 给定时间的当日 0 点（本地）时间戳 */
function startOfDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 给定时间所在小时的整点时间戳 */
function startOfHour(now: Date): number {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

/**
 * 按自然小时/自然日滚动：若当前已进入新小时/新日则重置对应计数，并返回是否在限额内可发。
 */
function rollAndCanSend(
  state: SenderThrottleState,
  now: Date,
  maxPerHour: number,
  maxPerDay: number,
): { state: SenderThrottleState; canSend: boolean } {
  const hour0 = startOfHour(now);
  const day0 = startOfDay(now);
  let { countThisHour, countThisDay, hourStart, dayStart } = state;
  if (hour0 > state.hourStart) {
    countThisHour = 0;
    hourStart = hour0;
  }
  if (day0 > state.dayStart) {
    countThisDay = 0;
    dayStart = day0;
  }
  const canSend = countThisHour < maxPerHour && countThisDay < maxPerDay;
  return {
    state: { ...state, countThisHour, countThisDay, hourStart, dayStart },
    canSend,
  };
}

/** 当前行业是否为 Queue 类型 */
function isQueueIndustry(ind: ScheduleIndustry): boolean {
  return ind.type === "queue";
}

/** 处理单条：取凭据、发信、回写；返回是否已处理（成功或已标失败）。 */
async function processOne(
  notion: Client,
  item: QueueItem,
  industry: ScheduleIndustry,
): Promise<void> {
  const senderUrl = industry.senderAccountsDatabaseUrl?.trim();
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
  logger.info(`page=${item.pageId} 凭据已取到，准备发信 to=${item.email}`);
  const isFollowup = Boolean(item.threadId && item.threadId.trim());
  if (isFollowup && !(item.messageIdLast && item.messageIdLast.trim())) {
    await updateQueuePageFailure(notion, item.pageId, {
      stopReason: "Missing Message ID Last for followup (References)",
      needsReview: true,
      emailStatusPending: true,
    });
    return;
  }
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      if (attempt > 1) logger.info(`page=${item.pageId} 重试发信 ${attempt}/${MAX_RETRIES}`);
      const { gmail, userId } = getGmailClient(creds.password);
      if (isFollowup && item.threadId && item.messageIdLast) {
        const result = await sendFollowup(
          gmail,
          userId,
          item.threadId,
          item.messageIdLast,
          creds.email,
          item.email,
          item.emailSubject,
          item.emailBody,
        );
        await updateQueuePageSuccess(notion, item.pageId, {
          sentAt: new Date(),
          threadId: result.threadId,
          messageId: result.messageId,
          subjectLast: item.emailSubject,
        });
        logger.info(`Queue 发送成功 page=${item.pageId} to=${item.email} messageId=${result.messageId}`);
        return;
      }
      const result = await sendCold1(
        gmail,
        userId,
        creds.email,
        item.email,
        item.emailSubject,
        item.emailBody,
      );
      await updateQueuePageSuccess(notion, item.pageId, {
        sentAt: new Date(),
        threadId: result.threadId,
        messageId: result.messageId,
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
 * 一轮：拉取待发（忽略 Planned Send At）→ 按发送者分组 → 每发送者至多发 1 条（满足节流则 processOne）→ 返回建议休眠毫秒数。
 * 单条 processOne 失败不影响其他发送者；senderStates 在外部持久化，便于按 nextSendAt 休眠。
 */
async function runOneRound(
  notion: Client,
  industry: ScheduleIndustry,
  throttle: ReturnType<typeof getThrottleConfig>,
  senderStates: Map<string, SenderThrottleState>,
): Promise<{ sleepMs: number }> {
  const queueDbId = parseDatabaseId(industry.queueDatabaseUrl ?? "");
  const batchSize = Math.min(100, Math.max(1, industry.batchSize ?? 100));
  const now = new Date();
  const items = await queryQueuePending(notion, queueDbId, batchSize, now, {
    ignorePlannedSendAt: true,
  });
  if (items.length === 0) {
    return { sleepMs: SLEEP_NO_PENDING_MS };
  }
  const bySender = groupBySender(items);
  const nowTs = now.getTime();

  for (const [senderKey, list] of bySender) {
    if (list.length === 0) continue;
    let state = senderStates.get(senderKey);
    if (state == null) {
      state = {
        nextSendAt: 0,
        countThisHour: 0,
        countThisDay: 0,
        hourStart: startOfHour(now),
        dayStart: startOfDay(now),
      };
    }
    const { state: rolled, canSend } = rollAndCanSend(
      state,
      now,
      throttle.maxPerHour,
      throttle.maxPerDay,
    );
    senderStates.set(senderKey, rolled);
    if (nowTs < rolled.nextSendAt || !canSend) continue;
    const item = list[0];
    try {
      await processOne(notion, item, industry);
      const next = new Date();
      const nextSendAt = next.getTime() + randomBetween(throttle.minIntervalMs, throttle.maxIntervalMs);
      senderStates.set(senderKey, {
        ...rolled,
        nextSendAt,
        countThisHour: rolled.countThisHour + 1,
        countThisDay: rolled.countThisDay + 1,
      });
    } catch (e) {
      logger.warn(`处理 Queue 项失败 page=${item.pageId}`, e instanceof Error ? e.message : e);
    }
  }

  const futureNextSendAts = Array.from(senderStates.values())
    .map((s) => s.nextSendAt)
    .filter((t) => t > nowTs);
  const sleepMs =
    futureNextSendAts.length > 0
      ? Math.min(SLEEP_MAX_MS, Math.max(0, Math.min(...futureNextSendAts) - nowTs))
      : SLEEP_NO_PENDING_MS;
  return { sleepMs };
}

/** 主循环：等待落入 Queue 时段 → 拉取 → 按发送者至多发 1 条 → 按 nextSendAt 或 1 分钟休眠 → 重复。 */
async function main(): Promise<void> {
  const configPath = getSchedulePath();
  const schedule = await loadSchedule(configPath);
  const throttle = getThrottleConfig();
  const senderStates = new Map<string, SenderThrottleState>();
  logger.info(
    "Queue Sender 已启动，发送节奏由程序控制（Planned Send At 不参与）；节流按发送者，无固定轮询",
  );
  for (;;) {
    try {
      const industry = getIndustryForNow(schedule);
      if (industry == null) {
        await sleep(SLEEP_NO_SLOT_MS);
        continue;
      }
      if (!isQueueIndustry(industry)) {
        await sleep(SLEEP_NO_SLOT_MS);
        continue;
      }
      const token = process.env.NOTION_API_KEY;
      if (!token?.trim()) {
        logger.warn("未配置 NOTION_API_KEY，跳过本轮");
        await sleep(SLEEP_NO_PENDING_MS);
        continue;
      }
      const notion = new Client({ auth: token });
      const { sleepMs } = await runOneRound(notion, industry, throttle, senderStates);
      await sleep(sleepMs);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isNetwork =
        /socket disconnected|TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|network|ECONNREFUSED/i.test(msg);
      if (isNetwork)
        logger.warn(`Queue Sender 本轮异常：疑似网络连接问题，下轮将重试。原始错误: ${msg.slice(0, 120)}`);
      else logger.warn("Queue Sender 本轮异常", e);
      await sleep(SLEEP_NO_PENDING_MS);
    }
  }
}

main().catch((e) => {
  logger.error("Queue Sender 退出", e);
  process.exit(1);
});
