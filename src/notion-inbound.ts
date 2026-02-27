/**
 * Notion Inbound Listener 适配：📥 IM 表幂等查询/创建、📬 Touchpoints 表按 Thread ID 路由查询、止损写回。
 * Touchpoints = 现有 Queue 表；Touchpoints 的 Email Status 为 Select 类型，写回用 select: { name: "Stopped" }。
 */

import type { Client } from "@notionhq/client";
import { parseDatabaseId } from "./notion-queue.js";
import { logger } from "./logger.js";

/** 将 32 位 hex 转为 Notion API 使用的带连字符 UUID 形式 */
function toNotionDbId(id: string): string {
  const raw = parseDatabaseId(id);
  if (raw.length !== 32) return id;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

/** 📥 IM 表 Classification 可选值（需在 Notion 表中配置对应 Select 选项） */
export type InboundClassification =
  | "Human Reply"
  | "Auto Reply"
  | "Unsubscribe"
  | "Bounce Hard"
  | "Bounce Soft"
  | "Other";

/**
 * 幂等查 IM 表：是否存在 Message ID 等于 gmail_message_id 的行。
 * 存在则返回 pageId，不存在返回 null。
 */
export async function findInboundMessageByMessageId(
  notion: Client,
  inboundMessagesDbId: string,
  gmailMessageId: string,
): Promise<string | null> {
  const dbId = toNotionDbId(inboundMessagesDbId);
  const res = await notion.databases.query({
    database_id: dbId,
    filter: { property: "Message ID", rich_text: { equals: gmailMessageId } },
    page_size: 1,
  });
  const page = res.results[0];
  return page && "id" in page ? page.id : null;
}

/**
 * 在 Touchpoints 表按 Thread ID 查询；返回匹配的 page id 列表（0 / 1 / 多）。
 * 调用方根据长度判定：1 → 唯一路由成功，0 → 未命中，>1 → 不自动绑定。
 */
export async function findTouchpointsByThreadId(
  notion: Client,
  touchpointsDbId: string,
  threadId: string,
): Promise<string[]> {
  const dbId = toNotionDbId(touchpointsDbId);
  const res = await notion.databases.query({
    database_id: dbId,
    filter: { property: "Thread ID", rich_text: { equals: threadId } },
    page_size: 10,
  });
  const ids: string[] = [];
  for (const page of res.results) {
    if ("id" in page) ids.push(page.id);
  }
  return ids;
}

/**
 * 在 📥 IM 表创建一行。属性名与开发说明 3.1/3.2 一致。
 * touchpointPageId 可选；有则写 relation。needsReview 为 true 时写 Needs Review checkbox。
 */
export async function createInboundMessageRow(
  notion: Client,
  inboundMessagesDbId: string,
  params: {
    messageTitle: string;
    gmailMessageId: string;
    threadId: string;
    fromEmail: string;
    toEmail: string;
    receivedAt: Date;
    subject: string;
    bodyPlain: string;
    snippet: string;
    listenerRunId: string;
    touchpointPageId?: string;
    classification?: InboundClassification;
    needsReview?: boolean;
  },
): Promise<string> {
  const dbId = toNotionDbId(inboundMessagesDbId);
  const bodyPlain = (params.bodyPlain ?? "").slice(0, 2000 * 10);
  const props: Record<string, unknown> = {
    "Message": { title: [{ type: "text", text: { content: params.messageTitle.slice(0, 2000) } }] },
    "Message ID": { rich_text: [{ type: "text", text: { content: params.gmailMessageId } }] },
    "Thread ID": { rich_text: [{ type: "text", text: { content: params.threadId } }] },
    "Direction": { select: { name: "Inbound" } },
    "From Email": { email: (params.fromEmail ?? "").trim() || "" },
    "To Email": { email: (params.toEmail ?? "").trim() || "" },
    "Received At": { date: { start: params.receivedAt.toISOString() } },
    "Subject": { rich_text: [{ type: "text", text: { content: (params.subject ?? "").slice(0, 2000) } }] },
    "Body Plain": { rich_text: chunkRichText(bodyPlain) },
    "Snippet": { rich_text: [{ type: "text", text: { content: (params.snippet ?? "").slice(0, 2000) } }] },
    "Listener Run ID": { rich_text: [{ type: "text", text: { content: params.listenerRunId } }] },
    "Classification": { select: { name: params.classification ?? "Other" } },
    "Needs Review": { checkbox: params.needsReview === true },
  };
  if (params.touchpointPageId) {
    (props as Record<string, unknown>)["Touchpoint"] = { relation: [{ id: params.touchpointPageId }] };
  }
  const res = await notion.pages.create({
    parent: { database_id: dbId },
    properties: props as Parameters<Client["pages"]["create"]>[0]["properties"],
  });
  return res.id;
}

/**
 * 仅更新 IM 行的 Classification（支持全部 InboundClassification 值，供后续扩展或人工修正）。
 */
export async function updateInboundMessageClassification(
  notion: Client,
  pageId: string,
  classification: InboundClassification,
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { "Classification": { select: { name: classification } } } as Parameters<
      Client["pages"]["update"]
    >[0]["properties"],
  });
}

/**
 * 仅更新 IM 行的 Needs Review（用于弱命中 Unsubscribe 时标为需人工复核）。
 */
export async function updateInboundMessageNeedsReview(
  notion: Client,
  pageId: string,
  needsReview: boolean,
): Promise<void> {
  await notion.pages.update({
    page_id: pageId,
    properties: { "Needs Review": { checkbox: needsReview } } as Parameters<
      Client["pages"]["update"]
    >[0]["properties"],
  });
}

/** Notion rich_text 单段最多 2000 字符，长内容需拆成多段 */
function chunkRichText(s: string, maxChunk = 2000): Array<{ type: "text"; text: { content: string } }> {
  const out: Array<{ type: "text"; text: { content: string } }> = [];
  for (let i = 0; i < s.length; i += maxChunk) {
    out.push({ type: "text", text: { content: s.slice(i, i + maxChunk) } });
  }
  return out.length ? out : [{ type: "text", text: { content: "" } }];
}

/**
 * 收到回复时更新 Touchpoint：将 Email Status 设为 Replied。
 * 兼容 Email Status 为 Select 或 Notion Status 类型：先试 select（Touchpoints 表通常为 Select），失败再试 status；若库中无 "Replied" 选项会打日志并忽略。
 */
export async function updateTouchpointOnReply(
  notion: Client,
  touchpointPageId: string,
): Promise<void> {
  type NotionUpdateProps = Parameters<Client["pages"]["update"]>[0]["properties"];
  try {
    await notion.pages.update({
      page_id: touchpointPageId,
      properties: { "Email Status": { select: { name: "Replied" } } } as NotionUpdateProps,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/property type|does not match|status|select|expected to be/i.test(msg)) {
      try {
        await notion.pages.update({
          page_id: touchpointPageId,
          properties: { "Email Status": { status: { name: "Replied" } } } as NotionUpdateProps,
        });
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        if (/property type|does not match|status|select|invalid/i.test(msg2)) {
          logger.warn(
            "Touchpoint Email Status 更新为 Replied 失败（若库中无 Replied 选项，请在 Notion 中为 Email Status 添加 Replied）: " +
              msg2.slice(0, 200),
          );
        } else throw e2;
      }
    } else throw e;
  }
}

/**
 * 更新 Touchpoint 行：止损（Unsubscribe 或 Bounce Hard）。
 * Touchpoints 表 Email Status 为 Select；可选 receivedAt 写 Last Inbound At（表无该列时打日志忽略）。
 */
export async function updateTouchpointStop(
  notion: Client,
  touchpointPageId: string,
  payload: {
    stopReason: "Unsubscribe" | "Bounce Hard";
    nextSendAtNull?: boolean;
    receivedAt?: Date;
  },
): Promise<void> {
  type NotionUpdateProps = Parameters<Client["pages"]["update"]>[0]["properties"];
  const props: Record<string, unknown> = {
    "Stop Flag": { checkbox: true },
    "Stop Reason": { select: { name: payload.stopReason } },
    "Email Status": { select: { name: "Stopped" } },
  };
  if (payload.nextSendAtNull === true) {
    (props as Record<string, unknown>)["Next Send At"] = { date: null };
  }
  if (payload.stopReason === "Unsubscribe") {
    (props as Record<string, unknown>)["Unsubscribe Flag"] = { checkbox: true };
  } else {
    (props as Record<string, unknown>)["Bounce Flag"] = { checkbox: true };
  }
  try {
    await notion.pages.update({
      page_id: touchpointPageId,
      properties: props as NotionUpdateProps,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Stop Reason|expected to be|rich_text|select/i.test(msg)) {
      (props as Record<string, unknown>)["Stop Reason"] = {
        rich_text: [{ type: "text", text: { content: payload.stopReason } }],
      };
      await notion.pages.update({
        page_id: touchpointPageId,
        properties: props as NotionUpdateProps,
      });
    } else throw e;
  }

  if (payload.stopReason === "Bounce Hard") {
    try {
      await notion.pages.update({
        page_id: touchpointPageId,
        properties: { "Bounce Type": { select: { name: "Hard" } } } as NotionUpdateProps,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/property|invalid|does not match/i.test(msg)) {
        logger.warn("Touchpoint Bounce Type 写入失败（若表无该列可忽略）: " + msg.slice(0, 200));
      } else throw e;
    }
  }

  if (payload.receivedAt) {
    try {
      await notion.pages.update({
        page_id: touchpointPageId,
        properties: { "Last Inbound At": { date: { start: payload.receivedAt.toISOString() } } } as NotionUpdateProps,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/property|invalid|does not match/i.test(msg)) {
        logger.warn("Touchpoint Last Inbound At 写入失败（若表无该列可忽略）: " + msg.slice(0, 200));
      } else throw e;
    }
  }
}
