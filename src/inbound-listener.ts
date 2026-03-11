/**
 * Inbound Listener 常驻进程：轮询 Gmail 入站（INBOX、排除 SENT），幂等写入 📥 RE Inbound Messages，
 * 按 Thread ID 路由到 📬 Touchpoints，并对 Unsubscribe/Hard Bounce 写回 Touchpoints 止损。
 * 由 Dashboard 启停；配置来自 inbound-listener.json。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import { loadInboundListenerConfig } from "./inbound-listener-config.js";
import { fetchSenderCredentials } from "./notion-queue.js";
import {
  findInboundMessageByMessageId,
  findTouchpointsByThreadId,
  createInboundMessageRow,
  updateTouchpointStop,
  updateTouchpointOnReply,
  type InboundClassification,
} from "./notion-inbound.js";
import { getGmailClientForRead, listInboxMessageIds, getMessageAndParse, type InboundMessageParsed } from "./gmail-read.js";
import {
  getZohoAccessToken,
  getZohoAccountId,
  getZohoInboxFolderId,
  listZohoInboxMessageIds,
  getZohoMessageAndParse,
} from "./zoho-mail.js";
import {
  getM365AccessToken,
  listM365InboxMessageIds,
  getM365MessageAndParse,
} from "./m365-mail.js";
import { logger } from "./logger.js";

const LIST_INBOX_MAX_RESULTS = 50;

/** 格式化 Message title：YYYY-MM-DD HH:mm — <From> — <Subject> */
function formatMessageTitle(parsed: InboundMessageParsed): string {
  const date = parsed.received_at;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min} — ${parsed.from_email} — ${(parsed.subject ?? "").slice(0, 80)}`;
}

/** 生成本轮的 Listener Run ID */
function generateRunId(): string {
  const now = new Date();
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${iso}-re-inbound-01`;
}

/** Body 归一化：小写、连续空白合并为单空格、trim。供 Unsubscribe/Hard Bounce 检测用。 */
function normalizeBodyPlain(bodyPlain: string): string {
  return (bodyPlain ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * 引用分隔符正则：匹配到则在该位置前截断，只取「新内容」做 Unsubscribe/Bounce 判定。
 * 顺序无关，取最早出现位置截断。
 */
const QUOTE_SEPARATORS: RegExp[] = [
  /\n\s*On\s+.+wrote\s*:/i,                                    // 英文：On Mon, ... wrote:
  /\n-{2,}\s*Original Message\s*-*/i,                           // ----- Original Message -----
  /\n-{2,}\s*Forwarded message\s*-*/i,                          // ----- Forwarded message -----
  /\n\s*<[^>]+>\s*于\s*.+写道\s*[：:]/,                          // 中文换行后：<email> 于...写道：
  /<[^>]+>\s*于\s*.+写道\s*[：:]/,                               // 中文无换行：Stop<email> 于...写道：
];

/**
 * 取「引用分隔符」之前的新内容并归一化；无分隔符则用首行（常见「仅回复 STOP」）或全文。
 * 支持：On ... wrote:、----- Original Message、Forwarded message、<email> 于...写道：（中英文）。
 */
function getNewContentBeforeQuote(bodyPlain: string): string {
  const raw = (bodyPlain ?? "").trim();
  let cut = raw.length;
  for (const re of QUOTE_SEPARATORS) {
    const m = raw.match(re);
    if (m?.index != null && m.index >= 0) cut = Math.min(cut, m.index);
  }
  let before = raw.slice(0, cut);
  if (cut === raw.length && before.includes("\n")) {
    before = (before.split(/\r?\n/)[0] ?? before).trim();
  }
  return normalizeBodyPlain(before);
}

/** 多组路由：找出包含该 mailbox 的 groups，按顺序查 Touchpoints by Thread ID；命中唯一即返回该 group + pageId */
async function routeToGroup(
  notion: Client,
  config: Awaited<ReturnType<typeof loadInboundListenerConfig>>,
  mailbox: string,
  threadId: string,
): Promise<{ groupIndex: number; touchpointPageId: string | null; needsReview: boolean }> {
  const groupsWithMailbox = config.groups
    .map((g, i) => ({ group: g, index: i }))
    .filter(({ group }) => group.mailboxes.some((m) => m.trim().toLowerCase() === mailbox.trim().toLowerCase()));
  for (const { group, index } of groupsWithMailbox) {
    const pageIds = await findTouchpointsByThreadId(notion, group.touchpoints_db_id, threadId);
    if (pageIds.length === 1) {
      return { groupIndex: index, touchpointPageId: pageIds[0]!, needsReview: false };
    }
  }
  const firstIndex = groupsWithMailbox[0]?.index ?? 0;
  return { groupIndex: firstIndex, touchpointPageId: null, needsReview: true };
}

/** Unsubscribe 强命中关键词（英文） */
const UNSUBSCRIBE_STRONG_EN = [
  "unsubscribe", "remove me", "do not contact", "don't contact", "stop emailing", "stop sending",
];
/** Unsubscribe 强命中关键词（中文） */
const UNSUBSCRIBE_STRONG_CN = [
  "退订", "取消订阅", "别再发", "停止发送", "拉黑我",
  "不要再联系", "不要再跟进", "不要再发",
];
/** 弱命中：需同时包含「不感兴趣」与「停止类」 */
const WEAK_NOT_INTERESTED = ["not interested", "no longer interested"];
const WEAK_STOP = ["stop", "don't", "do not", "remove"];

/**
 * 检测 Unsubscribe/STOP：基于 body_plain_normalized（引用前新内容），强命中或弱命中。
 * 返回 "strong" | "weak" | false。弱命中时 Touchpoint 仍止损，但 IM 应设 Needs Review。
 */
function detectUnsubscribe(bodyPlain: string): false | "strong" | "weak" {
  const norm = getNewContentBeforeQuote(bodyPlain);
  if (!norm) return false;

  const strongEn = UNSUBSCRIBE_STRONG_EN.some((k) => norm.includes(k));
  const strongCn = UNSUBSCRIBE_STRONG_CN.some((k) => norm.includes(k));
  const onlyStop = /^\s*stop\s*$/.test(norm);
  if (onlyStop || strongEn || strongCn) return "strong";

  const hasNotInterested = WEAK_NOT_INTERESTED.some((k) => norm.includes(k));
  const hasStopLike = WEAK_STOP.some((k) => norm.includes(k));
  if (hasNotInterested && hasStopLike) return "weak";

  return false;
}

/** Hard Bounce 候选筛选：from / subject / body 任一满足才进入 Hard 判定 */
const BOUNCE_CANDIDATE_FROM = ["mailer-daemon", "postmaster"];
const BOUNCE_CANDIDATE_SUBJECT = [
  "delivery status notification", "undelivered mail", "mail delivery failed",
  "returned mail", "failure notice",
];
const BOUNCE_CANDIDATE_BODY = ["diagnostic-code", "status:", "final-recipient:", "action: failed"];

/** Hard 特征 A：用户/地址不存在 */
const BOUNCE_HARD_A = [
  "user unknown", "no such user", "unknown user", "recipient address rejected",
  "mailbox not found", "address not found", "invalid recipient",
  "550 5.1.1", "550 5.1.0", "status: 5.1.1", "status: 5.1.0",
];
/** Hard 特征 B：域/主机不存在 */
const BOUNCE_HARD_B = ["domain not found", "host not found", "nxdomain", "unrouteable address"];
/** Soft：排除这些不判 Hard */
const BOUNCE_SOFT = [
  "mailbox full", "temporarily deferred", "try again later",
  "status: 4.", /status:\s*4\.\d/i, /\b4\.\d+\.\d+/,
];

/**
 * 检测 Hard Bounce：先候选筛选（from/subject/body），再在 body_plain_normalized 中查 Hard 特征，并排除 soft。
 */
function detectHardBounce(from: string, subject: string, bodyPlain: string): boolean {
  const fromL = (from ?? "").toLowerCase();
  const subjL = (subject ?? "").toLowerCase();
  const norm = getNewContentBeforeQuote(bodyPlain);
  const bodyL = (bodyPlain ?? "").toLowerCase();

  const isCandidate =
    BOUNCE_CANDIDATE_FROM.some((m) => fromL.includes(m)) ||
    BOUNCE_CANDIDATE_SUBJECT.some((m) => subjL.includes(m)) ||
    BOUNCE_CANDIDATE_BODY.some((m) => bodyL.includes(m));
  if (!isCandidate) return false;

  for (const s of BOUNCE_SOFT) {
    if (typeof s === "string" && bodyL.includes(s)) return false;
    if (s instanceof RegExp && s.test(bodyL)) return false;
  }

  const hasHardA = BOUNCE_HARD_A.some((m) => norm.includes(m));
  const hasHardB = BOUNCE_HARD_B.some((m) => norm.includes(m));
  return hasHardA || hasHardB;
}

/**
 * 是否为退信候选：From 为 mailer-daemon/postmaster、或 has_multipart_report、或 subject/body 满足现有 BOUNCE_CANDIDATE_*。
 */
function isBounceCandidate(parsed: InboundMessageParsed): boolean {
  if (parsed.is_mailer_daemon_or_postmaster || parsed.has_multipart_report) return true;
  const fromL = (parsed.from_email ?? "").toLowerCase();
  const subjL = (parsed.subject ?? "").toLowerCase();
  const bodyL = (parsed.body_plain ?? "").toLowerCase();
  return (
    BOUNCE_CANDIDATE_FROM.some((m) => fromL.includes(m)) ||
    BOUNCE_CANDIDATE_SUBJECT.some((m) => subjL.includes(m)) ||
    BOUNCE_CANDIDATE_BODY.some((m) => bodyL.includes(m))
  );
}

/**
 * 检测 Bounce Soft：仅当退信候选时，在 body 中查 BOUNCE_SOFT 特征；若命中且非 Hard 则返回 true。Hard 优先于 Soft。
 */
function detectBounceSoft(parsed: InboundMessageParsed): boolean {
  if (!isBounceCandidate(parsed)) return false;
  if (detectHardBounce(parsed.from_email, parsed.subject, parsed.body_plain)) return false;
  const bodyL = (parsed.body_plain ?? "").toLowerCase();
  for (const s of BOUNCE_SOFT) {
    if (typeof s === "string" && bodyL.includes(s)) return true;
    if (s instanceof RegExp && s.test(bodyL)) return true;
  }
  return false;
}

/** 分层分类结果（不包含 Unsubscribe，Unsubscribe 仅由止损分支设置） */
type ContentClassification = "Human Reply" | "Auto Reply" | "Bounce Hard" | "Bounce Soft" | "Other";

/** OOO/自动回复正文关键词（引用前新内容归一化后匹配） */
const OOO_KEYWORDS = [
  "out of office",
  "automatic reply",
  "away until",
  "currently unavailable",
  "i will return on",
];

/**
 * 正文是否含引用结构（如 "On ... wrote:"），作为人工回复的辅助信号。
 */
function hasQuoteStructure(bodyPlain: string): boolean {
  const raw = (bodyPlain ?? "").trim();
  for (const re of QUOTE_SEPARATORS) {
    if (re.test(raw)) return true;
  }
  return false;
}

/**
 * 分层分类：第一层 Header Auto → 第二层 Bounce Hard/Soft → 第三层正文 OOO / 引用 / Other。
 * 不输出 Unsubscribe；Unsubscribe 仅由 processOneMessage 的止损分支在 detectUnsubscribe 命中时设置。
 */
function classifyInboundMessage(parsed: InboundMessageParsed): ContentClassification {
  const autoSubmitted = (parsed.auto_submitted ?? "").toLowerCase().trim();
  const precedence = parsed.precedence ?? "";

  if (
    autoSubmitted === "auto-replied" ||
    autoSubmitted === "auto-generated" ||
    precedence === "auto_reply"
  ) {
    return "Auto Reply";
  }

  if (isBounceCandidate(parsed)) {
    if (detectHardBounce(parsed.from_email, parsed.subject, parsed.body_plain)) return "Bounce Hard";
    if (detectBounceSoft(parsed)) return "Bounce Soft";
    return "Bounce Hard";
  }

  const newContent = getNewContentBeforeQuote(parsed.body_plain);
  const hasOoo = OOO_KEYWORDS.some((k) => newContent.includes(k));
  if (hasOoo) return "Auto Reply";
  if (hasQuoteStructure(parsed.body_plain)) return "Human Reply";
  return "Other";
}

async function processOneMessage(
  notion: Client,
  config: Awaited<ReturnType<typeof loadInboundListenerConfig>>,
  parsed: InboundMessageParsed,
  mailbox: string,
  listenerRunId: string,
  provider: string,
): Promise<{ wroteIm: boolean; stopWritten: boolean; resolvedGroupIndex: number; touchpointFound: boolean }> {
  const { groupIndex, touchpointPageId, needsReview } = await routeToGroup(
    notion,
    config,
    mailbox,
    parsed.thread_id,
  );
  if (!touchpointPageId) {
    return { wroteIm: false, stopWritten: false, resolvedGroupIndex: groupIndex, touchpointFound: false };
  }
  const group = config.groups[groupIndex]!;
  const existingIm = await findInboundMessageByMessageId(notion, group.inbound_messages_db_id, parsed.gmail_message_id);
  if (existingIm) {
    return { wroteIm: false, stopWritten: false, resolvedGroupIndex: groupIndex, touchpointFound: true };
  }

  const initialClassification = classifyInboundMessage(parsed);
  const unsub = detectUnsubscribe(parsed.body_plain);
  const hardBounce = detectHardBounce(parsed.from_email, parsed.subject, parsed.body_plain);
  const bounceSoft = detectBounceSoft(parsed);

  let finalClassification: InboundClassification;
  let stopWritten = false;
  if (unsub === "strong" || unsub === "weak") {
    finalClassification = "Unsubscribe";
    stopWritten = true;
  } else if (hardBounce) {
    finalClassification = "Bounce Hard";
    stopWritten = true;
  } else if (bounceSoft) {
    finalClassification = "Bounce Soft";
  } else {
    finalClassification = initialClassification;
  }

  const needsReviewFinal = needsReview || unsub === "weak";

  const messageTitle = formatMessageTitle(parsed);
  const imPageId = await createInboundMessageRow(notion, group.inbound_messages_db_id, {
    messageTitle,
    gmailMessageId: parsed.gmail_message_id,
    threadId: parsed.thread_id,
    fromEmail: parsed.from_email,
    toEmail: parsed.to_email,
    receivedAt: parsed.received_at,
    subject: parsed.subject,
    bodyPlain: parsed.body_plain,
    snippet: parsed.snippet,
    listenerRunId,
    touchpointPageId: touchpointPageId ?? undefined,
    classification: finalClassification,
    needsReview: needsReviewFinal,
    provider: provider || "Gmail",
  });

  if (stopWritten) {
    if (finalClassification === "Unsubscribe") {
      await updateTouchpointStop(notion, touchpointPageId, {
        stopReason: "Unsubscribe",
        nextSendAtNull: true,
        receivedAt: parsed.received_at,
      });
    } else {
      await updateTouchpointStop(notion, touchpointPageId, {
        stopReason: "Bounce Hard",
        nextSendAtNull: true,
        receivedAt: parsed.received_at,
      });
    }
  } else {
    await updateTouchpointOnReply(notion, touchpointPageId);
  }

  logger.info(
    `[匹配] mailbox=${mailbox} thread_id=${parsed.thread_id} from=${parsed.from_email} subject=${(parsed.subject ?? "").slice(0, 60)} wrote_im=true stop_written=${stopWritten} classification=${finalClassification}`,
  );
  return { wroteIm: true, stopWritten, resolvedGroupIndex: groupIndex, touchpointFound: !!touchpointPageId };
}

async function main(): Promise<void> {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : undefined;
  const config = await loadInboundListenerConfig(configPath);
  const notionToken = process.env.NOTION_API_KEY;
  if (!notionToken?.trim()) throw new Error("缺少 NOTION_API_KEY 环境变量");
  const notion = new Client({ auth: notionToken });
  const listenerRunId = generateRunId();
  const uniqueMailboxes = new Set<string>();
  for (const g of config.groups) {
    for (const m of g.mailboxes) if (m.trim()) uniqueMailboxes.add(m.trim());
  }
  for (const mailbox of uniqueMailboxes) {
    const groupWithMailbox = config.groups.find((g) =>
      g.mailboxes.some((m) => m.trim().toLowerCase() === mailbox.toLowerCase()),
    );
    if (!groupWithMailbox) continue;
    const creds = await fetchSenderCredentials(
      notion,
      groupWithMailbox.sender_accounts_database_url,
      mailbox,
    );
    if (!creds) {
      logger.warn(`Inbound Listener 未找到发件人凭据 mailbox=${mailbox}，跳过该邮箱`);
      continue;
    }
    const provider = (creds.provider ?? "Gmail").trim() || "Gmail";
    const bodyMax = config.body_plain_max_chars ?? 40000;

    if (provider === "Gmail") {
      const { gmail, userId } = getGmailClientForRead(creds.password);
      const messageList = await listInboxMessageIds(gmail, userId, LIST_INBOX_MAX_RESULTS);
      for (const { id } of messageList) {
        try {
          const parsed = await getMessageAndParse(gmail, userId, id, bodyMax);
          if (!parsed) continue;
          await processOneMessage(notion, config, parsed, mailbox, listenerRunId, provider);
        } catch (e) {
          logger.warn(`Inbound Listener 处理 message ${id} 失败`, e);
        }
      }
    } else if (provider === "Zoho") {
      const accessToken = await getZohoAccessToken(creds.password);
      const accountId = await getZohoAccountId(accessToken);
      const folderId = await getZohoInboxFolderId(accessToken, accountId);
      const messageList = await listZohoInboxMessageIds(
        accessToken,
        accountId,
        folderId,
        LIST_INBOX_MAX_RESULTS,
      );
      for (const item of messageList) {
        try {
          const parsed = await getZohoMessageAndParse(
            accessToken,
            accountId,
            folderId,
            item.id,
            bodyMax,
            item,
          );
          if (!parsed) continue;
          await processOneMessage(notion, config, parsed, mailbox, listenerRunId, provider);
        } catch (e) {
          logger.warn(`Inbound Listener 处理 Zoho message ${item.id} 失败`, e);
        }
      }
    } else if (provider === "Microsoft 365") {
      const accessToken = await getM365AccessToken(creds.password);
      const messageList = await listM365InboxMessageIds(accessToken, LIST_INBOX_MAX_RESULTS);
      for (const item of messageList) {
        try {
          const parsed = await getM365MessageAndParse(
            accessToken,
            item.id,
            bodyMax,
            item,
          );
          if (!parsed) continue;
          await processOneMessage(notion, config, parsed, mailbox, listenerRunId, provider);
        } catch (e) {
          logger.warn(`Inbound Listener 处理 M365 message ${item.id} 失败`, e);
        }
      }
    } else {
      logger.warn(`Inbound Listener 不支持的 Provider mailbox=${mailbox} provider=${provider}，跳过`);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  const configPath = process.argv.includes("--config")
    ? process.argv[process.argv.indexOf("--config") + 1]
    : undefined;
  for (;;) {
    try {
      await main();
    } catch (e) {
      logger.warn("Inbound Listener 本轮异常", e);
    }
    let intervalSec = 120;
    try {
      const config = await loadInboundListenerConfig(configPath);
      intervalSec = config.poll_interval_seconds ?? 120;
    } catch (_) {
      logger.warn("Inbound Listener 无法加载配置，120 秒后重试");
    }
    await sleep(intervalSec * 1000);
  }
})();
