/**
 * Reply Tasks 发回复流程：单条发送与批量发送（Status ≠ Done）。
 * 从配置取发件人库 URL，解析 Task→IM→Touchpoint 得 threadId/to/subject/senderAccount，发信后回写 Status = Done。
 */

import type { Client } from "@notionhq/client";
import { getGmailClient, plainToHtml, sendInThread } from "./gmail-send.js";
import {
  getReplyTaskSendContext,
  listReplyTasks,
  updateReplyTaskStatusDone,
} from "./notion-reply-tasks.js";
import { fetchSenderCredentials } from "./notion-queue.js";
import { loadReplyTasksConfigOrDefault } from "./reply-tasks-config.js";
import { logger } from "./logger.js";

/** 单条发送结果 */
export interface SendOneResult {
  ok: boolean;
  taskPageId: string;
  error?: string;
}

/**
 * 单条发送：解析 Task、取凭据、发信、成功后回写 Done。
 * bodyHtml 可选，不传则用 Task 的 Suggested Reply 转 HTML。
 */
export async function sendOneReplyTask(
  notion: Client,
  taskPageId: string,
  senderAccountsDatabaseUrl: string,
  bodyHtml?: string,
): Promise<SendOneResult> {
  const ctx = await getReplyTaskSendContext(notion, taskPageId);
  const creds = await fetchSenderCredentials(notion, senderAccountsDatabaseUrl, ctx.senderAccount);
  if (!creds) {
    const err = `未找到发件人凭据: Sender Account=${ctx.senderAccount}`;
    logger.warn(`[ReplyTasks] task=${taskPageId} ${err}`);
    return { ok: false, taskPageId, error: err };
  }
  /** 空串视为未提供 body，使用 Suggested Reply 转 HTML；仅当传入非空 bodyHtml 时使用用户编辑内容 */
  const htmlBody = bodyHtml != null && bodyHtml !== "" ? bodyHtml : plainToHtml(ctx.suggestedReply);
  const { gmail, userId } = getGmailClient(creds.password);
  try {
    await sendInThread(
      gmail,
      userId,
      ctx.threadId,
      creds.email,
      ctx.to,
      ctx.subject,
      htmlBody,
    );
    await updateReplyTaskStatusDone(notion, taskPageId);
    logger.info(`[ReplyTasks] task=${taskPageId} 发送成功并已标为 Done`);
    return { ok: true, taskPageId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[ReplyTasks] task=${taskPageId} 发送失败: ${msg}`);
    return { ok: false, taskPageId, error: msg };
  }
}

/** 批量发送结果 */
export interface SendBatchResult {
  total: number;
  ok: number;
  failed: number;
  results: SendOneResult[];
}

/**
 * 批量发送：取当前选中的 Reply Tasks 库，查询 Status ≠ Done 的 Task，逐条发送并汇总结果。
 */
export async function sendBatchReplyTasks(notion: Client): Promise<SendBatchResult> {
  const config = await loadReplyTasksConfigOrDefault();
  if (config.entries.length === 0) {
    return { total: 0, ok: 0, failed: 0, results: [] };
  }
  const idx = config.selected_index >= 0 ? config.selected_index : 0;
  const entry = config.entries[idx];
  if (!entry) {
    return { total: 0, ok: 0, failed: 0, results: [] };
  }
  const tasks = await listReplyTasks(notion, entry.reply_tasks_db_id, { filterStatusNotDone: true });
  const results: SendOneResult[] = [];
  for (const t of tasks) {
    const one = await sendOneReplyTask(notion, t.pageId, entry.sender_accounts_database_url);
    results.push(one);
  }
  const ok = results.filter((r) => r.ok).length;
  return {
    total: results.length,
    ok,
    failed: results.length - ok,
    results,
  };
}
