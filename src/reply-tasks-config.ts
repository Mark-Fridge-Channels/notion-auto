/**
 * Reply Tasks 配置：独立 JSON（reply-tasks.json），多条 Reply Tasks 库 URL + 发件人库 URL，当前选中索引。
 * 与 inbound-listener、schedule 完全独立；用于 Dashboard 切换库与发回复时取发件人凭据。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

/** 单条配置：一个 Reply Tasks 数据库 + 对应发件人库 */
export interface ReplyTasksEntry {
  /** RE Reply Tasks 数据库 ID 或 URL */
  reply_tasks_db_id: string;
  /** 发件人库 URL，用于按 Touchpoint 的 Sender Account 取 refresh_token */
  sender_accounts_database_url: string;
}

export interface ReplyTasksConfig {
  /** 配置条目列表 */
  entries: ReplyTasksEntry[];
  /** 当前选中的条目索引（0-based），用于切换与列表查询；-1 表示未选 */
  selected_index: number;
}

function validateEntry(e: unknown, index: number): asserts e is ReplyTasksEntry {
  if (e == null || typeof e !== "object") throw new Error(`entries[${index}] 必须为对象`);
  const o = e as Record<string, unknown>;
  if (typeof o.reply_tasks_db_id !== "string" || !o.reply_tasks_db_id.trim())
    throw new Error(`entries[${index}].reply_tasks_db_id 必须为非空字符串`);
  if (typeof o.sender_accounts_database_url !== "string" || !o.sender_accounts_database_url.trim())
    throw new Error(`entries[${index}].sender_accounts_database_url 必须为非空字符串`);
}

/**
 * 校验并归一化配置；校验失败抛错。
 * selected_index 超出范围时钳制为 -1 或 entries.length - 1。
 */
export function validateReplyTasksConfig(raw: unknown): ReplyTasksConfig {
  if (raw == null || typeof raw !== "object") throw new Error("配置必须为对象");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.entries)) throw new Error("entries 必须为数组");
  o.entries.forEach((e, i) => validateEntry(e, i));
  const entries = o.entries as ReplyTasksEntry[];
  let selected = typeof o.selected_index === "number" ? Math.floor(o.selected_index) : -1;
  if (entries.length === 0) selected = -1;
  else if (selected < 0 || selected >= entries.length) selected = -1;
  return { entries, selected_index: selected };
}

const DEFAULT_CONFIG_FILENAME = "reply-tasks.json";

/** 默认配置（无文件时 Dashboard 展示与保存用）：空列表，未选中 */
export function getDefaultReplyTasksConfig(): ReplyTasksConfig {
  return { entries: [], selected_index: -1 };
}

/** 默认配置文件路径（项目目录下）；env 为相对路径时限定在 cwd 内，否则退回默认 */
export function getReplyTasksConfigPath(): string {
  const fromEnv = process.env.REPLY_TASKS_CONFIG?.trim();
  if (!fromEnv) return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fromEnv.startsWith("/")) return fromEnv;
  const resolved = resolve(process.cwd(), fromEnv);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..") || rel.includes("..")) return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  return resolved;
}

/**
 * 从 JSON 文件加载 Reply Tasks 配置；路径可由 env REPLY_TASKS_CONFIG 或参数指定。
 * 文件不存在或解析失败抛错（无默认配置）。
 */
export async function loadReplyTasksConfig(filePath?: string): Promise<ReplyTasksConfig> {
  const path = filePath ?? getReplyTasksConfigPath();
  const raw = await readFile(path, "utf-8");
  const data = JSON.parse(raw) as unknown;
  return validateReplyTasksConfig(data);
}

/**
 * 加载配置；文件不存在时返回默认配置（空列表、selected_index=-1，供 Dashboard 展示与保存）。
 */
export async function loadReplyTasksConfigOrDefault(filePath?: string): Promise<ReplyTasksConfig> {
  try {
    return await loadReplyTasksConfig(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultReplyTasksConfig();
    }
    throw e;
  }
}

/**
 * 将配置写入 JSON 文件；路径默认 getReplyTasksConfigPath()。
 */
export async function saveReplyTasksConfig(
  config: ReplyTasksConfig,
  filePath?: string,
): Promise<void> {
  const path = filePath ?? getReplyTasksConfigPath();
  const validated = validateReplyTasksConfig(config);
  const json = JSON.stringify(
    { entries: validated.entries, selected_index: validated.selected_index },
    null,
    2,
  );
  await writeFile(path, json, "utf-8");
}
