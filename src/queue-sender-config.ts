/**
 * Queue Sender 配置：独立 JSON（queue-sender.json），多条 Queue 库 + 发件人库，每轮跑所有。
 * 与 schedule 完全独立；Queue Sender 进程只读本配置，不再依赖 schedule 的 queue 行业。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

const DEFAULT_BATCH_SIZE = 20;

/** 单条配置：一个 Queue 数据库 + 对应发件人库 + 显示名 */
export interface QueueSenderEntry {
  /** 显示名，便于在列表中区分 */
  name: string;
  /** Queue 数据库 URL 或 database_id */
  queue_database_url: string;
  /** 发件人库 URL，用于按 Sender Account 取凭据 */
  sender_accounts_database_url: string;
  /** 每批取条数，可选，默认 20 */
  batch_size?: number;
}

export interface QueueSenderConfig {
  /** 配置条目列表；每轮按顺序跑所有 */
  entries: QueueSenderEntry[];
}

function validateEntry(e: unknown, index: number): asserts e is QueueSenderEntry {
  if (e == null || typeof e !== "object") throw new Error(`entries[${index}] 必须为对象`);
  const o = e as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim())
    throw new Error(`entries[${index}].name 必须为非空字符串`);
  if (typeof o.queue_database_url !== "string" || !o.queue_database_url.trim())
    throw new Error(`entries[${index}].queue_database_url 必须为非空字符串`);
  if (typeof o.sender_accounts_database_url !== "string" || !o.sender_accounts_database_url.trim())
    throw new Error(`entries[${index}].sender_accounts_database_url 必须为非空字符串`);
  if (o.batch_size !== undefined) {
    const b = Number(o.batch_size);
    if (!Number.isInteger(b) || b < 1 || b > 100)
      throw new Error(`entries[${index}].batch_size 必须为 1–100 的整数`);
  }
}

/**
 * 校验并归一化配置；校验失败抛错。
 * batch_size 缺省时填 DEFAULT_BATCH_SIZE。
 */
export function validateQueueSenderConfig(raw: unknown): QueueSenderConfig {
  if (raw == null || typeof raw !== "object") throw new Error("配置必须为对象");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.entries)) throw new Error("entries 必须为数组");
  const entries: QueueSenderEntry[] = [];
  for (let i = 0; i < (o.entries as unknown[]).length; i++) {
    validateEntry((o.entries as unknown[])[i], i);
    const e = (o.entries as QueueSenderEntry[])[i]!;
    const batch_size =
      e.batch_size !== undefined && Number.isInteger(e.batch_size) && e.batch_size >= 1 && e.batch_size <= 100
        ? e.batch_size
        : DEFAULT_BATCH_SIZE;
    entries.push({
      name: e.name.trim(),
      queue_database_url: e.queue_database_url.trim(),
      sender_accounts_database_url: e.sender_accounts_database_url.trim(),
      batch_size,
    });
  }
  return { entries };
}

const DEFAULT_CONFIG_FILENAME = "queue-sender.json";

/** 默认配置（无文件时 Dashboard 展示与保存用）：空列表 */
export function getDefaultQueueSenderConfig(): QueueSenderConfig {
  return { entries: [] };
}

/** 默认配置文件路径（项目目录下）；env 为相对路径时限定在 cwd 内，否则退回默认 */
export function getQueueSenderConfigPath(): string {
  const fromEnv = process.env.QUEUE_SENDER_CONFIG?.trim();
  if (!fromEnv) return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fromEnv.startsWith("/")) return fromEnv;
  const resolved = resolve(process.cwd(), fromEnv);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..") || rel.includes("..")) return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  return resolved;
}

/**
 * 从 JSON 文件加载 Queue Sender 配置；路径可由 env QUEUE_SENDER_CONFIG 或参数指定。
 * 文件不存在或解析失败抛错（无默认配置）。
 */
export async function loadQueueSenderConfig(filePath?: string): Promise<QueueSenderConfig> {
  const path = filePath ?? getQueueSenderConfigPath();
  const raw = await readFile(path, "utf-8");
  const data = JSON.parse(raw) as unknown;
  return validateQueueSenderConfig(data);
}

/**
 * 加载配置；文件不存在时返回默认配置（空列表，供 Dashboard 展示与保存）。
 */
export async function loadQueueSenderConfigOrDefault(filePath?: string): Promise<QueueSenderConfig> {
  try {
    return await loadQueueSenderConfig(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultQueueSenderConfig();
    }
    throw e;
  }
}

/**
 * 将配置写入 JSON 文件；路径默认 getQueueSenderConfigPath()。
 */
export async function saveQueueSenderConfig(
  config: QueueSenderConfig,
  filePath?: string,
): Promise<void> {
  const path = filePath ?? getQueueSenderConfigPath();
  const validated = validateQueueSenderConfig(config);
  const json = JSON.stringify(
    {
      entries: validated.entries.map((e) => ({
        name: e.name,
        queue_database_url: e.queue_database_url,
        sender_accounts_database_url: e.sender_accounts_database_url,
        batch_size: e.batch_size ?? DEFAULT_BATCH_SIZE,
      })),
    },
    null,
    2,
  );
  await writeFile(path, json, "utf-8");
}
