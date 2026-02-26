/**
 * 测试发件人库（Notion）是否能被正确读取，用于排查「未找到发件人凭据」。
 *
 * 运行：npx tsx scripts/inspect-sender-accounts.ts <发件人库URL> [要匹配的SenderAccount]
 * 例：npx tsx scripts/inspect-sender-accounts.ts "https://notion.so/xxx" mark@fridgechannels.com
 * 若不传 URL，从环境变量 NOTION_SENDER_ACCOUNTS_DATABASE_URL 读取。
 * 需配置 NOTION_API_KEY，且 Integration 已加入该库的 Collaborators。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import {
  parseDatabaseId,
  fetchSenderCredentials,
} from "../src/notion-queue.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const MAX_NETWORK_RETRIES = 3;
const RETRY_DELAY_MS = 2500;

const senderDbUrl = process.argv[2]?.trim() || process.env.NOTION_SENDER_ACCOUNTS_DATABASE_URL?.trim();
const matchAccount = process.argv[3]?.trim();

function isNetworkError(msg: string): boolean {
  return /socket disconnected|TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getEmailFromProp(prop: unknown): string {
  if (prop && typeof prop === "object") {
    if ("email" in prop && typeof (prop as { email?: string }).email === "string")
      return (prop as { email: string }).email.trim();
    if ("rich_text" in prop && Array.isArray((prop as { rich_text: Array<{ plain_text?: string }> }).rich_text))
      return (prop as { rich_text: Array<{ plain_text?: string }> }).rich_text
        .map((t) => t.plain_text ?? "")
        .join("")
        .trim();
  }
  return "";
}

function getPasswordFromProp(prop: unknown): string {
  if (prop && typeof prop === "object" && "rich_text" in prop) {
    const arr = (prop as { rich_text: Array<{ plain_text?: string }> }).rich_text;
    if (Array.isArray(arr)) return arr.map((t) => t.plain_text ?? "").join("").trim();
  }
  return "";
}

async function queryWithRetry(
  notion: Client,
  databaseIdWithHyphens: string,
  filter?: Parameters<Client["databases"]["query"]>[0]["filter"],
): Promise<Awaited<ReturnType<Client["databases"]["query"]>>> {
  for (let attempt = 1; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    try {
      return await notion.databases.query({
        database_id: databaseIdWithHyphens,
        page_size: 100,
        ...(filter ? { filter } : {}),
      });
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (attempt < MAX_NETWORK_RETRIES && isNetworkError(msg)) {
        console.error(`请求网络异常，${RETRY_DELAY_MS / 1000} 秒后重试 (${attempt}/${MAX_NETWORK_RETRIES})…`);
        await sleep(RETRY_DELAY_MS);
      } else throw e;
    }
  }
  throw new Error("Unreachable");
}

async function main(): Promise<void> {
  if (!NOTION_API_KEY?.trim()) {
    console.error("请设置环境变量 NOTION_API_KEY");
    process.exit(1);
  }
  if (!senderDbUrl) {
    console.error("用法: npx tsx scripts/inspect-sender-accounts.ts <发件人库URL> [SenderAccount]");
    console.error("  或设置环境变量 NOTION_SENDER_ACCOUNTS_DATABASE_URL");
    process.exit(1);
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  const databaseId = parseDatabaseId(senderDbUrl);
  const databaseIdWithHyphens =
    databaseId.length === 32
      ? `${databaseId.slice(0, 8)}-${databaseId.slice(8, 12)}-${databaseId.slice(12, 16)}-${databaseId.slice(16, 20)}-${databaseId.slice(20, 32)}`
      : databaseId;

  console.log("发件人库 URL:", senderDbUrl);
  console.log("database_id:", databaseIdWithHyphens);
  if (matchAccount) console.log("要匹配的 Sender Account:", matchAccount);
  console.log("");

  const response = await queryWithRetry(notion, databaseIdWithHyphens);
  const results = response.results;
  console.log("Notion API 返回行数:", results.length);
  if (results.length === 0) {
    console.log("发件人库当前无数据，或 Integration 未加入该库 Collaborators。");
    process.exit(0);
  }

  console.log("");
  console.log("--- 逐行读取结果（password 仅显示是否有值，不打印内容）---");
  for (let i = 0; i < results.length; i++) {
    const page = results[i];
    if (!("properties" in page)) continue;
    const props = page.properties as Record<string, unknown>;
    const email = getEmailFromProp(props["Email"]) || getEmailFromProp(props["Email (1)"]);
    const password =
      getPasswordFromProp(props["password"]) || getPasswordFromProp(props["Password"]);
    const passwordStatus = password.length > 0 ? `有(${password.length} 字符)` : "空";
    console.log(`  第 ${i + 1} 条 page.id=${page.id}  Email=${email || "(空)"}  password=${passwordStatus}`);
  }

  console.log("");
  console.log("--- 第 1 条属性名与类型（便于核对列名）---");
  const first = results[0];
  if ("properties" in first) {
    const props = first.properties as Record<string, unknown>;
    const keys = Object.keys(props);
    keys.forEach((key) => {
      const p = props[key];
      const type =
        p && typeof p === "object"
          ? Object.keys(p as object).filter((k) => k !== "id").join(",")
          : "?";
      console.log(`  ${key}: ${type}`);
    });
  }

  if (matchAccount) {
    console.log("");
    console.log("--- 调用 fetchSenderCredentials 测试 ---");
    const creds = await fetchSenderCredentials(notion, senderDbUrl, matchAccount);
    if (creds) {
      console.log("  结果: 找到凭据");
      console.log("  email:", creds.email);
      console.log("  password: 有值(", creds.password.length, "字符，不打印)");
    } else {
      console.log("  结果: 未找到凭据（Email 或 password 未匹配/为空）");
    }
  }
}

main().catch((e) => {
  console.error("错误:", (e as Error)?.message ?? e);
  process.exit(1);
});
