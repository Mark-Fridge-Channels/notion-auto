/**
 * Notion RE Reply Tasks 适配：查询 Task 列表、Task → IM → Touchpoint 解析、回写 Status = Done。
 * Task 通过 relation「Inbound Message」指向 IM；IM 有 Thread ID、From Email、Subject、Touchpoint relation；Touchpoint 有 Sender Account。
 */

import type { Client } from "@notionhq/client";
import { parseDatabaseId } from "./notion-queue.js";

/** Reply Task 列表项（用于 Dashboard 展示） */
export interface ReplyTaskListItem {
  pageId: string;
  taskSummary: string;
  status: string | null;
  suggestedReply: string;
}

/** 单条 Task 解析为发信上下文（threadId、收件人、主题、发件人、默认正文、对方邮件正文） */
export interface ReplyTaskSendContext {
  threadId: string;
  to: string;
  subject: string;
  senderAccount: string;
  suggestedReply: string;
  /** 对方上一条回复内容（IM 的 Body Plain），供发送弹窗只读展示 */
  lastInboundBodyPlain?: string;
}

/** Task 表中关联 IM 的 relation 属性名（与 Notion 库列名一致） */
const TASK_IM_RELATION_PROP = "Inbound Message";

/** 将 32 位 hex 转为 Notion API 使用的带连字符 UUID 形式 */
function toNotionDbId(id: string): string {
  const raw = parseDatabaseId(id);
  if (raw.length !== 32) return id;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20, 32)}`;
}

function getRichText(prop: unknown): string {
  if (prop && typeof prop === "object" && "rich_text" in prop) {
    const arr = (prop as { rich_text: Array<{ plain_text?: string }> }).rich_text;
    if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("");
  }
  return "";
}

function getEmailOrRichText(prop: unknown): string {
  if (prop && typeof prop === "object") {
    if ("email" in prop && typeof (prop as { email?: string }).email === "string")
      return (prop as { email: string }).email.trim();
    return getRichText(prop);
  }
  return "";
}

function getStatusName(prop: unknown): string | null {
  if (prop && typeof prop === "object" && "status" in prop) {
    const st = (prop as { status: { name?: string } }).status;
    return st?.name ?? null;
  }
  return null;
}

function getTitlePlain(prop: unknown): string {
  if (prop && typeof prop === "object" && "title" in prop) {
    const arr = (prop as { title: Array<{ plain_text?: string }> }).title;
    if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("");
  }
  return "";
}

/** 取 relation 属性中第一个关联 page id */
function getRelationFirstId(prop: unknown): string | null {
  if (prop && typeof prop === "object" && "relation" in prop) {
    const arr = (prop as { relation: Array<{ id?: string }> }).relation;
    if (Array.isArray(arr) && arr.length > 0 && arr[0]?.id) return arr[0].id;
  }
  return null;
}

/**
 * 查询 Reply Tasks 库，返回 Task 列表（pageId、Task Summary、Status、Suggested Reply）。
 * 若 filterStatusNotDone 为 true，仅返回 Status ≠ Done 的项（用于批量发送）。
 */
export async function listReplyTasks(
  notion: Client,
  replyTasksDbId: string,
  options?: { filterStatusNotDone?: boolean },
): Promise<ReplyTaskListItem[]> {
  const dbId = toNotionDbId(replyTasksDbId);
  const filter =
    options?.filterStatusNotDone === true
      ? { property: "Status", status: { does_not_equal: "Done" } }
      : undefined;
  const res = await notion.databases.query({
    database_id: dbId,
    filter: filter as Parameters<Client["databases"]["query"]>[0]["filter"],
    page_size: 100,
    sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
  });
  const out: ReplyTaskListItem[] = [];
  for (const page of res.results) {
    if (!("id" in page) || !("properties" in page)) continue;
    const props = page.properties as Record<string, unknown>;
    const taskSummary = getTitlePlain(props["Task Summary"] ?? props["Name"]) || "(无标题)";
    const status = getStatusName(props["Status"]);
    const suggestedReply = getRichText(props["Suggested Reply"] ?? props["Suggested reply"] ?? {});
    out.push({
      pageId: page.id,
      taskSummary,
      status,
      suggestedReply,
    });
  }
  return out;
}

/**
 * 将 Reply Task 的 Status 更新为 Done（Notion Status 类型，选项名 Done，complete 分组）。
 */
export async function updateReplyTaskStatusDone(notion: Client, taskPageId: string): Promise<void> {
  await notion.pages.update({
    page_id: taskPageId,
    properties: { Status: { status: { name: "Done" } } } as Parameters<
      Client["pages"]["update"]
    >[0]["properties"],
  });
}

/**
 * 解析单条 Task 为发信上下文：Task → IM（relation）→ Thread ID、From Email、Subject；IM → Touchpoint（relation）→ Sender Account。
 * 若缺少 relation 或 IM/Touchpoint 属性则抛错（明确错误信息）。
 */
export async function getReplyTaskSendContext(
  notion: Client,
  taskPageId: string,
): Promise<ReplyTaskSendContext> {
  const taskPage = await notion.pages.retrieve({ page_id: taskPageId });
  if (!("properties" in taskPage)) throw new Error("Task 页面无 properties");
  const taskProps = taskPage.properties as Record<string, unknown>;
  const imPageId = getRelationFirstId(taskProps[TASK_IM_RELATION_PROP]);
  if (!imPageId)
    throw new Error(`Task 未关联 Inbound Message（缺少 relation「${TASK_IM_RELATION_PROP}」）`);

  const suggestedReply = getRichText(taskProps["Suggested Reply"] ?? taskProps["Suggested reply"] ?? "");

  const imPage = await notion.pages.retrieve({ page_id: imPageId });
  if (!("properties" in imPage)) throw new Error("Inbound Message 页面无 properties");
  const imProps = imPage.properties as Record<string, unknown>;
  const threadId = getRichText(imProps["Thread ID"]).trim();
  const to = getEmailOrRichText(imProps["From Email"]).trim();
  const subjectRaw = getRichText(imProps["Subject"]).trim();
  const subject = subjectRaw.startsWith("Re:") ? subjectRaw : `Re: ${subjectRaw}`;
  const lastInboundBodyPlain = getRichText(imProps["Body Plain"] ?? "").trim() || undefined;
  const touchpointPageId = getRelationFirstId(imProps["Touchpoint"]);
  if (!touchpointPageId) throw new Error("Inbound Message 未关联 Touchpoint");
  if (!threadId) throw new Error("Inbound Message 缺少 Thread ID");

  const tpPage = await notion.pages.retrieve({ page_id: touchpointPageId });
  if (!("properties" in tpPage)) throw new Error("Touchpoint 页面无 properties");
  const tpProps = tpPage.properties as Record<string, unknown>;
  const senderAccount = getRichText(tpProps["Sender Account"]).trim();
  if (!senderAccount) throw new Error("Touchpoint 缺少 Sender Account");

  return { threadId, to, subject, senderAccount, suggestedReply, lastInboundBodyPlain };
}
