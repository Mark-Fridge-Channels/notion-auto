/**
 * Reply Tasks 自动发送常驻进程：轮询当前选中的 Reply Tasks 库中 Status ≠ Done 的 Task，
 * 按全局 Queue 节流配置每轮至多发送 1 条（最早编辑优先），发送后标为 Done。
 * 由 Dashboard 启停；节流从 env 读取（server 启动前注入 schedule.queueThrottle）。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import { listReplyTasks, getReplyTaskSendContext } from "./notion-reply-tasks.js";
import { sendOneReplyTask } from "./reply-tasks-send.js";
import { loadReplyTasksConfigOrDefault } from "./reply-tasks-config.js";
import { logger } from "./logger.js";

/** 无待发项时拉取 Notion 的间隔（毫秒） */
const SLEEP_NO_PENDING_MS = 60_000;
/** 节流等待或单条失败后的最小休眠，避免空转 */
const SLEEP_MIN_MS = 5_000;

/** 从 env 读取节流参数（仅每日上限，与 queue-sender 一致） */
function getThrottleConfig(): { maxPerDay: number } {
  const maxPerDay =
    Math.max(1, parseInt(process.env.QUEUE_THROTTLE_MAX_PER_DAY ?? "50", 10)) || 50;
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

async function main(): Promise<void> {
  const throttle = getThrottleConfig();
  const senderStates = new Map<string, SenderThrottleState>();

  logger.info(
    "Reply Tasks 自动发送已启动，每轮至多 1 条、最早编辑优先，节流仅每日上限（与 Queue 配置一致）",
  );

  for (;;) {
    try {
      const token = process.env.NOTION_API_KEY?.trim();
      if (!token) {
        logger.warn("[ReplyTasksAutoSend] 未配置 NOTION_API_KEY，跳过本轮");
        await sleep(SLEEP_NO_PENDING_MS);
        continue;
      }

      const config = await loadReplyTasksConfigOrDefault();
      if (config.entries.length === 0) {
        logger.warn("[ReplyTasksAutoSend] Reply Tasks 配置为空，跳过本轮");
        await sleep(SLEEP_NO_PENDING_MS);
        continue;
      }

      const idx = config.selected_index >= 0 ? config.selected_index : 0;
      const entry = config.entries[idx];
      if (!entry) {
        logger.warn("[ReplyTasksAutoSend] 无有效选中配置，跳过本轮");
        await sleep(SLEEP_NO_PENDING_MS);
        continue;
      }

      const notion = new Client({ auth: token });
      const tasks = await listReplyTasks(notion, entry.reply_tasks_db_id, {
        filterStatusNotDone: true,
        sortLastEdited: "asc",
      });

      if (tasks.length === 0) {
        await sleep(SLEEP_NO_PENDING_MS);
        continue;
      }

      const task = tasks[0];
      const now = new Date();

      /** 取该 Task 的发送者以做节流 key */
      let senderKey: string;
      try {
        const ctx = await getReplyTaskSendContext(notion, task.pageId);
        senderKey = ctx.senderAccount;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[ReplyTasksAutoSend] task=${task.pageId} 解析发件人失败: ${msg}，跳过`);
        await sleep(SLEEP_MIN_MS);
        continue;
      }

      let state = senderStates.get(senderKey);
      if (state == null) {
        state = { countThisDay: 0, dayStart: startOfDay(now) };
      }

      const { state: rolled, canSend } = rollAndCanSend(state, now, throttle.maxPerDay);
      senderStates.set(senderKey, rolled);

      if (!canSend) {
        logger.info(
          `[ReplyTasksAutoSend] 发送者 ${senderKey} 已达日限额，本轮跳过，下轮再拉`,
        );
        await sleep(SLEEP_NO_PENDING_MS);
        continue;
      }

      const result = await sendOneReplyTask(
        notion,
        task.pageId,
        entry.sender_accounts_database_url,
      );

      if (result.ok) {
        senderStates.set(senderKey, {
          ...rolled,
          countThisDay: rolled.countThisDay + 1,
        });
        logger.info(`[ReplyTasksAutoSend] task=${task.pageId} 发送成功，下轮再拉`);
        await sleep(SLEEP_NO_PENDING_MS);
      } else {
        logger.warn(
          `[ReplyTasksAutoSend] task=${task.pageId} 发送失败: ${result.error ?? "未知"}，稍后重试`,
        );
        await sleep(SLEEP_MIN_MS);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[ReplyTasksAutoSend] 本轮异常: ${msg}`);
      await sleep(SLEEP_NO_PENDING_MS);
    }
  }
}

main().catch((e) => {
  logger.error("Reply Tasks 自动发送进程退出", e);
  process.exit(1);
});
