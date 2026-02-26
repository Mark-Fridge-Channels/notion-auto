/**
 * 查看 Notion Queue 数据库里 API 实际返回的字段结构（便于对照 Email/Planned Send At 等类型）。
 *
 * 运行：npx tsx scripts/notion-queue-inspect.ts [Queue数据库URL]
 * 若不传 URL，则从环境变量 NOTION_QUEUE_DATABASE_URL 读取。
 * 需配置 NOTION_API_KEY，且 Integration 已加入该库的 Collaborators。
 * 遇网络类错误（如 TLS 断开）会自动重试 3 次。
 */

import "dotenv/config";
import { Client } from "@notionhq/client";
import { parseDatabaseId } from "../src/notion-queue.js";

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const MAX_NETWORK_RETRIES = 3;
const RETRY_DELAY_MS = 2500;

function isNetworkError(msg: string): boolean {
  return /socket disconnected|TLS|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|network/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
const dbUrl = process.argv[2]?.trim() || process.env.NOTION_QUEUE_DATABASE_URL?.trim();

function summarizePropValue(prop: unknown): unknown {
  if (prop == null || typeof prop !== "object") return prop;
  const o = prop as Record<string, unknown>;
  if ("rich_text" in o && Array.isArray(o.rich_text)) {
    const text = (o.rich_text as Array<{ plain_text?: string }>)
      .map((t) => t.plain_text ?? "")
      .join("");
    return { type: "rich_text", length: text.length, preview: text.slice(0, 80) + (text.length > 80 ? "…" : "") };
  }
  if ("email" in o && typeof o.email === "string")
    return { type: "email", value: o.email };
  if ("select" in o && o.select && typeof o.select === "object" && "name" in o.select)
    return { type: "select", name: (o.select as { name?: string }).name };
  if ("status" in o && o.status && typeof o.status === "object" && "name" in o.status)
    return { type: "status", name: (o.status as { name?: string }).name };
  if ("date" in o && o.date && typeof o.date === "object" && "start" in o.date)
    return { type: "date", start: (o.date as { start?: string }).start };
  if ("checkbox" in o)
    return { type: "checkbox", value: o.checkbox };
  if ("title" in o && Array.isArray(o.title))
    return { type: "title", length: (o.title as unknown[]).length, preview: JSON.stringify(o.title).slice(0, 60) + "…" };
  return { _keys: Object.keys(o) };
}

function main(): void {
  if (!NOTION_API_KEY?.trim()) {
    console.error("请设置环境变量 NOTION_API_KEY");
    process.exit(1);
  }
  if (!dbUrl) {
    console.error("用法: npx tsx scripts/notion-queue-inspect.ts <Queue数据库URL>");
    console.error("  或设置环境变量 NOTION_QUEUE_DATABASE_URL");
    process.exit(1);
  }

  const notion = new Client({ auth: NOTION_API_KEY });
  const databaseId = parseDatabaseId(dbUrl);
  const databaseIdWithHyphens =
    databaseId.length === 32
      ? `${databaseId.slice(0, 8)}-${databaseId.slice(8, 12)}-${databaseId.slice(12, 16)}-${databaseId.slice(16, 20)}-${databaseId.slice(20, 32)}`
      : databaseId;

  const KEYS = [
    "Email",
    "Email Status",
    "Email Subject",
    "Email Body",
    "Planned Send At",
    "Sender Account",
    "Sent At Last",
    "Message ID Last",
    "Thread ID",
  ];

  function printPages(res: Awaited<ReturnType<Client["databases"]["query"]>>, label = ""): void {
    console.log(`${label}Notion API 返回条数: ${res.results.length}`);
    console.log("");
    res.results.forEach((page, i) => {
      if (!("properties" in page)) return;
      const props = page.properties as Record<string, unknown>;
      console.log(`--- 第 ${i + 1} 条 page.id = ${page.id} ---`);
      KEYS.forEach((key) => {
        const summary = summarizePropValue(props[key]);
        console.log(`  ${key}:`, JSON.stringify(summary, null, 2).split("\n").join("\n  "));
      });
      console.log("  其他属性:", Object.keys(props).filter((k) => !KEYS.includes(k)).join(", "));
      console.log("");
    });
  }

  async function queryWithRetry(
    opts: Parameters<Client["databases"]["query"]>[0],
  ): Promise<Awaited<ReturnType<Client["databases"]["query"]>>> {
    for (let attempt = 1; attempt <= MAX_NETWORK_RETRIES; attempt++) {
      try {
        return await notion.databases.query(opts);
      } catch (e) {
        const msg = (e as { body?: { message?: string }; message?: string })?.body?.message ?? (e as Error)?.message ?? String(e);
        if (attempt < MAX_NETWORK_RETRIES && isNetworkError(msg)) {
          console.error(`Notion 请求网络异常，${RETRY_DELAY_MS / 1000} 秒后重试 (${attempt}/${MAX_NETWORK_RETRIES})…`);
          await sleep(RETRY_DELAY_MS);
        } else {
          throw e;
        }
      }
    }
    throw new Error("Unreachable");
  }

  (async () => {
    try {
      const res = await queryWithRetry({
        database_id: databaseIdWithHyphens,
        filter: { property: "Email Status", status: { equals: "Pending" } },
        page_size: 3,
      });
      printPages(res);
    } catch (e) {
      const msg = (e as { body?: { message?: string }; message?: string })?.body?.message ?? (e as Error)?.message ?? String(e);
      if (/filter.*select|property type|status/i.test(msg)) {
        try {
          const res = await queryWithRetry({
            database_id: databaseIdWithHyphens,
            filter: { property: "Email Status", select: { equals: "Pending" } },
            page_size: 3,
          });
          printPages(res, "(使用 select 过滤) ");
        } catch (err2) {
          const m2 = (err2 as { message?: string })?.message ?? String(err2);
          if (isNetworkError(m2)) console.error("提示：若在中国大陆，访问 api.notion.com 可能需要代理/VPN。");
          console.error("Notion API 错误:", m2);
          process.exit(1);
        }
      } else {
        if (isNetworkError(msg)) console.error("提示：若在中国大陆，访问 api.notion.com 可能需要代理/VPN。");
        console.error("Notion API 错误:", msg);
        process.exit(1);
      }
    }
  })();
}

main();
