/**
 * Inbound Listener 配置：独立 JSON（inbound-listener.json），多组，每组 IM DB、Touchpoints DB、发件人库 URL、mailboxes[]。
 * 与 schedule 完全独立；Notion 统一用 env NOTION_API_KEY。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";

/** 单组配置：对应一套 Notion IM 表 + Touchpoints 表 + 发件人库 + 监听的邮箱列表 */
export interface InboundListenerGroup {
  /** 📥 RE Inbound Messages 数据库 ID 或 URL */
  inbound_messages_db_id: string;
  /** 📬 Touchpoints（与 Queue 表同一张）数据库 ID 或 URL */
  touchpoints_db_id: string;
  /** 发件人库 URL，用于按 mailboxes[] 中的 Email 取 refresh_token */
  sender_accounts_database_url: string;
  /** 该组监听的收件箱，每项为发件人库的 Email */
  mailboxes: string[];
}

export interface InboundListenerConfig {
  /** 多组，按顺序参与路由（先命中唯一 Touchpoint 的 group 写入其 IM 表） */
  groups: InboundListenerGroup[];
  /** 轮询间隔（秒），默认 120 */
  poll_interval_seconds?: number;
  /** Body Plain 最大字符数，超长保留开头+结尾；默认 40000 */
  body_plain_max_chars?: number;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 120;
const DEFAULT_BODY_PLAIN_MAX_CHARS = 40_000;

function validateGroup(g: unknown, index: number): asserts g is InboundListenerGroup {
  if (g == null || typeof g !== "object") throw new Error(`groups[${index}] 必须为对象`);
  const o = g as Record<string, unknown>;
  if (typeof o.inbound_messages_db_id !== "string" || !o.inbound_messages_db_id.trim())
    throw new Error(`groups[${index}].inbound_messages_db_id 必须为非空字符串`);
  if (typeof o.touchpoints_db_id !== "string" || !o.touchpoints_db_id.trim())
    throw new Error(`groups[${index}].touchpoints_db_id 必须为非空字符串`);
  if (typeof o.sender_accounts_database_url !== "string" || !o.sender_accounts_database_url.trim())
    throw new Error(`groups[${index}].sender_accounts_database_url 必须为非空字符串`);
  if (!Array.isArray(o.mailboxes))
    throw new Error(`groups[${index}].mailboxes 必须为数组`);
  o.mailboxes.forEach((m, i) => {
    if (typeof m !== "string" || !m.trim())
      throw new Error(`groups[${index}].mailboxes[${i}] 必须为非空字符串（发件人库 Email）`);
  });
}

/**
 * 校验并归一化配置；校验失败抛错。
 */
export function validateInboundListenerConfig(raw: unknown): InboundListenerConfig {
  if (raw == null || typeof raw !== "object") throw new Error("配置必须为对象");
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.groups) || o.groups.length === 0)
    throw new Error("groups 必须为非空数组");
  o.groups.forEach((g, i) => validateGroup(g, i));
  const pollSec = o.poll_interval_seconds !== undefined ? Number(o.poll_interval_seconds) : DEFAULT_POLL_INTERVAL_SECONDS;
  const bodyMax = o.body_plain_max_chars !== undefined ? Number(o.body_plain_max_chars) : DEFAULT_BODY_PLAIN_MAX_CHARS;
  if (!Number.isInteger(pollSec) || pollSec < 10)
    throw new Error("poll_interval_seconds 必须为不小于 10 的整数");
  if (!Number.isInteger(bodyMax) || bodyMax < 1000)
    throw new Error("body_plain_max_chars 必须为不小于 1000 的整数");
  return {
    groups: o.groups as InboundListenerGroup[],
    poll_interval_seconds: pollSec,
    body_plain_max_chars: bodyMax,
  };
}

const DEFAULT_CONFIG_FILENAME = "inbound-listener.json";

/** 默认配置（无文件时 Dashboard 展示与保存用） */
export function getDefaultInboundListenerConfig(): InboundListenerConfig {
  return {
    groups: [
      {
        inbound_messages_db_id: "",
        touchpoints_db_id: "",
        sender_accounts_database_url: "",
        mailboxes: [],
      },
    ],
    poll_interval_seconds: DEFAULT_POLL_INTERVAL_SECONDS,
    body_plain_max_chars: DEFAULT_BODY_PLAIN_MAX_CHARS,
  };
}

/** 默认配置文件路径（项目目录下）；env 为相对路径时限定在 cwd 内，否则退回默认 */
export function getInboundListenerConfigPath(): string {
  const fromEnv = process.env.INBOUND_LISTENER_CONFIG?.trim();
  if (!fromEnv) return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  if (fromEnv.startsWith("/")) return fromEnv;
  const resolved = resolve(process.cwd(), fromEnv);
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..") || rel.includes("..")) return join(process.cwd(), DEFAULT_CONFIG_FILENAME);
  return resolved;
}

/**
 * 从 JSON 文件加载 Inbound Listener 配置；路径可由 env INBOUND_LISTENER_CONFIG 或参数指定。
 * 文件不存在或解析失败抛错（无默认配置）。
 */
export async function loadInboundListenerConfig(filePath?: string): Promise<InboundListenerConfig> {
  const path = filePath ?? getInboundListenerConfigPath();
  const raw = await readFile(path, "utf-8");
  const data = JSON.parse(raw) as unknown;
  return validateInboundListenerConfig(data);
}

/**
 * 加载配置；文件不存在时返回默认配置（供 Dashboard 展示与保存）。
 */
export async function loadInboundListenerConfigOrDefault(filePath?: string): Promise<InboundListenerConfig> {
  try {
    return await loadInboundListenerConfig(filePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultInboundListenerConfig();
    }
    throw e;
  }
}

/**
 * 将配置写入 JSON 文件；路径默认 getInboundListenerConfigPath()。
 */
export async function saveInboundListenerConfig(
  config: InboundListenerConfig,
  filePath?: string,
): Promise<void> {
  const path = filePath ?? getInboundListenerConfigPath();
  const validated = validateInboundListenerConfig(config);
  const json = JSON.stringify(
    {
      groups: validated.groups,
      poll_interval_seconds: validated.poll_interval_seconds,
      body_plain_max_chars: validated.body_plain_max_chars,
    },
    null,
    2,
  );
  await writeFile(path, json, "utf-8");
}
