#!/usr/bin/env node
/**
 * 一次性把所有账号的 `.notion-auth.json` 瘦身为 cookies-only：
 *   { cookies: [...], origins: [] }
 *
 * 背景：Notion 前端会把 block / queryCache / 用户设置等塞进 localStorage，
 * Playwright 的 `storageState` 连 localStorage 一起落盘，文件随运行时间
 * 单调增长（本仓库见过单账号 ~1MB / 3900+ 条）。每次 newContext 时这些
 * 条目会被注入回 Chromium，Notion 启动瞬间 rehydrate 大量 JS 堆，
 * 直接导致「一启动内存就被打满」。
 *
 * 原地清洗策略：
 * 1. 自动备份原文件为 `<file>.bak-<yyyyMMddHHmmss>`；
 * 2. 只保留 `cookies` 字段；`origins` 清空；
 * 3. 打印每个文件前后的大小 / cookies 数 / localStorage 条数，便于核对。
 *
 * 用法：
 *   npm run trim-auth
 *
 * 覆盖范围：
 *   - ./accounts/<id>/.notion-auth.json（当前多账号布局）
 *   - ./.notion-auth.json（兼容仓库根的单账号旧布局）
 *
 * 回滚：把 `<file>.bak-<ts>` 改回原文件名即可。
 */

import { readFile, writeFile, copyFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cwd = process.cwd();

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getFullYear().toString() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function fmtBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/** 返回 { cookies, lsItems, lsBytes, sizeBytes } 的快速统计，供清洗前后对照 */
async function summarize(path) {
  const raw = await readFile(path, "utf-8");
  const size = Buffer.byteLength(raw, "utf-8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { size, cookies: -1, lsItems: -1, lsBytes: -1 };
  }
  const cookies = Array.isArray(json?.cookies) ? json.cookies.length : 0;
  let lsItems = 0;
  let lsBytes = 0;
  for (const o of json?.origins ?? []) {
    for (const kv of o?.localStorage ?? []) {
      lsItems++;
      lsBytes += (kv?.name?.length ?? 0) + (kv?.value?.length ?? 0);
    }
  }
  return { size, cookies, lsItems, lsBytes };
}

/** 原地裁剪为 cookies-only；返回是否改动（已是 cookies-only 就跳过） */
async function trimOne(path) {
  const before = await summarize(path);
  if (before.lsItems === 0 && before.cookies >= 0) {
    console.log(
      `  - 已是 cookies-only，跳过（cookies=${before.cookies}，size=${fmtBytes(before.size)}）`,
    );
    return false;
  }
  const backup = `${path}.bak-${ts()}`;
  await copyFile(path, backup);
  const raw = await readFile(path, "utf-8");
  const json = JSON.parse(raw);
  const trimmed = { cookies: Array.isArray(json?.cookies) ? json.cookies : [], origins: [] };
  await writeFile(path, JSON.stringify(trimmed), "utf-8");
  const after = await summarize(path);
  console.log(
    `  - 备份 → ${backup}`,
  );
  console.log(
    `  - cookies: ${before.cookies} → ${after.cookies}；lsItems: ${before.lsItems} → ${after.lsItems}；size: ${fmtBytes(before.size)} → ${fmtBytes(after.size)}`,
  );
  return true;
}

async function isFile(p) {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

async function collectAuthFiles() {
  const files = [];
  const root = join(cwd, ".notion-auth.json");
  if (await isFile(root)) files.push(root);
  const accountsDir = join(cwd, "accounts");
  if (existsSync(accountsDir)) {
    const ids = await readdir(accountsDir, { withFileTypes: true });
    for (const d of ids) {
      if (!d.isDirectory()) continue;
      const p = join(accountsDir, d.name, ".notion-auth.json");
      if (await isFile(p)) files.push(p);
    }
  }
  return files;
}

async function main() {
  const files = await collectAuthFiles();
  if (files.length === 0) {
    console.log("未找到任何 .notion-auth.json 文件，无需清洗。");
    return;
  }
  console.log(`发现 ${files.length} 个登录态文件：`);
  let changed = 0;
  for (const f of files) {
    console.log(`\n[${f}]`);
    try {
      const did = await trimOne(f);
      if (did) changed++;
    } catch (e) {
      console.error(`  ! 清洗失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`\n完成：改动 ${changed}/${files.length} 个文件。备份文件以 .bak-<ts> 结尾，如需回滚直接改回原名即可。`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
