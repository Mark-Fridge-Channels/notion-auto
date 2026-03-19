/**
 * Notion 任务队列：通过 Notion API 读取待执行任务（Status=Queued）、执行后更新状态或删除。
 * 依赖环境变量 NOTION_API_KEY（Integration Token）。
 */

import "dotenv/config";
import { Client, extractDatabaseId } from "@notionhq/client";
import { logger } from "./logger.js";
import type { NotionQueueConfig } from "./schedule.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY;

/** 是否已配置 API Key 且队列配置有效（databaseUrl 非空） */
export function isQueueAvailable(config: NotionQueueConfig | undefined): boolean {
  return Boolean(
    typeof NOTION_API_KEY === "string" &&
      NOTION_API_KEY.trim() !== "" &&
      config?.databaseUrl?.trim(),
  );
}

/** 从队列取到的一条任务 */
export interface QueuedTask {
  pageId: string;
  actionName: string;
  fileUrl: string;
}

/**
 * 从 database URL 解析 database_id；再通过 databases.retrieve 取 data_sources[0].id 作为 data_source_id。
 */
async function getDataSourceId(client: Client, databaseUrl: string): Promise<string> {
  const databaseId = extractDatabaseId(databaseUrl);
  if (!databaseId) {
    throw new Error(`无法从 database URL 解析 database_id: ${databaseUrl}`);
  }
  const db = await client.databases.retrieve({ database_id: databaseId });
  if (!("data_sources" in db) || !Array.isArray(db.data_sources) || db.data_sources.length === 0) {
    throw new Error("该数据库未包含 data source，请确认 Notion 工作区与 API 版本");
  }
  const first = db.data_sources[0];
  if (!first?.id) {
    throw new Error("data_sources[0].id 为空");
  }
  return first.id;
}

/**
 * 从 data source 的 properties 中按「列名」找到对应的 property id。
 */
function findPropertyIdByName(
  properties: Record<string, { id?: string; name?: string }>,
  columnName: string,
): string | null {
  const name = columnName.trim();
  for (const [id, prop] of Object.entries(properties)) {
    if (prop?.name === name) return id;
    if (id === name) return id;
  }
  return null;
}

/** Status 列在 Notion 中的类型：Select（单选下拉）或 Status（看板状态列），API 的 filter/update 格式不同 */
export type StatusColumnType = "select" | "status";

/** 解析结果：batchPhaseId 为空表示未配置或列不存在，不启用批次排序 */
interface ResolvedPropertyIds {
  actionNameId: string;
  fileUrlId: string;
  statusId: string;
  statusColumnType: StatusColumnType;
  /** Batch Phase 列 id（Number）；空表示不按批次排序 */
  batchPhaseId: string | null;
}

/**
 * 从 data source schema 解析出 Action Name / File URL / Status 的 property id，以及 Status 列的类型。
 * 若配置了 columnBatchPhase 且数据源中存在该列，则返回 batchPhaseId，用于按批次排序（有值优先、升序，无值排最后）。
 */
async function resolvePropertyIds(
  client: Client,
  dataSourceId: string,
  config: NotionQueueConfig,
): Promise<ResolvedPropertyIds> {
  const ds = await client.dataSources.retrieve({ data_source_id: dataSourceId });
  const properties = ("properties" in ds && ds.properties) || {};
  const actionNameId = findPropertyIdByName(properties, config.columnActionName);
  const fileUrlId = findPropertyIdByName(properties, config.columnFileUrl);
  const statusId = findPropertyIdByName(properties, config.columnStatus);
  if (!actionNameId) {
    throw new Error(`未找到列「${config.columnActionName}」，请检查队列配置中的列名`);
  }
  if (!fileUrlId) {
    throw new Error(`未找到列「${config.columnFileUrl}」，请检查队列配置中的列名`);
  }
  if (!statusId) {
    throw new Error(`未找到列「${config.columnStatus}」，请检查队列配置中的列名`);
  }
  const statusProp = properties[statusId] as { type?: string } | undefined;
  const statusColumnType: StatusColumnType =
    statusProp?.type === "status" ? "status" : "select";
  const columnBatchPhase = (config.columnBatchPhase ?? "").trim();
  let batchPhaseId: string | null = null;
  if (columnBatchPhase) {
    batchPhaseId = findPropertyIdByName(properties, columnBatchPhase);
    if (!batchPhaseId) {
      logger.warn(`未找到列「${columnBatchPhase}」，队列将按创建时间排序`);
    }
  }
  return { actionNameId, fileUrlId, statusId, statusColumnType, batchPhaseId };
}

/**
 * 从 page 的 properties 中读取 rich_text 的纯文本（Action Name 列）。
 */
function getRichTextPlain(pageProps: Record<string, unknown>, propId: string): string {
  const prop = pageProps[propId];
  if (prop == null || typeof prop !== "object") return "";
  const p = prop as Record<string, unknown>;
  if (p.type === "rich_text" && Array.isArray(p.rich_text)) {
    return (p.rich_text as Array<{ plain_text?: string }>)
      .map((t) => t.plain_text ?? "")
      .join("");
  }
  return "";
}

/**
 * 从 page 的 properties 中读取 url（File URL 列）。
 */
function getUrl(pageProps: Record<string, unknown>, propId: string): string {
  const prop = pageProps[propId];
  if (prop == null || typeof prop !== "object") return "";
  const p = prop as Record<string, unknown>;
  if (p.type === "url" && typeof p.url === "string") return p.url;
  return "";
}

/**
 * 从 page 的 properties 中读取 number（Batch Phase 列）；空或非数字返回 null。
 */
function getNumber(pageProps: Record<string, unknown>, propId: string): number | null {
  const prop = pageProps[propId];
  if (prop == null || typeof prop !== "object") return null;
  const p = prop as Record<string, unknown>;
  if (p.type !== "number") return null;
  const v = p.number;
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 单条候选任务：用于本地按 batch_phase + created_time 排序后取第一条 */
interface QueuedCandidate {
  pageId: string;
  properties: Record<string, unknown>;
  createdTime: string;
  batchPhase: number | null;
}

/**
 * 按约定排序：有 batch_phase 的优先且按值升序，同 phase 内按 created_time 升序；无 batch_phase 的排最后、按 created_time 升序。
 */
function compareCandidates(a: QueuedCandidate, b: QueuedCandidate): number {
  const aHas = a.batchPhase !== null;
  const bHas = b.batchPhase !== null;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (aHas && bHas) {
    if (a.batchPhase! !== b.batchPhase!) return a.batchPhase! - b.batchPhase!;
  }
  return a.createdTime.localeCompare(b.createdTime);
}

/** 拉取候选任务时每页条数；用于本地按 batch_phase + created_time 排序后取第一条 */
const QUEUE_FETCH_PAGE_SIZE = 50;

/** 缺失 created_time 时的兜底值，保证在排序中排到最后 */
const FALLBACK_CREATED_TIME = "9999-12-31T23:59:59.999Z";

/**
 * 拉取一条 Status = config.statusQueued 的任务；无则返回 null。
 * 若配置了 columnBatchPhase 且数据源存在该列：先取一批候选（按 created_time 升序），再按「有 batch_phase 优先、batch_phase 升序、created_time 升序」本地排序后取第一条；无 batch_phase 的记录排最后。
 * 未配置或列不存在时，仅按 created_time 升序取第一条（与原有行为一致）。
 */
export async function fetchOneQueuedTask(
  config: NotionQueueConfig,
): Promise<QueuedTask | null> {
  if (!NOTION_API_KEY?.trim()) {
    logger.warn("未配置 NOTION_API_KEY，跳过 Notion 队列");
    return null;
  }
  const client = new Client({ auth: NOTION_API_KEY });
  try {
    const dataSourceId = await getDataSourceId(client, config.databaseUrl);
    const { actionNameId, fileUrlId, statusId, statusColumnType, batchPhaseId } =
      await resolvePropertyIds(client, dataSourceId, config);
    const statusFilter =
      statusColumnType === "status"
        ? { property: statusId, status: { equals: config.statusQueued } }
        : { property: statusId, select: { equals: config.statusQueued } };

    const pageSize = batchPhaseId ? QUEUE_FETCH_PAGE_SIZE : 1;
    const response = await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: statusFilter,
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: pageSize,
      result_type: "page",
    });
    const results = response.results ?? [];
    if (results.length === 0) return null;

    let chosenPage: { id: string; properties: Record<string, unknown> } | null = null;
    if (batchPhaseId && results.length > 0) {
      const candidates: QueuedCandidate[] = [];
      for (const page of results) {
        if (!page || !("id" in page)) continue;
        const props =
          "properties" in page ? (page.properties as Record<string, unknown>) : {};
        const createdTime =
          "created_time" in page && typeof (page as { created_time?: string }).created_time === "string"
            ? (page as { created_time: string }).created_time
            : FALLBACK_CREATED_TIME;
        const batchPhase = getNumber(props, batchPhaseId);
        candidates.push({
          pageId: page.id,
          properties: props,
          createdTime,
          batchPhase,
        });
      }
      candidates.sort(compareCandidates);
      // 按排序顺序取第一条 File URL 非空的候选，避免首条无 URL 时队列卡死
      for (const c of candidates) {
        let props = c.properties;
        if (Object.keys(props).length === 0) {
          const fullPage = await client.pages.retrieve({ page_id: c.pageId });
          props =
            "properties" in fullPage
              ? (fullPage.properties as Record<string, unknown>)
              : {};
        }
        if (getUrl(props, fileUrlId).trim()) {
          chosenPage = { id: c.pageId, properties: props };
          break;
        }
        logger.warn(`队列任务 ${c.pageId} 的 File URL 为空，跳过`);
      }
    } else {
      const page = results[0];
      if (page && "id" in page) {
        let props: Record<string, unknown> =
          "properties" in page ? (page.properties as Record<string, unknown>) : {};
        if (Object.keys(props).length === 0) {
          const fullPage = await client.pages.retrieve({ page_id: page.id });
          props =
            "properties" in fullPage
              ? (fullPage.properties as Record<string, unknown>)
              : {};
        }
        chosenPage = { id: page.id, properties: props };
      }
    }

    if (!chosenPage) return null;
    const { id: pageId, properties } = chosenPage;
    if (Object.keys(properties).length === 0) {
      const fullPage = await client.pages.retrieve({ page_id: pageId });
      chosenPage.properties =
        "properties" in fullPage
          ? (fullPage.properties as Record<string, unknown>)
          : {};
    }
    const actionName = getRichTextPlain(chosenPage.properties, actionNameId).trim();
    const fileUrl = getUrl(chosenPage.properties, fileUrlId).trim();
    if (!fileUrl) {
      logger.warn(`队列任务 ${pageId} 的 File URL 为空，跳过`);
      return null;
    }
    return { pageId, actionName, fileUrl };
  } catch (e) {
    logger.warn("fetchOneQueuedTask 失败", e);
    return null;
  }
}

/**
 * 将任务标记为完成：按 config.onSuccess 更新 Status 为 statusDone 或删除该页。
 */
export async function markTaskDone(
  config: NotionQueueConfig,
  pageId: string,
): Promise<void> {
  if (!NOTION_API_KEY?.trim()) return;
  const client = new Client({ auth: NOTION_API_KEY });
  try {
    if (config.onSuccess === "delete") {
      await client.pages.update({ page_id: pageId, in_trash: true });
      logger.info(`队列任务 ${pageId} 已删除（完成）`);
    } else {
      const dataSourceId = await getDataSourceId(client, config.databaseUrl);
      const { statusId, statusColumnType } = await resolvePropertyIds(client, dataSourceId, config);
      const statusUpdate =
        statusColumnType === "status"
          ? { [statusId]: { status: { name: config.statusDone } } }
          : { [statusId]: { select: { name: config.statusDone } } };
      await client.pages.update({
        page_id: pageId,
        properties: statusUpdate,
      });
      logger.info(`队列任务 ${pageId} 已更新为 ${config.statusDone}`);
    }
  } catch (e) {
    logger.warn("markTaskDone 失败", e);
    throw e;
  }
}

/**
 * 将任务标记为失败：更新 Status 为 config.statusFailed。
 */
export async function markTaskFailed(
  config: NotionQueueConfig,
  pageId: string,
): Promise<void> {
  if (!NOTION_API_KEY?.trim()) return;
  const client = new Client({ auth: NOTION_API_KEY });
  try {
    const dataSourceId = await getDataSourceId(client, config.databaseUrl);
    const { statusId, statusColumnType } = await resolvePropertyIds(client, dataSourceId, config);
    const statusUpdate =
      statusColumnType === "status"
        ? { [statusId]: { status: { name: config.statusFailed } } }
        : { [statusId]: { select: { name: config.statusFailed } } };
    await client.pages.update({
      page_id: pageId,
      properties: statusUpdate,
    });
    logger.info(`队列任务 ${pageId} 已更新为 ${config.statusFailed}`);
  } catch (e) {
    logger.warn("markTaskFailed 失败", e);
    throw e;
  }
}
