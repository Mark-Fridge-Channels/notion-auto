/**
 * 将单次任务运行结果写入 Notion「任务日志库」：与队列共用 NOTION_API_KEY；
 * 库地址来自 NOTION_RUN_LOG_DATABASE_URL。列名与库 schema 一致，写死在代码中。
 * 元数据写入属性；抽取的正文拆块写入页面子块（paragraph）。
 */

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client, extractDatabaseId } from "@notionhq/client";
import type { BlockObjectRequest, CreatePageParameters } from "@notionhq/client";
import { logger } from "./logger.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_RUN_LOG_DATABASE_URL = process.env.NOTION_RUN_LOG_DATABASE_URL;
const NOTION_AUTO_OWNER = process.env.Notion_AUTO_OWNER;

/** 与任务日志库 Property name 完全一致（区分大小写） */
const COL_TITLE = "title";
const COL_EXECUTE_TIME = "Execute Time";
const COL_COMPLETION_TIME = "Completion Time";
const COL_INPUT = "Input Content";
const COL_NOTION_URL = "Notion URL";
const COL_STATUS = "Status";
const COL_LLM_MODEL = "LLM Model";
const COL_OWNER = "Owner";
const STATUS_SUCCESS = "success";
const STATUS_FAILED = "failed";

/** Notion 单段 text.content 上限 */
const NOTION_TEXT_CHUNK = 2000;
/** blocks.children.append 单次最多子块数 */
const NOTION_APPEND_BATCH = 100;

/** Notion 富文本片段（与 API rich_text 项一致）；「Input Content」「LLM Model」在 API 中按 rich_text 写入 */
type TextRichTextItem = { type: "text"; text: { content: string } };

/** 与 typeAndSend 配合：首次点击发送时写入时间与当前页 URL */
export interface RunLogSendCapture {
  startedAtMs: number | null;
  notionUrlAtSend: string | null;
}

/** 需同时配置 NOTION_API_KEY 与 NOTION_RUN_LOG_DATABASE_URL（Integration 能访问该日志库） */
export function isRunLogEnabled(): boolean {
  return Boolean(
    typeof NOTION_API_KEY === "string" &&
      NOTION_API_KEY.trim() !== "" &&
      typeof NOTION_RUN_LOG_DATABASE_URL === "string" &&
      NOTION_RUN_LOG_DATABASE_URL.trim() !== "",
  );
}

function chunkString(s: string, maxLen: number): string[] {
  if (s.length === 0) return [""];
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += maxLen) {
    parts.push(s.slice(i, i + maxLen));
  }
  return parts;
}

function toRichTextItems(text: string): TextRichTextItem[] {
  return chunkString(text, NOTION_TEXT_CHUNK).map((content) => ({
    type: "text",
    text: { content },
  }));
}

function bodyToParagraphBlocks(body: string): BlockObjectRequest[] {
  return chunkString(body, NOTION_TEXT_CHUNK).map(
    (content): BlockObjectRequest => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content } }],
      },
    }),
  );
}

function buildLogPageTitle(input: string, finishedAtMs: number): string {
  const stamp = new Date(finishedAtMs).toISOString();
  const prefix = input.trim().slice(0, 80);
  const base = prefix || "(无输入)";
  return `${base} · ${stamp}`;
}

export interface AppendRunLogParams {
  startedAtMs: number | null;
  finishedAtMs: number;
  input: string;
  /** 首次点发送时的 page.url；未点到发送则为 null */
  notionUrlAtSend: string | null;
  success: boolean;
  extractedBody: string;
  /** 发送前从模型按钮读取的展示名，与当轮实际一致 */
  llmModel: string;
  /** 本地截图文件路径；无截图时为空 */
  failureScreenshotPath?: string;
}

/**
 * 创建日志库中的一条记录：属性 + 正文子块（分批 append）。
 */
export async function appendRunLogEntry(params: AppendRunLogParams): Promise<void> {
  const key = NOTION_API_KEY?.trim();
  const dbUrl = NOTION_RUN_LOG_DATABASE_URL?.trim();
  if (!key || !dbUrl) return;

  const {
    startedAtMs,
    finishedAtMs,
    input,
    notionUrlAtSend,
    success,
    extractedBody,
    llmModel,
    failureScreenshotPath,
  } = params;
  const databaseId = extractDatabaseId(dbUrl);
  if (!databaseId) {
    throw new Error(`无法从 NOTION_RUN_LOG_DATABASE_URL 解析 database_id: ${dbUrl}`);
  }

  const client = new Client({ auth: key });
  const title = buildLogPageTitle(input, finishedAtMs);

  const props: Record<string, unknown> = {
    [COL_TITLE]: {
      title: toRichTextItems(title.slice(0, NOTION_TEXT_CHUNK)),
    },
    [COL_COMPLETION_TIME]: {
      date: { start: new Date(finishedAtMs).toISOString() },
    },
    [COL_INPUT]: {
      rich_text: toRichTextItems(input),
    },
    [COL_NOTION_URL]: {
      url: notionUrlAtSend && notionUrlAtSend.trim() ? notionUrlAtSend.trim() : null,
    },
    [COL_STATUS]: {
      select: {
        name: success ? STATUS_SUCCESS : STATUS_FAILED,
      },
    },
    [COL_LLM_MODEL]: {
      rich_text: toRichTextItems(llmModel),
    },
  };

  // Owner 为 Person 列：从 .env 读取 Notion 用户 id，配置后写入对应用户。
  const ownerId = NOTION_AUTO_OWNER?.trim();
  if (ownerId) {
    props[COL_OWNER] = {
      people: [{ id: ownerId }],
    };
  }

  if (startedAtMs != null) {
    props[COL_EXECUTE_TIME] = {
      date: { start: new Date(startedAtMs).toISOString() },
    };
  }

  const response = await client.pages.create({
    parent: { database_id: databaseId },
    properties: props as CreatePageParameters["properties"],
  });

  const pageId = response.id;
  const blocks = bodyToParagraphBlocks(extractedBody);

  for (let i = 0; i < blocks.length; i += NOTION_APPEND_BATCH) {
    const batch = blocks.slice(i, i + NOTION_APPEND_BATCH);
    await client.blocks.children.append({
      block_id: pageId,
      children: batch,
    });
  }

  if (failureScreenshotPath) {
    const fileUpload = await uploadImageForNotion(client, failureScreenshotPath);
    const tailBlocks: BlockObjectRequest[] = [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "----- [SCREENSHOT] -----" } }],
        },
      },
      {
        object: "block",
        type: "image",
        image: {
          type: "file_upload",
          file_upload: { id: fileUpload.id },
        },
      } as BlockObjectRequest,
    ];
    await client.blocks.children.append({
      block_id: pageId,
      children: tailBlocks,
    });
  }

  logger.info(`已写入 Notion 任务日志 ${pageId}`);
}

async function uploadImageForNotion(client: Client, localPath: string): Promise<{ id: string }> {
  const filename = localPath.split("/").pop() || "failure.png";
  const bytes = await readFile(localPath);
  const blob = new Blob([bytes], { type: "image/png" });

  const created = await client.fileUploads.create({
    mode: "single_part",
    filename,
    content_type: "image/png",
  });
  const uploaded = await client.fileUploads.send({
    file_upload_id: created.id,
    file: { filename, data: blob },
  });
  return { id: uploaded.id };
}
