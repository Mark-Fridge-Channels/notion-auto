/**
 * 检查 Warmup Credential Registry 中每条凭据的配置是否满足当前执行器要求。
 * 输出：可运行 / 需补配置，以及缺项说明（platform、refresh_token、auth_config_json 及 SMTP 子块）。
 *
 * 运行：npx tsx scripts/check-warmup-credentials.ts
 * 需配置 NOTION_API_KEY；配置文件由 QUEUE_SENDER_CONFIG 或默认 queue-sender.json 指定。
 * Integration 需已加入各 Credential Registry 数据库的 Collaborators。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import { parseDatabaseId } from "../src/notion-warmup.js";
import {
  loadQueueSenderConfigOrDefault,
  getQueueSenderConfigPath,
  type WarmupExecutorEntry,
} from "../src/queue-sender-config.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY;

function getPlainText(prop: unknown): string {
  if (prop && typeof prop === "object") {
    if ("title" in prop) {
      const arr = (prop as { title?: Array<{ plain_text?: string }> }).title;
      if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("").trim();
    }
    if ("rich_text" in prop) {
      const arr = (prop as { rich_text?: Array<{ plain_text?: string }> }).rich_text;
      if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("").trim();
    }
  }
  return "";
}

function getSelectName(prop: unknown): string {
  if (prop && typeof prop === "object" && "select" in prop) {
    return (prop as { select?: { name?: string } }).select?.name?.trim() ?? "";
  }
  if (prop && typeof prop === "object" && "status" in prop) {
    return (prop as { status?: { name?: string } }).status?.name?.trim() ?? "";
  }
  return getPlainText(prop);
}

function getCheckbox(prop: unknown): boolean {
  if (prop && typeof prop === "object" && "checkbox" in prop) {
    return Boolean((prop as { checkbox?: boolean }).checkbox);
  }
  return false;
}

function toNotionDbId(urlOrId: string): string {
  const id = parseDatabaseId(urlOrId);
  if (id.length === 32 && !id.includes("-")) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20, 32)}`;
  }
  return id;
}

function parseAuthConfigJson(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isSmtpPlatform(platform: string): boolean {
  const n = platform.trim().toLowerCase();
  return n === "smtp" || n === "imap" || n === "smtp+imap";
}

interface CredentialRow {
  account: string;
  mailboxId: string;
  platform: string;
  hasRefreshToken: boolean;
  hasAuthConfigJson: boolean;
  executorEnabled: boolean;
  authConfig?: Record<string, unknown>;
}

function analyzeRow(props: Record<string, unknown>): CredentialRow {
  const account = getPlainText(props["account"]);
  const mailboxId = getPlainText(props["mailbox_id"]);
  const platform = getSelectName(props["platform"]);
  const refreshToken = getPlainText(props["refresh_token"]);
  const authConfigJson = getPlainText(props["auth_config_json"]);
  const executorEnabled = getCheckbox(props["executor_enabled"]);
  const authConfig = authConfigJson ? parseAuthConfigJson(authConfigJson) : undefined;
  return {
    account,
    mailboxId,
    platform,
    hasRefreshToken: refreshToken.length > 0,
    hasAuthConfigJson: authConfigJson.length > 0,
    executorEnabled,
    authConfig,
  };
}

function statusAndNotes(row: CredentialRow): { status: "可运行" | "需补配置"; notes: string[] } {
  const notes: string[] = [];
  const platform = row.platform.trim();
  const isSmtp = isSmtpPlatform(platform);

  if (!platform) {
    notes.push("缺 platform（需为 Gmail / Zoho / Microsoft 365 / SMTP）");
    return { status: "需补配置", notes };
  }

  if (isSmtp) {
    if (!row.hasAuthConfigJson) {
      notes.push("SMTP 需在 auth_config_json 中至少配置 smtp（Send/Reply）");
      return { status: "需补配置", notes };
    }
    const ac = row.authConfig ?? {};
    const hasSmtp = ac.smtp != null && typeof ac.smtp === "object";
    const hasImap = ac.imap != null && typeof ac.imap === "object";
    const hasContacts = ac.contacts != null && typeof ac.contacts === "object";
    if (!hasSmtp) notes.push("auth_config_json 缺 smtp → Send/Reply 不可用");
    if (!hasImap) notes.push("auth_config_json 缺 imap → Open/Star 不可用");
    if (!hasContacts) notes.push("auth_config_json 缺 contacts → Add Contact 不可用");
    return {
      status: hasSmtp ? "可运行" : "需补配置",
      notes: notes.length ? notes : ["Send/Reply 可用；缺 imap/contacts 时 Open/Star/Add Contact 会失败"],
    };
  }

  // Gmail / Zoho / Microsoft 365
  if (!row.hasRefreshToken) {
    notes.push("缺 refresh_token（OAuth2 刷新令牌）");
    return { status: "需补配置", notes };
  }
  return { status: "可运行", notes: ["需确认对应 env 与 API scope 已配置"] };
}

async function main(): Promise<void> {
  if (!NOTION_API_KEY?.trim()) {
    console.error("请设置环境变量 NOTION_API_KEY");
    process.exit(1);
  }

  const configPath = getQueueSenderConfigPath();
  let config;
  try {
    config = await loadQueueSenderConfigOrDefault();
  } catch (e) {
    console.error("加载配置失败:", (e as Error)?.message ?? e);
    console.error("配置文件路径:", configPath);
    process.exit(1);
  }

  if (!config.entries?.length) {
    console.log("当前无 Queue Sender 配置条目（queue-sender.json entries 为空）。");
    process.exit(0);
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  console.log("配置文件:", configPath);
  console.log("");

  for (const entry of config.entries as WarmupExecutorEntry[]) {
    const registryUrl = entry.credential_registry_database_url;
    console.log("---", entry.name, "---");
    console.log("Credential Registry:", registryUrl);

    let databaseIdWithHyphens: string;
    try {
      databaseIdWithHyphens = toNotionDbId(registryUrl);
    } catch (e) {
      console.error("  无法解析 database_id:", (e as Error)?.message ?? e);
      console.log("");
      continue;
    }

    let results: Array<{ id: string; properties: Record<string, unknown> }>;
    try {
      const response = await notion.databases.query({
        database_id: databaseIdWithHyphens,
        page_size: 100,
      });
      results = response.results.filter(
        (p): p is { id: string; properties: Record<string, unknown> } => "properties" in p,
      ) as Array<{ id: string; properties: Record<string, unknown> }>;
    } catch (e) {
      console.error("  查询 Notion 失败:", (e as Error)?.message ?? e);
      console.log("");
      continue;
    }

    if (results.length === 0) {
      console.log("  凭据条数: 0（库为空或 Integration 未加入 Collaborators）");
      console.log("");
      continue;
    }

    console.log("  凭据条数:", results.length);
    for (const page of results) {
      const row = analyzeRow(page.properties);
      const id = row.account || row.mailboxId || page.id.slice(0, 8);
      const { status, notes } = statusAndNotes(row);
      const enabledTag = row.executorEnabled ? "" : " [executor_enabled=关]";
      console.log(`  - ${id} | platform=${row.platform || "(空)"} | ${status}${enabledTag}`);
      notes.forEach((n) => console.log(`      → ${n}`));
    }
    console.log("");
  }

  console.log("说明：可运行 = 至少能执行 Send/Reply；缺 imap/contacts 时 Open/Star/Add Contact 会失败并回写 Queue。");
}

main().catch((e) => {
  console.error("错误:", (e as Error)?.message ?? e);
  process.exit(1);
});
