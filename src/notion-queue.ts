/**
 * Notion Queue 与发件人库：解析 database_id、查询 Pending 项、更新 Queue 页面、查询发件人凭据。
 * 依赖 @notionhq/client；属性名与 Notion 库中一致（如 Email Status、Planned Send At、Sender Account 等）。
 */

import type { Client } from "@notionhq/client";
import { logger } from "./logger.js";

/** 从 Notion 数据库 URL 解析 database_id。支持 ?db=xxx 及 path 中 32 位 hex。 */
export function parseDatabaseId(url: string): string {
  const s = (url || "").trim();
  const dbMatch = s.match(/[?&]db=([a-f0-9-]{32,36})/i);
  if (dbMatch) return dbMatch[1].replace(/-/g, "");
  const pathMatch = s.match(/([a-f0-9]{32})/i);
  if (pathMatch) return pathMatch[1];
  throw new Error(`无法从 URL 解析 database_id: ${url}`);
}

/** Queue 单条（从 Notion page 解析出的可发项） */
export interface QueueItem {
  pageId: string;
  senderAccount: string;
  plannedSendAt: Date | null;
  email: string;
  emailSubject: string;
  emailBody: string;
  sequenceStage: string;
  threadId: string | null;
  messageIdLast: string | null;
  sentAtLast: Date | null;
}

/** 从 Notion 属性对象中取 select 或 status 的 name（Email Status 在 Notion 中可为 Select 或 Status 类型） */
function getSelectOrStatusName(prop: unknown): string | null {
  if (prop && typeof prop === "object") {
    if ("select" in prop) {
      const sel = (prop as { select: { name?: string } }).select;
      return sel?.name ?? null;
    }
    if ("status" in prop) {
      const st = (prop as { status: { name?: string } }).status;
      return st?.name ?? null;
    }
  }
  return null;
}

/** 从 Notion 属性对象中取 rich_text 的 plain_text 拼接（无分隔符，用于单行字段如 Subject、Sender Account）。 */
function getRichText(prop: unknown): string {
  if (prop && typeof prop === "object" && "rich_text" in prop) {
    const arr = (prop as { rich_text: Array<{ plain_text?: string }> }).rich_text;
    if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("");
  }
  return "";
}

/**
 * 从 Notion rich_text 取纯文本，段与段之间用换行连接。
 * 用于多行文本属性（如 Email Body），避免 Notion 多 segment 时被 join("") 连成一行。
 */
function getRichTextWithNewlines(prop: unknown): string {
  if (prop && typeof prop === "object" && "rich_text" in prop) {
    const arr = (prop as { rich_text: Array<{ plain_text?: string }> }).rich_text;
    if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("\n");
  }
  return "";
}

/** 从 Notion 取邮箱：支持 Email 类型（email 字段）或 Rich text（rich_text 拼接），与 Notion 库列类型一致。 */
function getEmailOrRichText(prop: unknown): string {
  if (prop && typeof prop === "object") {
    if ("email" in prop && typeof (prop as { email?: string }).email === "string")
      return (prop as { email: string }).email.trim();
    return getRichText(prop);
  }
  return "";
}

/** 收件人使用的属性名：默认 "Email"，若 Notion 中有多列邮箱可设为 "Email (1)" 等（见 env NOTION_QUEUE_RECIPIENT_PROPERTY）。 */
function getRecipientPropertyName(): string {
  const name = process.env.NOTION_QUEUE_RECIPIENT_PROPERTY?.trim();
  return name || "Email";
}

/**
 * 从 Notion 属性对象中取 date.start（ISO 或 date-only）为 Date。
 * Notion 可能返回无时区后缀的 datetime（如 "2026-02-25T15:01:00"），JS 会按运行环境本地时区解析；
 * 若服务器在 UTC 而 Notion 存的是 GMT+8 时间，会差 8 小时。无时区时按 PLANNED_SEND_AT_TZ 解析（默认 +08:00）。
 */
function getDate(prop: unknown): Date | null {
  if (prop && typeof prop === "object" && "date" in prop) {
    const d = (prop as { date: { start?: string } }).date;
    const start = d?.start;
    if (!start) return null;
    const hasTz = /Z$|[+-]\d{2}:?\d{2}$/.test(start);
    if (hasTz) return new Date(start);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start)) {
      const tz = process.env.PLANNED_SEND_AT_TZ ?? "+08:00";
      return new Date(start.trim() + tz);
    }
    return new Date(start);
  }
  return null;
}

/** 解析单条结果：要么返回可发项，要么返回跳过原因与读到的内容摘要（便于排查）。 */
type PageParseResult =
  | { ok: true; item: QueueItem }
  | { ok: false; skipReason: string; readSummary: Record<string, unknown> };

export interface PageToQueueItemOptions {
  /** 为 true 时不因 now < plannedSendAt 跳过；发送节奏由调用方（如 queue-sender）控制 */
  ignorePlannedSendAt?: boolean;
}

function pageToQueueItem(
  page: { id: string; properties: Record<string, unknown> },
  now: Date,
  options?: PageToQueueItemOptions,
): PageParseResult {
  const props = page.properties;
  const emailStatus = getSelectOrStatusName(props["Email Status"]);
  const sentAtLast = getDate(props["Sent At Last"]);
  const messageIdLastRaw = getRichText(props["Message ID Last"]);
  const recipientProp = getRecipientPropertyName();
  const email = getEmailOrRichText(props[recipientProp]);
  const emailSubject = getRichText(props["Email Subject"]).trim();
  const emailBody = getRichTextWithNewlines(props["Email Body"]).trim();
  const plannedSendAt = getDate(props["Planned Send At"]);
  const rawPlannedStart =
    (props["Planned Send At"] && typeof props["Planned Send At"] === "object" && "date" in props["Planned Send At"])
      ? (props["Planned Send At"] as { date: { start?: string } }).date?.start ?? ""
      : "";

  const readSummary: Record<string, unknown> = {
    emailStatus: emailStatus ?? "(空)",
    sentAtLast: sentAtLast != null ? sentAtLast.toISOString() : null,
    messageIdLastEmpty: !(messageIdLastRaw && messageIdLastRaw.trim()),
    emailLen: email.length,
    subjectLen: emailSubject.length,
    bodyLen: emailBody.length,
    plannedSendAtRaw: rawPlannedStart || null,
    plannedSendAtParsed: plannedSendAt?.toISOString() ?? null,
    now: now.toISOString(),
  };

  if (emailStatus !== "Pending") {
    return { ok: false, skipReason: `Email Status 不为 Pending（当前=${emailStatus ?? "空"}）`, readSummary };
  }
  if (sentAtLast != null || (messageIdLastRaw && messageIdLastRaw.trim())) {
    return {
      ok: false,
      skipReason: sentAtLast != null ? "Sent At Last 已有值（已发过）" : "Message ID Last 非空（已发过）",
      readSummary,
    };
  }
  if (!email || !emailSubject || !emailBody) {
    const missing = [email ? "" : "Email", emailSubject ? "" : "Email Subject", emailBody ? "" : "Email Body"]
      .filter(Boolean)
      .join(",");
    return { ok: false, skipReason: `必填为空: ${missing || "Email/Subject/Body"}`, readSummary };
  }
  if (!options?.ignorePlannedSendAt && plannedSendAt != null && now < plannedSendAt) {
    return {
      ok: false,
      skipReason: `Planned Send At 未到（now < plannedSendAt）`,
      readSummary: { ...readSummary, nowBeforePlanned: true },
    };
  }

  const threadIdRaw = getRichText(props["Thread ID"]).trim();
  return {
    ok: true,
    item: {
      pageId: page.id,
      senderAccount: getRichText(props["Sender Account"]).trim(),
      plannedSendAt,
      email,
      emailSubject,
      emailBody,
      sequenceStage: getSelectOrStatusName(props["Sequence Stage"]) ?? "",
      threadId: threadIdRaw || null,
      messageIdLast: messageIdLastRaw.trim() || null,
      sentAtLast,
    },
  };
}

/** Email Status 在 Notion 中可为 Status 或 Select 类型，查询时先试 status 再试 select */
const EMAIL_STATUS_FILTER_STATUS = { property: "Email Status" as const, status: { equals: "Pending" } };
const EMAIL_STATUS_FILTER_SELECT = { property: "Email Status" as const, select: { equals: "Pending" } };

const QUEUE_BASE_FILTER = [
  { property: "Stop Flag", checkbox: { equals: false } },
  { property: "Unsubscribe Flag", checkbox: { equals: false } },
  { property: "Bounce Flag", checkbox: { equals: false } },
  { property: "Needs Review", checkbox: { equals: false } },
  { property: "Email", rich_text: { is_not_empty: true } },
  { property: "Email Subject", rich_text: { is_not_empty: true } },
  { property: "Email Body", rich_text: { is_not_empty: true } },
] as const;

export interface QueryQueuePendingOptions {
  /** 为 true 时不因 now < plannedSendAt 过滤；传入 pageToQueueItem，发送节奏由调用方控制 */
  ignorePlannedSendAt?: boolean;
}

/**
 * 查询 Queue 库中符合条件的 Pending 项：Email Status=Pending，四 Flag 全 false，Email/Subject/Body 非空；
 * 排序 Queued At 升序；仅当 now >= Planned Send At（或 options.ignorePlannedSendAt 为 true 时忽略）且 Sent At Last / Message ID Last 为空时纳入。
 * 兼容 Email Status 为 Notion Status 或 Select 类型。
 */
export async function queryQueuePending(
  notion: Client,
  databaseId: string,
  batchSize: number,
  now: Date,
  options?: QueryQueuePendingOptions,
): Promise<QueueItem[]> {
  const databaseIdWithHyphens = databaseId.length === 32
    ? `${databaseId.slice(0, 8)}-${databaseId.slice(8, 12)}-${databaseId.slice(12, 16)}-${databaseId.slice(16, 20)}-${databaseId.slice(20, 32)}`
    : databaseId;
  let response: Awaited<ReturnType<Client["databases"]["query"]>>;
  try {
    response = await notion.databases.query({
      database_id: databaseIdWithHyphens,
      filter: { and: [EMAIL_STATUS_FILTER_STATUS, ...QUEUE_BASE_FILTER] },
      sorts: [{ property: "Queued At", direction: "ascending" }],
      page_size: Math.min(Math.max(1, batchSize), 100),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/property type|does not match|filter.*select/i.test(msg)) {
      response = await notion.databases.query({
        database_id: databaseIdWithHyphens,
        filter: { and: [EMAIL_STATUS_FILTER_SELECT, ...QUEUE_BASE_FILTER] },
        sorts: [{ property: "Queued At", direction: "ascending" }],
        page_size: Math.min(Math.max(1, batchSize), 100),
      });
    } else throw e;
  }
  const rawCount = response.results.length;
  logger.info(
    `Queue API 过滤条件：Email Status=Pending；Stop Flag/Unsubscribe Flag/Bounce Flag/Needs Review 均为 false；Email、Email Subject、Email Body 非空`,
  );
  logger.info(`Queue API 查到 ${rawCount} 条`);
  if (rawCount === 0) {
    let pendingTotal = 0;
    try {
      const relaxed = await notion.databases.query({
        database_id: databaseIdWithHyphens,
        filter: EMAIL_STATUS_FILTER_STATUS,
        page_size: 100,
      });
      pendingTotal = relaxed.results.length;
    } catch (_) {
      try {
        const relaxed = await notion.databases.query({
          database_id: databaseIdWithHyphens,
          filter: EMAIL_STATUS_FILTER_SELECT,
          page_size: 100,
        });
        pendingTotal = relaxed.results.length;
      } catch (_) {}
    }
    if (pendingTotal > 0)
      logger.warn(
        `仅 Email Status=Pending 有 ${pendingTotal} 条，但加上四 Flag 假与 Email/Subject/Body 非空后为 0 条，请检查 Stop Flag/Unsubscribe/Bounce/Needs Review 或必填列`,
      );
    else logger.info(`库中当前无 Email Status=Pending 的行（可能已发完或已改状态）`);
    logger.info(`因 API 返回 0 条，无逐条「查到的内容」可输出`);
  }
  const items: QueueItem[] = [];
  const parseOptions = options?.ignorePlannedSendAt ? { ignorePlannedSendAt: true } : undefined;
  for (const page of response.results) {
    if (!("properties" in page)) continue;
    const result = pageToQueueItem({ id: page.id, properties: page.properties }, now, parseOptions);
    if (result.ok) {
      items.push(result.item);
    } else {
      const summary = result.readSummary as Record<string, unknown>;
      const summaryStr = Object.entries(summary)
        .map(([k, v]) => `${k}=${v === null || v === undefined ? "null" : String(v)}`)
        .join(", ");
      logger.warn(`Queue 跳过 page=${page.id} 不满足: ${result.skipReason}`);
      logger.warn(`  → 查到的内容: ${summaryStr}`);
    }
  }
  if (rawCount > 0 && items.length === 0)
    logger.warn(`Queue 应用内过滤后 0 条待发（见上方各条「不满足」原因）`);
  else if (items.length > 0)
    logger.info(`Queue 应用内过滤后待发 ${items.length} 条`);
  return items;
}

/** 成功回写 Queue page：Done + Sent At Last + Thread ID + Message ID Last + Subject Last，Needs Review=false。兼容 Email Status 为 Status/Select。 */
export async function updateQueuePageSuccess(
  notion: Client,
  pageId: string,
  payload: { sentAt: Date; threadId: string; messageId: string; subjectLast: string },
): Promise<void> {
  const baseProps = {
    "Sent At Last": { date: { start: payload.sentAt.toISOString() } },
    "Thread ID": { rich_text: [{ type: "text", text: { content: payload.threadId } }] },
    "Message ID Last": { rich_text: [{ type: "text", text: { content: payload.messageId } }] },
    "Subject Last": { rich_text: [{ type: "text", text: { content: payload.subjectLast } }] },
    "Needs Review": { checkbox: false },
  };
  type NotionUpdateProps = Parameters<Client["pages"]["update"]>[0]["properties"];
  try {
    await notion.pages.update({
      page_id: pageId,
      properties: { "Email Status": { status: { name: "Done" } }, ...baseProps } as NotionUpdateProps,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/property type|does not match|status|select/i.test(msg)) {
      await notion.pages.update({
        page_id: pageId,
        properties: { "Email Status": { select: { name: "Done" } }, ...baseProps } as NotionUpdateProps,
      });
    } else throw e;
  }
}

/** 失败回写：Needs Review、Stop Reason（text）、可选 Stop Flag、Email Status 改回 Pending。兼容 Email Status 为 Status/Select。 */
export async function updateQueuePageFailure(
  notion: Client,
  pageId: string,
  payload: { stopReason: string; needsReview?: boolean; stopFlag?: boolean; emailStatusPending?: boolean },
): Promise<void> {
  type NotionUpdateProps = Parameters<Client["pages"]["update"]>[0]["properties"];
  const props: NotionUpdateProps = {
    "Needs Review": { checkbox: payload.needsReview !== false },
    "Stop Reason": { rich_text: [{ type: "text", text: { content: (payload.stopReason || "").slice(0, 2000) } }] },
  };
  if (payload.stopFlag === true) (props as Record<string, unknown>)["Stop Flag"] = { checkbox: true };
  if (payload.emailStatusPending === true) (props as Record<string, unknown>)["Email Status"] = { status: { name: "Pending" } };
  try {
    await notion.pages.update({ page_id: pageId, properties: props });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (payload.emailStatusPending === true && /property type|does not match|status|select/i.test(msg)) {
      (props as Record<string, unknown>)["Email Status"] = { select: { name: "Pending" } };
      await notion.pages.update({ page_id: pageId, properties: props });
    } else throw e;
  }
}

/** 从属性中取 password：支持 "password" 或 "Password" 列名（Notion 显示名可能首字母大写） */
function getPasswordFromProps(props: Record<string, unknown>): string {
  const raw =
    getRichText(props["password"]).trim() || getRichText(props["Password"]).trim();
  return raw;
}

/**
 * 从发件人库按 Sender Account（匹配 Email 属性）取一行，返回 Email + password。
 * 发件人库的 Email 列可能为 email 或 rich_text 类型，Notion 查询 filter 对 email 类型可能不生效，
 * 故先按 rich_text 查；若无结果则拉取多行在内存中按 Email 匹配。
 */
export async function fetchSenderCredentials(
  notion: Client,
  senderAccountsDatabaseUrl: string,
  senderAccount: string,
): Promise<{ email: string; password: string } | null> {
  const databaseId = parseDatabaseId(senderAccountsDatabaseUrl);
  const databaseIdWithHyphens = databaseId.length === 32
    ? `${databaseId.slice(0, 8)}-${databaseId.slice(8, 12)}-${databaseId.slice(12, 16)}-${databaseId.slice(16, 20)}-${databaseId.slice(20, 32)}`
    : databaseId;
  const normalizedAccount = senderAccount.trim();
  let response: Awaited<ReturnType<Client["databases"]["query"]>>;
  try {
    response = await notion.databases.query({
      database_id: databaseIdWithHyphens,
      filter: { property: "Email", rich_text: { equals: normalizedAccount } },
      page_size: 1,
    });
  } catch (_) {
    response = await notion.databases.query({
      database_id: databaseIdWithHyphens,
      page_size: 100,
    });
  }
  if (response.results.length === 0) {
    response = await notion.databases.query({
      database_id: databaseIdWithHyphens,
      page_size: 100,
    });
  }
  for (const page of response.results) {
    if (!("properties" in page)) continue;
    const props = page.properties as Record<string, unknown>;
    const email = getEmailOrRichText(props["Email"]).trim();
    if (email !== normalizedAccount) continue;
    const password = getPasswordFromProps(props);
    if (!password) continue;
    return { email, password };
  }
  return null;
}
