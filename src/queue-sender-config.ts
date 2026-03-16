/**
 * Warmup Executor 配置：独立 JSON（queue-sender.json），每条配置对应一套 Warmup Notion 数据层。
 * 为兼容现有路径与 Dashboard 存储位置，仍沿用 queue-sender.json 文件名与加载函数名。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

const DEFAULT_BATCH_SIZE = 20;

/** 单条配置：一套 Warmup Notion 数据层 + 显示名 */
export interface WarmupExecutorEntry {
  /** 显示名，便于在列表中区分 */
  name: string;
  /** Email Warmup Queue 数据库 URL 或 database_id */
  queue_database_url: string;
  /** Warmup Account Credential Registry 数据库 URL */
  credential_registry_database_url: string;
  /** Execution Log 数据库 URL */
  execution_log_database_url: string;
  /** Warmup Conversation Event Log 数据库 URL */
  conversation_event_log_database_url: string;
  /** BandWidth Detail 数据库 URL */
  bandwidth_detail_database_url: string;
  /** Warmup Mailbox Pool 数据库 URL */
  warmup_mailbox_pool_database_url: string;
  /** 每批取条数，可选，默认 20 */
  batch_size?: number;
  /** Mail Automation Agent Add Contact 使用的默认通讯录 ID；可选，env MAIL_AUTOMATION_AGENT_DEFAULT_ADDRESS_BOOK_ID 优先 */
  mail_automation_agent_default_address_book_id?: string;
}

export interface WarmupExecutorConfig {
  /** 配置条目列表；每轮按顺序跑所有 */
  entries: WarmupExecutorEntry[];
}

export type QueueSenderEntry = WarmupExecutorEntry;
export type QueueSenderConfig = WarmupExecutorConfig;

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} 必须为非空字符串`);
  }
}

function validateEntry(e: unknown, index: number): asserts e is WarmupExecutorEntry {
  if (e == null || typeof e !== "object") throw new Error(`entries[${index}] 必须为对象`);
  const o = e as Record<string, unknown>;
  assertNonEmptyString(o.name, `entries[${index}].name`);
  assertNonEmptyString(o.queue_database_url, `entries[${index}].queue_database_url`);
  assertNonEmptyString(
    o.credential_registry_database_url,
    `entries[${index}].credential_registry_database_url`,
  );
  assertNonEmptyString(o.execution_log_database_url, `entries[${index}].execution_log_database_url`);
  assertNonEmptyString(
    o.conversation_event_log_database_url,
    `entries[${index}].conversation_event_log_database_url`,
  );
  assertNonEmptyString(o.bandwidth_detail_database_url, `entries[${index}].bandwidth_detail_database_url`);
  assertNonEmptyString(
    o.warmup_mailbox_pool_database_url,
    `entries[${index}].warmup_mailbox_pool_database_url`,
  );
  if (o.batch_size !== undefined) {
    const b = Number(o.batch_size);
    if (!Number.isInteger(b) || b < 1 || b > 100)
      throw new Error(`entries[${index}].batch_size 必须为 1–100 的整数`);
  }
  if (o.mail_automation_agent_default_address_book_id !== undefined) {
    if (typeof o.mail_automation_agent_default_address_book_id !== "string") {
      throw new Error(`entries[${index}].mail_automation_agent_default_address_book_id 必须为字符串`);
    }
  }
}

function migrateLegacyConfig(raw: unknown): QueueSenderConfig | null {
  if (raw == null || typeof raw !== "object") return null;
  const entriesRaw = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entriesRaw)) return null;
  const entries: WarmupExecutorEntry[] = [];
  for (let i = 0; i < entriesRaw.length; i++) {
    const entry = entriesRaw[i];
    if (entry == null || typeof entry !== "object") continue;
    const legacy = entry as Record<string, unknown>;
    entries.push({
      name: typeof legacy.name === "string" ? legacy.name.trim() : `未命名 ${i + 1}`,
      queue_database_url:
        typeof legacy.queue_database_url === "string" ? legacy.queue_database_url.trim() : "",
      credential_registry_database_url:
        typeof legacy.credential_registry_database_url === "string"
          ? legacy.credential_registry_database_url.trim()
          : typeof legacy.sender_accounts_database_url === "string"
            ? legacy.sender_accounts_database_url.trim()
            : "",
      execution_log_database_url:
        typeof legacy.execution_log_database_url === "string" ? legacy.execution_log_database_url.trim() : "",
      conversation_event_log_database_url:
        typeof legacy.conversation_event_log_database_url === "string"
          ? legacy.conversation_event_log_database_url.trim()
          : "",
      bandwidth_detail_database_url:
        typeof legacy.bandwidth_detail_database_url === "string" ? legacy.bandwidth_detail_database_url.trim() : "",
      warmup_mailbox_pool_database_url:
        typeof legacy.warmup_mailbox_pool_database_url === "string"
          ? legacy.warmup_mailbox_pool_database_url.trim()
          : "",
      batch_size:
        typeof legacy.batch_size === "number" && Number.isInteger(legacy.batch_size)
          ? legacy.batch_size
          : DEFAULT_BATCH_SIZE,
      mail_automation_agent_default_address_book_id:
        typeof legacy.mail_automation_agent_default_address_book_id === "string"
          ? legacy.mail_automation_agent_default_address_book_id.trim() || undefined
          : undefined,
    });
  }
  return { entries };
}

/**
 * 校验并归一化配置；校验失败抛错。
 * batch_size 缺省时填 DEFAULT_BATCH_SIZE。
 */
export function validateQueueSenderConfig(raw: unknown): QueueSenderConfig {
  if (raw == null || typeof raw !== "object") throw new Error("配置必须为对象");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.entries)) throw new Error("entries 必须为数组");
  const entries: WarmupExecutorEntry[] = [];
  for (let i = 0; i < (o.entries as unknown[]).length; i++) {
    validateEntry((o.entries as unknown[])[i], i);
    const e = (o.entries as WarmupExecutorEntry[])[i]!;
    const batch_size =
      e.batch_size !== undefined && Number.isInteger(e.batch_size) && e.batch_size >= 1 && e.batch_size <= 100
        ? e.batch_size
        : DEFAULT_BATCH_SIZE;
    entries.push({
      name: e.name.trim(),
      queue_database_url: e.queue_database_url.trim(),
      credential_registry_database_url: e.credential_registry_database_url.trim(),
      execution_log_database_url: e.execution_log_database_url.trim(),
      conversation_event_log_database_url: e.conversation_event_log_database_url.trim(),
      bandwidth_detail_database_url: e.bandwidth_detail_database_url.trim(),
      warmup_mailbox_pool_database_url: e.warmup_mailbox_pool_database_url.trim(),
      batch_size,
      mail_automation_agent_default_address_book_id:
        typeof e.mail_automation_agent_default_address_book_id === "string"
          ? e.mail_automation_agent_default_address_book_id.trim() || undefined
          : undefined,
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
  try {
    return validateQueueSenderConfig(data);
  } catch (error) {
    const migrated = migrateLegacyConfig(data);
    if (migrated) return migrated;
    throw error;
  }
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
        credential_registry_database_url: e.credential_registry_database_url,
        execution_log_database_url: e.execution_log_database_url,
        conversation_event_log_database_url: e.conversation_event_log_database_url,
        bandwidth_detail_database_url: e.bandwidth_detail_database_url,
        warmup_mailbox_pool_database_url: e.warmup_mailbox_pool_database_url,
        batch_size: e.batch_size ?? DEFAULT_BATCH_SIZE,
        ...(e.mail_automation_agent_default_address_book_id != null && {
          mail_automation_agent_default_address_book_id: e.mail_automation_agent_default_address_book_id,
        }),
      })),
    },
    null,
    2,
  );
  await writeFile(path, json, "utf-8");
}
