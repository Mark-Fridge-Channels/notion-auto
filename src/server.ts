/**
 * Dashboard Web 服务：端口 9000，仅 localhost；API（状态/schedule/停止·启动/日志/拉取并重启）+ 单页 HTML。
 * 拉取并重启时 spawn 新进程并传 NOTION_AUTO_RESTART=1，新进程延迟 2 秒再 listen 以避免 EADDRINUSE。
 * 启动前加载 .env（dotenv），以便 NOTION_AUTO_NAME 等环境变量生效。
 */

import "dotenv/config";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, relative } from "node:path";
import * as runner from "./dashboard-runner.js";
import * as queueSenderRunner from "./dashboard-queue-sender-runner.js";
import * as inboundListenerRunner from "./dashboard-inbound-listener-runner.js";
import { loadSchedule, saveSchedule, getSchedulePath, mergeSchedule, validateSchedule } from "./schedule.js";
import {
  getInboundListenerConfigPath,
  loadInboundListenerConfigOrDefault,
  saveInboundListenerConfig,
  validateInboundListenerConfig,
} from "./inbound-listener-config.js";
import {
  loadReplyTasksConfigOrDefault,
  saveReplyTasksConfig,
  validateReplyTasksConfig,
} from "./reply-tasks-config.js";
import { listReplyTasks, getReplyTaskSendContext } from "./notion-reply-tasks.js";
import { sendOneReplyTask, sendBatchReplyTasks } from "./reply-tasks-send.js";
import { Client as NotionClient } from "@notionhq/client";
import { logger } from "./logger.js";

const PORT = 9001;
const HOST = "127.0.0.1";

/** 进程退出时先停止由 Dashboard 启动的子进程，避免残留 Queue Sender / Inbound Listener / Playwright 进程 */
function shutdown(): void {
  queueSenderRunner.stopQueueSender();
  inboundListenerRunner.stopInboundListener();
  runner.stop();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** 拉取并重启流程进行中时置为 true，防止重复点击 */
let isPullRestartInProgress = false;

/** 将 configPath 规范为项目目录下的路径，防止路径穿越；若非法则返回默认路径 */
function resolveConfigPath(configured: string | undefined): string {
  const base = getSchedulePath();
  if (configured == null || configured.trim() === "") return base;
  const resolved = resolve(process.cwd(), configured.trim());
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..") || rel.includes("..")) return base;
  return resolved;
}

/** Inbound Listener 配置路径：防路径穿越，非法则用默认路径 */
function resolveInboundListenerConfigPath(configured: string | undefined): string {
  const base = getInboundListenerConfigPath();
  if (configured == null || configured.trim() === "") return base;
  const resolved = resolve(process.cwd(), configured.trim());
  const rel = relative(process.cwd(), resolved);
  if (rel.startsWith("..") || rel.includes("..")) return base;
  return resolved;
}

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw) as unknown;
}

function sendJson(res: import("node:http").ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** Notion API 的「未找到」类错误（404 / object_not_found），用于 Reply Tasks API 返回 404 而非 500 */
function isNotionNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e && typeof e === "object" && "code" in e ? (e as { code: string }).code : "";
  return /could not find|object_not_found|not found|404/i.test(msg) || code === "object_not_found";
}

function sendHtml(res: import("node:http").ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/**
 * 在指定目录执行 git pull，跨平台不依赖 shell。
 * @returns exitCode、stdout、stderr；exitCode 非 0 表示失败（冲突、无 git 等）。
 */
function runGitPull(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["pull"], { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    function finish(exitCode: number, out: string, err: string) {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout: out, stderr: err });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0), stdout, stderr);
    });
    child.on("error", (err) => {
      stderr += (err?.message ?? String(err)) + "\n";
      finish(1, stdout, stderr);
    });
  });
}

/**
 * 在指定目录执行 npm i（安装依赖），跨平台；Windows 下使用 shell 以正确解析 npm。
 * @returns exitCode、stdout、stderr；exitCode 非 0 表示失败。
 */
function runNpmInstall(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const cmd = process.platform === "win32" ? "npm i" : "npm";
    const args = process.platform === "win32" ? [] : ["i"];
    const opts: Parameters<typeof spawn>[2] = { cwd };
    if (process.platform === "win32") opts.shell = true;
    const child = process.platform === "win32"
      ? spawn(cmd, args, opts)
      : spawn(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    let settled = false;
    function finish(exitCode: number, out: string, err: string) {
      if (settled) return;
      settled = true;
      resolve({ exitCode, stdout: out, stderr: err });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => {
      finish(code ?? (signal ? 1 : 0), stdout, stderr);
    });
    child.on("error", (err) => {
      stderr += (err?.message ?? String(err)) + "\n";
      finish(1, stdout, stderr);
    });
  });
}

/**
 * 停止 runner 后 spawn 新 server 进程（带 NOTION_AUTO_RESTART=1，新进程会延迟 2s 再 listen），
 * 不 await 子进程；调用方应在返回 HTTP 响应后 process.exit(0)。
 * 跨平台：Windows 使用 shell + 单命令，与 dashboard-runner 一致。
 */
function spawnNewServerAndExit(): void {
  queueSenderRunner.stopQueueSender();
  inboundListenerRunner.stopInboundListener();
  runner.stop();
  const env = { ...process.env, NOTION_AUTO_RESTART: "1" };
  const cwd = process.cwd();
  const opts = {
    cwd,
    env,
    detached: true,
    stdio: "ignore" as const,
  };
  if (process.platform === "win32") {
    spawn("npx tsx src/server.ts", [], { ...opts, shell: true });
  } else {
    spawn("npx", ["tsx", "src/server.ts"], opts);
  }
}

async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";
  const path = url.split("?")[0];
  const query = path !== url ? new URLSearchParams(url.slice(url.indexOf("?") + 1)) : new URLSearchParams();

  try {
    if (path === "/" && method === "GET") {
      sendHtml(res, getIndexHtml());
      return;
    }
    if (path === "/api/status" && method === "GET") {
      sendJson(res, 200, { status: runner.getRunStatus() });
      return;
    }
    if (path === "/api/schedule" && method === "GET") {
      const schedule = await loadSchedule(getSchedulePath());
      sendJson(res, 200, schedule);
      return;
    }
    if (path === "/api/schedule" && method === "POST") {
      const body = await readJsonBody(req);
      const schedule = mergeSchedule(body);
      validateSchedule(schedule);
      await saveSchedule(getSchedulePath(), schedule);
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/stop" && method === "POST") {
      runner.stop();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/start" && method === "POST") {
      if (runner.getRunStatus() === "running") {
        sendJson(res, 400, { error: "脚本已在运行，请先停止" });
        return;
      }
      const body = (await readJsonBody(req)) as { configPath?: string } | undefined;
      const configPath = resolveConfigPath(body?.configPath);
      runner.start({ configPath });
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/logs" && method === "GET") {
      const playRuns = runner.getRecentRunLogs(10).map((r) => ({ kind: "playwright" as const, ...r }));
      const queueRuns = queueSenderRunner.getQueueSenderRunLogs(10).map((r) => ({ kind: "queue-sender" as const, ...r }));
      const inboundRuns = inboundListenerRunner.getInboundListenerRunLogs(10).map((r) => ({ kind: "inbound-listener" as const, ...r }));
      const runs = [...playRuns, ...queueRuns, ...inboundRuns].sort((a, b) => b.startTime - a.startTime).slice(0, 20);
      sendJson(res, 200, { runs });
      return;
    }
    if (path === "/api/queue-sender/status" && method === "GET") {
      sendJson(res, 200, { status: queueSenderRunner.getQueueSenderStatus() });
      return;
    }
    if (path === "/api/queue-sender/start" && method === "POST") {
      if (queueSenderRunner.getQueueSenderStatus() === "running") {
        sendJson(res, 400, { error: "Queue Sender 已在运行，请先停止" });
        return;
      }
      queueSenderRunner.startQueueSender();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/queue-sender/stop" && method === "POST") {
      queueSenderRunner.stopQueueSender();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/inbound-listener/config" && method === "GET") {
      const config = await loadInboundListenerConfigOrDefault();
      sendJson(res, 200, config);
      return;
    }
    if (path === "/api/inbound-listener/config" && method === "POST") {
      const body = await readJsonBody(req);
      const config = validateInboundListenerConfig(body);
      await saveInboundListenerConfig(config);
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/inbound-listener/status" && method === "GET") {
      sendJson(res, 200, { status: inboundListenerRunner.getInboundListenerStatus() });
      return;
    }
    if (path === "/api/inbound-listener/start" && method === "POST") {
      if (inboundListenerRunner.getInboundListenerStatus() === "running") {
        sendJson(res, 400, { error: "Inbound Listener 已在运行，请先停止" });
        return;
      }
      const body = (await readJsonBody(req)) as { configPath?: string } | undefined;
      const inboundConfigPath = resolveInboundListenerConfigPath(body?.configPath);
      inboundListenerRunner.startInboundListener(inboundConfigPath);
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/inbound-listener/stop" && method === "POST") {
      inboundListenerRunner.stopInboundListener();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/reply-tasks/config" && method === "GET") {
      const config = await loadReplyTasksConfigOrDefault();
      sendJson(res, 200, config);
      return;
    }
    if (path === "/api/reply-tasks/config" && method === "POST") {
      const body = await readJsonBody(req);
      const config = validateReplyTasksConfig(body);
      await saveReplyTasksConfig(config);
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/reply-tasks/list" && method === "GET") {
      const config = await loadReplyTasksConfigOrDefault();
      const idx = config.selected_index >= 0 ? config.selected_index : 0;
      const entry = config.entries[idx];
      if (!entry) {
        sendJson(res, 200, []);
        return;
      }
      const token = process.env.NOTION_API_KEY;
      if (!token?.trim()) {
        sendJson(res, 500, { error: "缺少 NOTION_API_KEY" });
        return;
      }
      try {
        const notion = new NotionClient({ auth: token });
        const tasks = await listReplyTasks(notion, entry.reply_tasks_db_id);
        sendJson(res, 200, tasks);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = isNotionNotFoundError(e) ? 404 : 500;
        sendJson(res, status, { error: message });
      }
      return;
    }
    if (path === "/api/reply-tasks/context" && method === "GET") {
      const taskPageId = query.get("taskPageId")?.trim();
      if (!taskPageId) {
        sendJson(res, 400, { error: "缺少 taskPageId" });
        return;
      }
      const config = await loadReplyTasksConfigOrDefault();
      const idx = config.selected_index >= 0 ? config.selected_index : 0;
      const entry = config.entries[idx];
      if (!entry) {
        sendJson(res, 400, { error: "未选择 Reply Tasks 配置项" });
        return;
      }
      const token = process.env.NOTION_API_KEY;
      if (!token?.trim()) {
        sendJson(res, 500, { error: "缺少 NOTION_API_KEY" });
        return;
      }
      try {
        const notion = new NotionClient({ auth: token });
        const ctx = await getReplyTaskSendContext(notion, taskPageId);
        sendJson(res, 200, {
          suggestedReply: ctx.suggestedReply,
          lastInboundBodyPlain: ctx.lastInboundBodyPlain ?? "",
          to: ctx.to,
          subject: ctx.subject,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = isNotionNotFoundError(e) ? 404 : 500;
        sendJson(res, status, { error: message });
      }
      return;
    }
    if (path === "/api/reply-tasks/send" && method === "POST") {
      const body = (await readJsonBody(req)) as { taskPageId: string; bodyHtml?: string } | undefined;
      const taskPageId = body?.taskPageId?.trim();
      if (!taskPageId) {
        sendJson(res, 400, { error: "缺少 taskPageId" });
        return;
      }
      const config = await loadReplyTasksConfigOrDefault();
      const idx = config.selected_index >= 0 ? config.selected_index : 0;
      const entry = config.entries[idx];
      if (!entry) {
        sendJson(res, 400, { error: "未选择 Reply Tasks 配置项" });
        return;
      }
      const token = process.env.NOTION_API_KEY;
      if (!token?.trim()) {
        sendJson(res, 500, { error: "缺少 NOTION_API_KEY" });
        return;
      }
      try {
        const notion = new NotionClient({ auth: token });
        const result = await sendOneReplyTask(
          notion,
          taskPageId,
          entry.sender_accounts_database_url,
          body?.bodyHtml,
        );
        sendJson(res, 200, result);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = isNotionNotFoundError(e) ? 404 : 500;
        sendJson(res, status, { error: message });
      }
      return;
    }
    if (path === "/api/reply-tasks/send-batch" && method === "POST") {
      const token = process.env.NOTION_API_KEY;
      if (!token?.trim()) {
        sendJson(res, 500, { error: "缺少 NOTION_API_KEY" });
        return;
      }
      try {
        const notion = new NotionClient({ auth: token });
        const batchResult = await sendBatchReplyTasks(notion);
        sendJson(res, 200, batchResult);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const status = isNotionNotFoundError(e) ? 404 : 500;
        sendJson(res, status, { error: message });
      }
      return;
    }
    if (path === "/api/pull-and-restart" && method === "POST") {
      if (isPullRestartInProgress) {
        sendJson(res, 409, { error: "拉取并重启正在进行中" });
        return;
      }
      isPullRestartInProgress = true;
      try {
        const cwd = process.cwd();
        const pullResult = await runGitPull(cwd);
        if (pullResult.exitCode !== 0) {
          const error = pullResult.stderr.trim() || pullResult.stdout.trim() || `git pull 退出码 ${pullResult.exitCode}`;
          sendJson(res, 200, { ok: false, error, stdout: pullResult.stdout, stderr: pullResult.stderr });
          return;
        }
        const npmResult = await runNpmInstall(cwd);
        if (npmResult.exitCode !== 0) {
          const error = npmResult.stderr.trim() || npmResult.stdout.trim() || `npm i 退出码 ${npmResult.exitCode}`;
          sendJson(res, 200, { ok: false, error, stdout: npmResult.stdout, stderr: npmResult.stderr });
          return;
        }
        spawnNewServerAndExit();
        sendJson(res, 200, { ok: true, message: "即将重启，请稍后刷新" });
        setImmediate(() => process.exit(0));
      } finally {
        isPullRestartInProgress = false;
      }
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendJson(res, 400, { error: message });
  }
}

/** 从环境变量 NOTION_AUTO_NAME 读取名称，生成标题「notion-auto （Name）控制台」；未设置则「notion-auto 控制台」。已做 HTML 转义防 XSS。 */
function getDashboardTitle(): string {
  const name = (process.env.NOTION_AUTO_NAME ?? "").trim();
  if (!name) return "notion-auto 控制台";
  const safe = name
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return `${safe} 控制台`;
}

function getIndexHtml(): string {
  return getDashboardHtml();
}

/** 生成 Dashboard 单页 HTML：全局设置 + 时间区间 + 行业任务链 + 日志 */
function getDashboardHtml(): string {
  const pageTitle = getDashboardTitle();
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${pageTitle}</title>
  <style>
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html { -webkit-text-size-adjust: 100%; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 0 auto; padding: 1.25rem; padding-left: max(1.25rem, env(safe-area-inset-left)); padding-right: max(1.25rem, env(safe-area-inset-right)); padding-bottom: max(1.25rem, env(safe-area-inset-bottom)); background: #f5f5f5; color: #333; }
    .header { display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; padding: 1rem; padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right)); background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .header h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
    .status { padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.875rem; font-weight: 500; }
    .status.running { background: #d4edda; color: #155724; }
    .status.idle { background: #f8d7da; color: #721c24; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; }
    .actions button { min-height: 44px; padding: 0.5rem 1rem; border-radius: 8px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.875rem; touch-action: manipulation; }
    .actions button:hover:not(:disabled) { background: #f0f0f0; }
    .actions button:disabled { opacity: 0.6; cursor: not-allowed; }
    .actions button.primary { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    .actions button.primary:hover:not(:disabled) { background: #0b5ed7; }
    .actions button.danger { border-color: #dc3545; color: #dc3545; }
    .actions button.danger:hover:not(:disabled) { background: #fff5f5; }
    .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .card { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .card h2 { margin: 0 0 1rem; font-size: 1rem; font-weight: 600; color: #555; }
    .row { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.25rem; font-size: 0.875rem; font-weight: 500; }
    .hint { font-weight: normal; color: #888; font-size: 0.8rem; }
    input, textarea, select { width: 100%; padding: 0.5rem 0.65rem; border: 1px solid #ddd; border-radius: 6px; font-size: 16px; }
    input:focus, textarea:focus, select:focus { outline: 2px solid #0d6efd; outline-offset: 2px; }
    textarea { min-height: 48px; resize: vertical; }
    .slot-row, .task-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
    .slot-row { padding: 0.6rem 0.75rem; background: #f8f9fa; border-radius: 6px; border: 1px solid #eee; }
    .slot-row .slot-time-group { display: inline-flex; align-items: center; gap: 0.35rem; margin-right: 1rem; }
    .slot-row .slot-time-group label { margin: 0; font-size: 0.8rem; color: #666; width: 1.5rem; flex-shrink: 0; }
    .slot-row input[type="number"], .task-row input[type="number"] { width: 3.5rem; min-width: 3rem; padding: 0.4rem 0.5rem; }
    .slot-row select { flex: 1; min-width: 12rem; max-width: 24rem; margin-right: 0.25rem; }
    .industry-list { border: 1px solid #eee; border-radius: 6px; overflow: hidden; }
    .industry-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 0.75rem; padding: 0.6rem 1rem; border-bottom: 1px solid #eee; background: #fff; }
    .industry-row:last-child { border-bottom: none; }
    .industry-row .id { font-weight: 600; min-width: 5rem; }
    .industry-row .url { flex: 1; min-width: 0; color: #666; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .industry-row .actions { display: flex; gap: 0.35rem; flex-shrink: 0; }
    .industry-row.selected { background: #e8f4fd; border-left: 3px solid #0d6efd; }
    .modal-overlay { display: none; position: fixed; inset: 0; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); background: rgba(0,0,0,.4); z-index: 100; align-items: center; justify-content: center; overflow-y: auto; }
    .modal-overlay.visible { display: flex; }
    .modal-box { background: #fff; border-radius: 8px; padding: 1.25rem; min-width: 280px; max-width: min(90vw, 360px); max-height: 85vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,.15); margin: auto; }
    .modal-box h3 { margin: 0 0 1rem; font-size: 1rem; }
    .modal-box .form-actions { margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .modal-box .form-actions button { min-height: 44px; }
    .modal-box--wide { max-width: min(90vw, 720px); }
    .reply-tasks-detail-text, .reply-tasks-detail-pre, .reply-tasks-inbound-pre { margin: 0; padding: 0.5rem; background: #f8f9fa; border: 1px solid #eee; border-radius: 6px; font-size: 0.875rem; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
    .reply-tasks-detail-pre, .reply-tasks-inbound-pre { font-family: ui-monospace, monospace; }
    .task-row textarea { flex: 1; min-width: 0; }
    .logs-card { grid-column: 1 / -1; }
    .logs { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; max-height: 380px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .log-tabs { margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .log-tabs button { min-height: 36px; padding: 0.35rem 0.65rem; border-radius: 4px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.8rem; touch-action: manipulation; }
    .log-tabs button.active { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    /* Dashboard 三 Tab：导航与 panel 显隐 */
    .tab-nav { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 1rem; }
    .tab-nav button { min-height: 36px; padding: 0.35rem 0.75rem; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.875rem; touch-action: manipulation; }
    .tab-nav button:hover { background: #f0f0f0; }
    .tab-nav button.active { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    .tab-panel { display: none; }
    .tab-panel.active { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    #msg { margin-top: 0.5rem; font-size: 0.875rem; min-height: 1.25em; word-break: break-word; }
    @media (max-width: 768px) {
      body { padding: 0.75rem; }
      .header { padding: 0.75rem; flex-direction: column; align-items: stretch; }
      .header .actions { width: 100%; }
      .header .actions button { flex: 1; min-width: 0; }
      .layout { grid-template-columns: 1fr; gap: 1rem; }
      .tab-panel.active { grid-template-columns: 1fr; gap: 1rem; }
      .card { padding: 1rem; }
      .slot-row { flex-wrap: wrap; }
      .slot-row select { max-width: none; }
      .industry-row .type { min-width: 4.5rem; font-size: 0.875em; color: #666; }
      .industry-row .id { min-width: 4rem; }
      .modal-box { min-width: 0; width: 100%; max-width: calc(100vw - 1.5rem); margin: 1rem; }
    }
    @media (max-width: 480px) {
      .header .actions { flex-direction: column; }
      .header .actions button { width: 100%; }
      .industry-row { flex-direction: column; align-items: stretch; gap: 0.5rem; }
      .industry-row .url { white-space: normal; }
    }
  </style>
  <link href="https://cdn.quilljs.com/1.3.7/quill.snow.css" rel="stylesheet">
</head>
<body>
  <header class="header">
    <div>
      <h1>${pageTitle}</h1>
      <div id="statusEl" class="status" style="margin-top:0.5rem">加载中…</div>
      <div id="queueSenderStatusEl" class="status" style="margin-top:0.25rem;font-size:0.9em">Queue Sender：—</div>
      <div id="inboundListenerStatusEl" class="status" style="margin-top:0.25rem;font-size:0.9em">Inbound Listener：—</div>
    </div>
    <div>
      <div class="actions">
        <button type="button" id="btnStart" class="primary">启动</button>
        <button type="button" id="btnStop" class="danger">停止</button>
        <button type="button" id="btnQueueSenderStart" class="primary">启动 Queue Sender</button>
        <button type="button" id="btnQueueSenderStop" class="danger">停止 Queue Sender</button>
        <button type="button" id="btnInboundListenerStart" class="primary">启动 Inbound Listener</button>
        <button type="button" id="btnInboundListenerStop" class="danger">停止 Inbound Listener</button>
        <button type="button" id="btnSave">保存配置</button>
        <button type="button" id="btnPullRestart">拉取并重启</button>
      </div>
      <div id="msg"></div>
    </div>
  </header>

  <nav class="tab-nav" id="dashboardTabNav" aria-label="Dashboard 分区">
    <button type="button" class="active" data-tab="main">主视图</button>
    <button type="button" data-tab="reply-tasks">Reply Tasks</button>
    <button type="button" data-tab="inbound">Inbound Listener</button>
  </nav>

  <div id="tab-main" class="tab-panel active">
    <div class="card">
      <h2>全局设置</h2>
      <div class="row">
        <label>每隔多少秒 check 一次是否对话结束（区间，每次发送后随机）<span class="hint">最小～最大，默认 120～120</span></label>
        <span><input id="intervalSecondsMin" type="number" min="1" placeholder="120" style="width:5rem"> ～ <input id="intervalSecondsMax" type="number" min="1" placeholder="120" style="width:5rem"> 秒</span>
      </div>
      <div class="row">
        <label>如果没有登录账号，首次等待多少秒进行手动登录操作 <span class="hint">默认 60</span></label>
        <input id="loginWaitSeconds" type="number" min="0" placeholder="60">
      </div>
      <div class="row">
        <label>最大重试次数 <span class="hint">打开 Notion AI、点击新建对话、输入发送等单步失败时最多尝试次数，默认 3</span></label>
        <input id="maxRetries" type="number" min="1" placeholder="3">
      </div>
      <div class="row">
        <label>等待输出期间自动点击的按钮 <span class="hint">将按列表顺序依次检测并点击出现的按钮。填写按钮上显示的文字，精确匹配。</span></label>
      </div>
      <div id="autoClickButtonsContainer"></div>
      <button type="button" id="btnAddAutoClickButton" class="primary" style="margin-top:0.25rem">添加一项</button>
    </div>
    <div class="card">
      <h2>时间区间 <span class="hint">左闭右开，本地时区</span></h2>
      <div id="timeSlotsContainer"></div>
      <button type="button" id="btnAddSlot" class="primary" style="margin-top:0.5rem">添加时间区间</button>
    </div>
    <div class="card" style="grid-column: 1 / -1;">
      <h2>行业与任务链</h2>
      <div id="industriesContainer" class="industry-list"></div>
      <button type="button" id="btnAddIndustry" class="primary" style="margin-top:0.5rem">添加行业</button>
    </div>
    <div class="card logs-card" style="grid-column: 1 / -1;">
      <h2>最近运行日志</h2>
      <div class="log-tabs" id="logTabs"></div>
      <div id="logContent" class="logs">（选择一次运行查看）</div>
    </div>
  </div>
  <div id="tab-inbound" class="tab-panel">
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Inbound Listener 配置 <span class="hint">写入 inbound-listener.json，无文件时保存即创建</span></h2>
      <div class="row">
        <label>轮询间隔（秒）<span class="hint">默认 120，不小于 10</span></label>
        <input id="inboundPollInterval" type="number" min="10" placeholder="120" style="width:6rem">
      </div>
      <div class="row">
        <label>Body Plain 最大字符数 <span class="hint">超长保留开头+结尾，默认 40000</span></label>
        <input id="inboundBodyPlainMaxChars" type="number" min="1000" placeholder="40000" style="width:8rem">
      </div>
      <h3 style="margin-top:1rem;font-size:1rem">监听组</h3>
      <div id="inboundListenerGroupsContainer" class="industry-list"></div>
      <button type="button" id="btnAddInboundGroup" class="primary" style="margin-top:0.5rem">添加一组</button>
      <button type="button" id="btnSaveInboundConfig" class="primary" style="margin-left:0.5rem">保存 Inbound Listener 配置</button>
    </div>
  </div>
  <div id="tab-reply-tasks" class="tab-panel">
    <div class="card" style="grid-column: 1 / -1;">
      <h2>Reply Tasks 配置 <span class="hint">写入 reply-tasks.json，切换后加载 Task 列表</span></h2>
      <div id="replyTasksEntriesContainer" class="industry-list"></div>
      <button type="button" id="btnAddReplyTasksEntry" class="primary" style="margin-top:0.5rem">添加一条</button>
      <button type="button" id="btnSaveReplyTasksConfig" class="primary" style="margin-left:0.5rem">保存 Reply Tasks 配置</button>
      <h3 style="margin-top:1rem;font-size:1rem">当前库 Task 列表</h3>
      <button type="button" id="btnLoadReplyTasksList" class="primary" style="margin-bottom:0.5rem">加载 Task 列表</button>
      <button type="button" id="btnSendBatchReplyTasks" style="margin-left:0.5rem">批量发送未完成</button>
      <div id="replyTasksListContainer" class="industry-list" style="max-height:320px;overflow-y:auto"></div>
    </div>
  </div>
  <div id="inboundListenerGroupModal" class="modal-overlay">
      <div class="modal-box">
        <h3>编辑监听组</h3>
        <div class="row"><label>📥 Inbound Messages 数据库 ID 或 URL</label><input type="text" id="modalInboundImDbId" placeholder="32位hex或Notion URL"></div>
        <div class="row"><label>📬 Touchpoints 数据库 ID 或 URL</label><input type="text" id="modalInboundTouchpointsDbId" placeholder="与 Queue 表同一张"></div>
        <div class="row"><label>发件人库 URL</label><input type="url" id="modalInboundSenderAccountsUrl" placeholder="https://www.notion.so/..."></div>
        <div class="row"><label>Mailboxes（发件人库 Email，每行一个）</label><textarea id="modalInboundMailboxes" rows="4" placeholder="sender1@example.com"></textarea></div>
        <div class="form-actions">
          <button type="button" id="modalInboundGroupSave" class="primary">保存</button>
          <button type="button" id="modalInboundGroupCancel">取消</button>
        </div>
      </div>
    </div>
  <div id="replyTasksEntryModal" class="modal-overlay">
      <div class="modal-box">
        <h3>编辑 Reply Tasks 配置</h3>
        <div class="row"><label>Reply Tasks 数据库 ID 或 URL</label><input type="text" id="modalReplyTasksDbId" placeholder="32位hex或Notion URL"></div>
        <div class="row"><label>发件人库 URL</label><input type="url" id="modalReplyTasksSenderUrl" placeholder="https://www.notion.so/..."></div>
        <div class="form-actions">
          <button type="button" id="modalReplyTasksEntrySave" class="primary">保存</button>
          <button type="button" id="modalReplyTasksEntryCancel">取消</button>
        </div>
      </div>
    </div>
    <div id="replyTasksDetailModal" class="modal-overlay">
      <div class="modal-box">
        <h3>Task 详情</h3>
        <div class="row"><label>Task Summary</label><div id="replyTasksDetailSummary" class="reply-tasks-detail-text"></div></div>
        <div class="row"><label>Status</label><span id="replyTasksDetailStatus" class="hint"></span></div>
        <div class="row"><label>Suggested Reply</label><pre id="replyTasksDetailSuggestedReply" class="reply-tasks-detail-pre"></pre></div>
        <div class="form-actions"><button type="button" id="replyTasksDetailClose" class="primary">关闭</button></div>
      </div>
    </div>
    <div id="replyTasksSendModal" class="modal-overlay">
      <div class="modal-box modal-box--wide">
        <h3>发送回复（可编辑正文）</h3>
        <div class="row"><label>对方上一条回复</label><pre id="replyTasksLastInboundEl" class="reply-tasks-inbound-pre"></pre></div>
        <div class="row"><label>正文（富文本）</label><div id="replyTasksBodyEditor" style="min-height:200px;background:#fff"></div></div>
        <div class="form-actions">
          <button type="button" id="modalReplyTasksSendConfirm" class="primary">发送</button>
          <button type="button" id="modalReplyTasksSendCancel">取消</button>
        </div>
      </div>
    </div>
    <div id="industryModal" class="modal-overlay">
      <div class="modal-box">
        <h3 id="industryModalTitle">编辑行业</h3>
        <div class="row"><label>行业 id（名称）</label><input type="text" id="modalIndustryId" placeholder="id"></div>
        <div class="row">
          <label>行业类型</label>
          <span><label><input type="radio" name="modalIndustryType" value="playwright" checked> Playwright 任务链</label> &nbsp; <label><input type="radio" name="modalIndustryType" value="queue"> Queue 出站发送</label></span>
        </div>
        <div id="modalPlaywrightBlock">
          <div class="row"><label>Notion Portal URL</label><input type="url" id="modalNotionUrl" placeholder="https://..."></div>
          <div class="row"><label>每 N 次开启新会话（区间内随机次数）</label><span><input type="number" id="modalNewChatEveryRunsMin" min="0" value="1" style="width:4rem"> ～ <input type="number" id="modalNewChatEveryRunsMax" min="0" value="1" style="width:4rem"></span></div>
          <div class="row"><label>每 M 次换模型（区间，0=不换）</label><span><input type="number" id="modalModelSwitchIntervalMin" min="0" value="0" style="width:4rem"> ～ <input type="number" id="modalModelSwitchIntervalMax" min="0" value="0" style="width:4rem"></span></div>
          <div class="row"><label>时段内跑几轮任务链（0=一直跑）</label><input type="number" id="modalChainRunsPerSlot" min="0" value="0" style="width:4rem" placeholder="0"></div>
          <div class="row"><label>任务链</label><div id="modalTasksContainer"></div><button type="button" id="modalAddTask">添加任务</button></div>
        </div>
        <div id="modalQueueBlock" style="display:none">
          <div class="row"><label>Queue 数据库 URL</label><input type="url" id="modalQueueDatabaseUrl" placeholder="https://www.notion.so/..."></div>
          <div class="row"><label>发件人库 URL</label><input type="url" id="modalSenderAccountsDatabaseUrl" placeholder="https://www.notion.so/..."></div>
          <div class="row"><label>每批条数（10–30 建议）</label><input type="number" id="modalQueueBatchSize" min="1" max="100" value="20" style="width:4rem"></div>
        </div>
        <div class="form-actions">
          <button type="button" id="modalSave" class="primary">保存</button>
          <button type="button" id="modalCancel">取消</button>
        </div>
      </div>
    </div>

  <script src="https://cdn.quilljs.com/1.3.7/quill.min.js"></script>
  <script>
    const statusEl = document.getElementById('statusEl');
    const msgEl = document.getElementById('msg');
    const timeSlotsContainer = document.getElementById('timeSlotsContainer');
    const industriesContainer = document.getElementById('industriesContainer');
    const autoClickButtonsContainer = document.getElementById('autoClickButtonsContainer');
    const logTabs = document.getElementById('logTabs');
    const logContent = document.getElementById('logContent');

    /** Dashboard 三 Tab 切换：仅显隐 panel，不重绑事件 */
    (function initDashboardTabs() {
      const nav = document.getElementById('dashboardTabNav');
      const panels = document.querySelectorAll('.tab-panel');
      if (!nav || !panels.length) return;
      nav.querySelectorAll('button[data-tab]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const tab = btn.getAttribute('data-tab');
          if (!tab) return;
          nav.querySelectorAll('button[data-tab]').forEach(function (b) { b.classList.remove('active'); });
          panels.forEach(function (p) { p.classList.remove('active'); });
          btn.classList.add('active');
          const panel = document.getElementById('tab-' + tab);
          if (panel) panel.classList.add('active');
        });
      });
    })();

    /** 当前页使用的 schedule，行业数据以内存为准，列表仅展示 */
    let currentSchedule = null;
    /** Inbound Listener 配置，以内存为准 */
    let currentInboundConfig = null;
    /** Reply Tasks 配置，以内存为准 */
    let currentReplyTasksConfig = null;
    /** 单条发送时暂存的 taskPageId */
    let replyTasksSendTaskPageId = null;

    function showMsg(text, isError) {
      msgEl.textContent = text || '';
      msgEl.style.color = isError ? '#dc3545' : '#155724';
    }
    function escapeHtml(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function escapeAttr(s) {
      return escapeHtml(s);
    }
    /** 截断 URL 用于列表展示，最多约 40 字符 */
    function truncateUrl(url) {
      if (!url || !url.trim()) return '—';
      const s = String(url).trim();
      return s.length <= 42 ? s : s.slice(0, 39) + '...';
    }

    async function api(path, opts) {
      const res = await fetch(path, opts);
      if (res.status === 204) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    async function refreshStatus() {
      const { status } = await api('/api/status');
      statusEl.textContent = status === 'running' ? '运行中' : '已停止';
      statusEl.className = 'status ' + status;
      document.getElementById('btnStart').disabled = status === 'running';
      document.getElementById('btnStop').disabled = status === 'idle';
    }
    async function refreshQueueSenderStatus() {
      try {
        const { status } = await api('/api/queue-sender/status');
        const el = document.getElementById('queueSenderStatusEl');
        el.textContent = status === 'running' ? 'Queue Sender：运行中' : 'Queue Sender：已停止';
        el.className = 'status ' + status;
        document.getElementById('btnQueueSenderStart').disabled = status === 'running';
        document.getElementById('btnQueueSenderStop').disabled = status === 'idle';
      } catch (_) {}
    }
    async function refreshInboundListenerStatus() {
      try {
        const { status } = await api('/api/inbound-listener/status');
        const el = document.getElementById('inboundListenerStatusEl');
        el.textContent = status === 'running' ? 'Inbound Listener：运行中' : 'Inbound Listener：已停止';
        el.className = 'status ' + status;
        document.getElementById('btnInboundListenerStart').disabled = status === 'running';
        document.getElementById('btnInboundListenerStop').disabled = status === 'idle';
      } catch (_) {}
    }

    let editingInboundGroupIndex = -1;
    async function loadInboundListenerConfig() {
      const c = await api('/api/inbound-listener/config');
      currentInboundConfig = c;
      document.getElementById('inboundPollInterval').value = c.poll_interval_seconds ?? 120;
      document.getElementById('inboundBodyPlainMaxChars').value = c.body_plain_max_chars ?? 40000;
      renderInboundListenerGroups();
    }
    function renderInboundListenerGroups() {
      if (!currentInboundConfig || !currentInboundConfig.groups) return;
      const container = document.getElementById('inboundListenerGroupsContainer');
      container.innerHTML = '';
      currentInboundConfig.groups.forEach((g, idx) => {
        const row = document.createElement('div');
        row.className = 'industry-row';
        const mailboxesPreview = (g.mailboxes || []).length ? (g.mailboxes.length + ' 个邮箱') : '—';
        row.innerHTML = '<span class="url" title="' + escapeAttr(g.inbound_messages_db_id || '') + '">' + escapeHtml(truncateUrl(g.inbound_messages_db_id)) + '</span>' +
          '<span class="hint">' + mailboxesPreview + '</span>' +
          '<span class="actions"><button type="button" data-edit-inbound-group>编辑</button><button type="button" class="danger" data-remove-inbound-group>删除</button></span>';
        row.querySelector('[data-edit-inbound-group]').onclick = () => openInboundGroupModal(idx);
        row.querySelector('[data-remove-inbound-group]').onclick = () => { currentInboundConfig.groups.splice(idx, 1); renderInboundListenerGroups(); };
        container.appendChild(row);
      });
      document.getElementById('btnAddInboundGroup').onclick = () => {
        currentInboundConfig.groups.push({ inbound_messages_db_id: '', touchpoints_db_id: '', sender_accounts_database_url: '', mailboxes: [] });
        openInboundGroupModal(currentInboundConfig.groups.length - 1);
      };
    }
    function openInboundGroupModal(idx) {
      editingInboundGroupIndex = idx;
      const g = currentInboundConfig.groups[idx] || {};
      document.getElementById('modalInboundImDbId').value = g.inbound_messages_db_id || '';
      document.getElementById('modalInboundTouchpointsDbId').value = g.touchpoints_db_id || '';
      document.getElementById('modalInboundSenderAccountsUrl').value = g.sender_accounts_database_url || '';
      document.getElementById('modalInboundMailboxes').value = (g.mailboxes || []).join('\\n');
      document.getElementById('inboundListenerGroupModal').classList.add('visible');
    }
    function closeInboundGroupModal() {
      document.getElementById('inboundListenerGroupModal').classList.remove('visible');
      editingInboundGroupIndex = -1;
    }
    document.getElementById('modalInboundGroupCancel').onclick = closeInboundGroupModal;
    document.getElementById('modalInboundGroupSave').onclick = () => {
      const g = currentInboundConfig.groups[editingInboundGroupIndex];
      g.inbound_messages_db_id = document.getElementById('modalInboundImDbId').value.trim();
      g.touchpoints_db_id = document.getElementById('modalInboundTouchpointsDbId').value.trim();
      g.sender_accounts_database_url = document.getElementById('modalInboundSenderAccountsUrl').value.trim();
      g.mailboxes = document.getElementById('modalInboundMailboxes').value.split(new RegExp('[\\n,]')).map((s) => s.trim()).filter(Boolean);
      closeInboundGroupModal();
      renderInboundListenerGroups();
    };
    document.getElementById('btnSaveInboundConfig').onclick = async () => {
      showMsg('');
      try {
        const pollSec = parseInt(document.getElementById('inboundPollInterval').value, 10);
        const bodyMax = parseInt(document.getElementById('inboundBodyPlainMaxChars').value, 10);
        const config = {
          groups: currentInboundConfig.groups,
          poll_interval_seconds: Number.isInteger(pollSec) && pollSec >= 10 ? pollSec : 120,
          body_plain_max_chars: Number.isInteger(bodyMax) && bodyMax >= 1000 ? bodyMax : 40000
        };
        await api('/api/inbound-listener/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
        showMsg('Inbound Listener 配置已保存', false);
        setTimeout(() => showMsg(''), 2000);
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };

    let editingReplyTasksEntryIndex = -1;
    async function loadReplyTasksConfig() {
      const c = await api('/api/reply-tasks/config');
      currentReplyTasksConfig = c;
      renderReplyTasksEntries();
    }
    function renderReplyTasksEntries() {
      if (!currentReplyTasksConfig || !currentReplyTasksConfig.entries) return;
      const container = document.getElementById('replyTasksEntriesContainer');
      container.innerHTML = '';
      currentReplyTasksConfig.entries.forEach((e, idx) => {
        const row = document.createElement('div');
        row.className = 'industry-row';
        if (currentReplyTasksConfig.selected_index === idx) row.classList.add('selected');
        const curLabel = currentReplyTasksConfig.selected_index === idx ? ' [当前]' : '';
        row.innerHTML = '<span class="url" title="' + escapeAttr(e.reply_tasks_db_id || '') + '">' + escapeHtml(truncateUrl(e.reply_tasks_db_id)) + curLabel + '</span>' +
          '<span class="hint">' + escapeHtml(truncateUrl(e.sender_accounts_database_url || '')) + '</span>' +
          '<span class="actions">' +
          '<button type="button" data-reply-tasks-select>选中</button>' +
          '<button type="button" data-edit-reply-tasks-entry>编辑</button>' +
          '<button type="button" class="danger" data-remove-reply-tasks-entry>删除</button></span>';
        row.querySelector('[data-reply-tasks-select]').onclick = () => { currentReplyTasksConfig.selected_index = idx; renderReplyTasksEntries(); };
        row.querySelector('[data-edit-reply-tasks-entry]').onclick = () => openReplyTasksEntryModal(idx);
        row.querySelector('[data-remove-reply-tasks-entry]').onclick = () => {
          currentReplyTasksConfig.entries.splice(idx, 1);
          if (currentReplyTasksConfig.selected_index >= currentReplyTasksConfig.entries.length)
            currentReplyTasksConfig.selected_index = currentReplyTasksConfig.entries.length - 1;
          renderReplyTasksEntries();
        };
        container.appendChild(row);
      });
      document.getElementById('btnAddReplyTasksEntry').onclick = () => {
        currentReplyTasksConfig.entries.push({ reply_tasks_db_id: '', sender_accounts_database_url: '' });
        openReplyTasksEntryModal(currentReplyTasksConfig.entries.length - 1);
      };
    }
    function openReplyTasksEntryModal(idx) {
      editingReplyTasksEntryIndex = idx;
      const e = currentReplyTasksConfig.entries[idx] || {};
      document.getElementById('modalReplyTasksDbId').value = e.reply_tasks_db_id || '';
      document.getElementById('modalReplyTasksSenderUrl').value = e.sender_accounts_database_url || '';
      document.getElementById('replyTasksEntryModal').classList.add('visible');
    }
    function closeReplyTasksEntryModal() {
      document.getElementById('replyTasksEntryModal').classList.remove('visible');
      editingReplyTasksEntryIndex = -1;
    }
    document.getElementById('modalReplyTasksEntryCancel').onclick = closeReplyTasksEntryModal;
    document.getElementById('modalReplyTasksEntrySave').onclick = () => {
      if (editingReplyTasksEntryIndex < 0 || !currentReplyTasksConfig.entries || editingReplyTasksEntryIndex >= currentReplyTasksConfig.entries.length) {
        closeReplyTasksEntryModal();
        return;
      }
      const e = currentReplyTasksConfig.entries[editingReplyTasksEntryIndex];
      e.reply_tasks_db_id = document.getElementById('modalReplyTasksDbId').value.trim();
      e.sender_accounts_database_url = document.getElementById('modalReplyTasksSenderUrl').value.trim();
      closeReplyTasksEntryModal();
      renderReplyTasksEntries();
    };
    document.getElementById('btnSaveReplyTasksConfig').onclick = async () => {
      showMsg('');
      try {
        await api('/api/reply-tasks/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(currentReplyTasksConfig) });
        showMsg('Reply Tasks 配置已保存', false);
        setTimeout(() => showMsg(''), 2000);
      } catch (err) { showMsg(err instanceof Error ? err.message : String(err), true); }
    };
    let replyTasksList = [];
    document.getElementById('btnLoadReplyTasksList').onclick = async () => {
      showMsg('');
      try {
        replyTasksList = await api('/api/reply-tasks/list') || [];
        renderReplyTasksList();
      } catch (err) { showMsg(err instanceof Error ? err.message : String(err), true); }
    };
    function renderReplyTasksList() {
      const container = document.getElementById('replyTasksListContainer');
      container.innerHTML = '';
      replyTasksList.forEach((t) => {
        const row = document.createElement('div');
        row.className = 'industry-row';
        const summary = (t.taskSummary || '').slice(0, 50) + ((t.taskSummary || '').length > 50 ? '…' : '');
        const status = t.status || '—';
        const snippet = (t.suggestedReply || '').slice(0, 80) + ((t.suggestedReply || '').length > 80 ? '…' : '');
        const isDone = t.status === 'Done';
        const sendBtnHtml = isDone ? '' : '<button type="button" data-reply-tasks-send-one>发送</button>';
        row.innerHTML = '<span class="url" title="' + escapeAttr(t.taskSummary || '') + '">' + escapeHtml(summary) + '</span>' +
          '<span class="hint">' + escapeHtml(status) + '</span>' +
          '<span class="hint" style="max-width:12rem" title="' + escapeAttr(t.suggestedReply || '') + '">' + escapeHtml(snippet) + '</span>' +
          '<span class="actions">' + sendBtnHtml + '<button type="button" data-reply-tasks-detail>详情</button></span>';
        const sendBtn = row.querySelector('[data-reply-tasks-send-one]');
        if (sendBtn) sendBtn.onclick = () => openReplyTasksSendModal(t);
        row.querySelector('[data-reply-tasks-detail]').onclick = () => openReplyTasksDetailModal(t);
        container.appendChild(row);
      });
      if (replyTasksList.length === 0) container.innerHTML = '<p class="hint">（无任务或请先选择配置并加载列表）</p>';
    }
    function openReplyTasksDetailModal(task) {
      document.getElementById('replyTasksDetailSummary').textContent = task.taskSummary || '—';
      document.getElementById('replyTasksDetailStatus').textContent = task.status || '—';
      document.getElementById('replyTasksDetailSuggestedReply').textContent = task.suggestedReply || '';
      document.getElementById('replyTasksDetailModal').classList.add('visible');
    }
    document.getElementById('replyTasksDetailClose').onclick = () => document.getElementById('replyTasksDetailModal').classList.remove('visible');
    let replyTasksQuill = null;
    async function openReplyTasksSendModal(task) {
      replyTasksSendTaskPageId = task.pageId;
      const lastInboundEl = document.getElementById('replyTasksLastInboundEl');
      lastInboundEl.textContent = '加载中…';
      document.getElementById('replyTasksSendModal').classList.add('visible');
      try {
        const ctx = await api('/api/reply-tasks/context?taskPageId=' + encodeURIComponent(task.pageId));
        lastInboundEl.textContent = (ctx.lastInboundBodyPlain || '') || '（无）';
        if (!replyTasksQuill) {
          replyTasksQuill = new Quill('#replyTasksBodyEditor', { theme: 'snow', placeholder: '编辑回复正文…' });
        }
        replyTasksQuill.root.innerHTML = (ctx.suggestedReply || '').replace(new RegExp('\\n', 'g'), '<br>');
      } catch (err) {
        lastInboundEl.textContent = '加载失败: ' + (err instanceof Error ? err.message : String(err));
        if (!replyTasksQuill) {
          replyTasksQuill = new Quill('#replyTasksBodyEditor', { theme: 'snow', placeholder: '编辑回复正文…' });
        }
        replyTasksQuill.root.innerHTML = (task.suggestedReply || '').replace(new RegExp('\\n', 'g'), '<br>');
      }
    }
    function closeReplyTasksSendModal() {
      document.getElementById('replyTasksSendModal').classList.remove('visible');
      replyTasksSendTaskPageId = null;
    }
    document.getElementById('modalReplyTasksSendCancel').onclick = closeReplyTasksSendModal;
    document.getElementById('modalReplyTasksSendConfirm').onclick = async () => {
      if (!replyTasksSendTaskPageId) return;
      showMsg('');
      try {
        const bodyHtml = replyTasksQuill ? replyTasksQuill.root.innerHTML : '';
        const body = { taskPageId: replyTasksSendTaskPageId, bodyHtml: bodyHtml || undefined };
        const result = await api('/api/reply-tasks/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        closeReplyTasksSendModal();
        if (result.ok) { showMsg('发送成功并已标为 Done', false); document.getElementById('btnLoadReplyTasksList').click(); }
        else { showMsg(result.error || '发送失败', true); }
      } catch (err) { showMsg(err instanceof Error ? err.message : String(err), true); }
    };
    document.getElementById('btnSendBatchReplyTasks').onclick = async () => {
      showMsg('');
      try {
        const result = await api('/api/reply-tasks/send-batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        showMsg('批量发送: 共 ' + result.total + '，成功 ' + result.ok + '，失败 ' + result.failed, result.failed > 0);
        document.getElementById('btnLoadReplyTasksList').click();
      } catch (err) { showMsg(err instanceof Error ? err.message : String(err), true); }
    };

    /** 重绘时间区间与行业列表，保持数据一致 */
    function syncScheduleUI() {
      if (!currentSchedule) return;
      renderTimeSlots(currentSchedule);
      renderIndustries(currentSchedule);
    }

    const NEW_INDUSTRY_VALUE = '__new__';

    /** 将当前 DOM 中时间区间行的输入值写回 currentSchedule.timeSlots，避免重绘时丢失未保存编辑。小时 0–23，分 0–59。 */
    function syncTimeSlotsFromDOM() {
      if (!currentSchedule || !currentSchedule.timeSlots) return;
      const rows = timeSlotsContainer.querySelectorAll('.slot-row');
      rows.forEach((row, idx) => {
        if (idx >= currentSchedule.timeSlots.length) return;
        const slot = currentSchedule.timeSlots[idx];
        const startH = Number(row.querySelector('[data-key="startHour"]')?.value ?? 0);
        const startM = Number(row.querySelector('[data-key="startMinute"]')?.value ?? 0);
        const endH = Number(row.querySelector('[data-key="endHour"]')?.value ?? 23);
        const endM = Number(row.querySelector('[data-key="endMinute"]')?.value ?? 59);
        slot.startHour = (Number.isFinite(startH) && startH >= 0 && startH <= 23) ? startH | 0 : 0;
        slot.startMinute = (Number.isFinite(startM) && startM >= 0 && startM <= 59) ? startM | 0 : 0;
        slot.endHour = (Number.isFinite(endH) && endH >= 0 && endH <= 23) ? endH | 0 : 23;
        slot.endMinute = (Number.isFinite(endM) && endM >= 0 && endM <= 59) ? endM | 0 : 59;
        const industrySelect = row.querySelector('[data-key="industryId"]');
        if (industrySelect && industrySelect.value !== NEW_INDUSTRY_VALUE) slot.industryId = industrySelect.value;
      });
    }

    function renderTimeSlots(schedule) {
      syncTimeSlotsFromDOM();
      const slots = schedule.timeSlots || [];
      const industryIds = (schedule.industries || []).map(i => i.id);
      timeSlotsContainer.innerHTML = '';
      slots.forEach((slot, idx) => {
        const row = document.createElement('div');
        row.className = 'slot-row';
        let optHtml = industryIds.length
          ? industryIds.map(id => '<option value="' + escapeAttr(id) + '"' + (slot.industryId === id ? ' selected' : '') + '>' + escapeHtml(id) + '</option>').join('') + '<option value="' + NEW_INDUSTRY_VALUE + '">+ 新建行业</option>'
          : '<option value="">（先添加行业）</option><option value="' + NEW_INDUSTRY_VALUE + '">+ 新建行业</option>';
        row.innerHTML =
          '<span class="slot-time-group"><label>起</label><input type="number" min="0" max="23" data-key="startHour" placeholder="时" value="' + (slot.startHour ?? 0) + '" title="时" aria-label="起始小时">' +
          '<input type="number" min="0" max="59" data-key="startMinute" placeholder="分" value="' + (slot.startMinute ?? 0) + '" title="分" aria-label="起始分钟"></span>' +
          '<span class="slot-time-group"><label>止</label><input type="number" min="0" max="23" data-key="endHour" placeholder="时" value="' + (slot.endHour ?? 23) + '" title="时" aria-label="结束小时">' +
          '<input type="number" min="0" max="59" data-key="endMinute" placeholder="分" value="' + (slot.endMinute ?? 59) + '" title="分" aria-label="结束分钟"></span>' +
          '<select data-key="industryId" data-slot-index="' + idx + '">' + optHtml + '</select>' +
          '<button type="button" class="danger" data-remove-slot>删除</button>';
        const selectEl = row.querySelector('[data-key="industryId"]');
        selectEl.onchange = function() {
          if (selectEl.value !== NEW_INDUSTRY_VALUE) return;
          const newId = 'new_' + Date.now();
          const newInd = { id: newId, type: 'playwright', notionUrl: '', newChatEveryRunsMin: 1, newChatEveryRunsMax: 1, modelSwitchIntervalMin: 0, modelSwitchIntervalMax: 0, chainRunsPerSlot: 0, tasks: [{ content: '', runCount: 1 }] };
          schedule.industries.push(newInd);
          slot.industryId = newId;
          syncScheduleUI();
          openEditModal(schedule.industries.length - 1);
        };
        row.querySelector('[data-remove-slot]').onclick = () => { slots.splice(idx, 1); syncScheduleUI(); };
        timeSlotsContainer.appendChild(row);
      });
      document.getElementById('btnAddSlot').onclick = () => {
        slots.push({ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0, industryId: industryIds[0] || '' });
        syncScheduleUI();
      };
    }

    /** 行业主视图：类型 + id + 主 URL 截断 + 编辑、删除 */
    function renderIndustries(schedule) {
      const industries = schedule.industries || [];
      industriesContainer.innerHTML = '';
      industries.forEach((ind, indIdx) => {
        const isQueue = ind.type === 'queue';
        const typeLabel = isQueue ? 'Queue' : 'Playwright';
        const mainUrl = isQueue ? (ind.queueDatabaseUrl || '') : (ind.notionUrl || '');
        const row = document.createElement('div');
        row.className = 'industry-row';
        row.innerHTML = '<span class="type">' + escapeHtml(typeLabel) + '</span><span class="id">' + escapeHtml(ind.id || '') + '</span>' +
          '<span class="url" title="' + escapeAttr(mainUrl) + '">' + escapeHtml(truncateUrl(mainUrl)) + '</span>' +
          '<span class="actions"><button type="button" data-edit-industry>编辑</button><button type="button" class="danger" data-remove-industry>删除</button></span>';
        row.querySelector('[data-edit-industry]').onclick = () => openEditModal(indIdx);
        row.querySelector('[data-remove-industry]').onclick = () => removeIndustry(schedule, indIdx);
        industriesContainer.appendChild(row);
      });
      document.getElementById('btnAddIndustry').onclick = () => {
        industries.push({ id: 'new_' + Date.now(), type: 'playwright', notionUrl: '', newChatEveryRunsMin: 1, newChatEveryRunsMax: 1, modelSwitchIntervalMin: 0, modelSwitchIntervalMax: 0, chainRunsPerSlot: 0, tasks: [{ content: '', runCount: 1 }] });
        syncScheduleUI();
        openEditModal(industries.length - 1);
      };
    }

    /** 删除行业：从列表移除，并将引用该 id 的 timeSlot 改为剩余行业第一项 */
    function removeIndustry(schedule, indIdx) {
      const industries = schedule.industries || [];
      const removed = industries[indIdx];
      if (!removed) return;
      const oldId = removed.id;
      industries.splice(indIdx, 1);
      const firstId = industries.length ? industries[0].id : '';
      (schedule.timeSlots || []).forEach(slot => {
        if (slot.industryId === oldId) slot.industryId = firstId;
      });
      syncScheduleUI();
    }

    /** 当前编辑的行业在 schedule.industries 中的下标，-1 表示未打开 */
    let editingIndustryIndex = -1;

    function toggleModalIndustryType(isQueue) {
      document.getElementById('modalPlaywrightBlock').style.display = isQueue ? 'none' : '';
      document.getElementById('modalQueueBlock').style.display = isQueue ? '' : 'none';
    }

    function openEditModal(indIdx) {
      if (!currentSchedule || indIdx < 0 || indIdx >= (currentSchedule.industries || []).length) return;
      editingIndustryIndex = indIdx;
      const ind = currentSchedule.industries[indIdx];
      const isQueue = ind.type === 'queue';
      document.getElementById('industryModalTitle').textContent = ind.id ? ('编辑行业: ' + ind.id) : '新建行业';
      document.getElementById('modalIndustryId').value = ind.id || '';
      const typeRadios = document.querySelectorAll('input[name="modalIndustryType"]');
      typeRadios.forEach(r => { r.checked = (r.value === 'queue') === isQueue; });
      toggleModalIndustryType(isQueue);
      typeRadios.forEach(r => { r.onchange = () => toggleModalIndustryType(document.querySelector('input[name="modalIndustryType"]:checked').value === 'queue'); });
      document.getElementById('modalNotionUrl').value = ind.notionUrl || '';
      document.getElementById('modalNewChatEveryRunsMin').value = ind.newChatEveryRunsMin ?? 1;
      document.getElementById('modalNewChatEveryRunsMax').value = ind.newChatEveryRunsMax ?? 1;
      document.getElementById('modalModelSwitchIntervalMin').value = ind.modelSwitchIntervalMin ?? 0;
      document.getElementById('modalModelSwitchIntervalMax').value = ind.modelSwitchIntervalMax ?? 0;
      const modalChainRunsEl = document.getElementById('modalChainRunsPerSlot');
      if (modalChainRunsEl) modalChainRunsEl.value = (ind.chainRunsPerSlot ?? 0);
      document.getElementById('modalQueueDatabaseUrl').value = ind.queueDatabaseUrl || '';
      document.getElementById('modalSenderAccountsDatabaseUrl').value = ind.senderAccountsDatabaseUrl || '';
      document.getElementById('modalQueueBatchSize').value = (ind.batchSize ?? 20);
      const tasksContainer = document.getElementById('modalTasksContainer');
      tasksContainer.innerHTML = '';
      function removeTaskRow(row) {
        const rows = tasksContainer.querySelectorAll('.task-row');
        const idx = Array.from(rows).indexOf(row);
        if (idx >= 0 && ind.tasks) ind.tasks.splice(idx, 1);
        row.remove();
      }
      function appendTaskRow(task) {
        const tr = document.createElement('div');
        tr.className = 'task-row';
        tr.innerHTML = '<textarea data-key="content" placeholder="输入内容" rows="1">' + escapeHtml(task.content || '') + '</textarea>' +
          '<input type="number" data-key="runCount" min="1" placeholder="次数" value="' + (task.runCount ?? 1) + '" style="width:4rem">' +
          '<button type="button" class="danger" data-remove-task>删</button>';
        tr.querySelector('[data-remove-task]').onclick = () => removeTaskRow(tr);
        tasksContainer.appendChild(tr);
      }
      (ind.tasks || []).forEach((task) => appendTaskRow(task));
      document.getElementById('modalAddTask').onclick = () => {
        if (!ind.tasks) ind.tasks = [];
        ind.tasks.push({ content: '', runCount: 1 });
        appendTaskRow({ content: '', runCount: 1 });
      };
      document.getElementById('industryModal').classList.add('visible');
    }

    function closeEditModal() {
      editingIndustryIndex = -1;
      document.getElementById('industryModal').classList.remove('visible');
    }

    function saveEditModal() {
      if (!currentSchedule || editingIndustryIndex < 0) { closeEditModal(); return; }
      const ind = currentSchedule.industries[editingIndustryIndex];
      const oldId = (ind && ind.id) || '';
      const newId = document.getElementById('modalIndustryId').value.trim() || 'unnamed';
      const isQueue = document.querySelector('input[name="modalIndustryType"]:checked')?.value === 'queue';
      ind.id = newId;
      ind.type = isQueue ? 'queue' : 'playwright';
      if (isQueue) {
        ind.queueDatabaseUrl = document.getElementById('modalQueueDatabaseUrl').value.trim() || '';
        ind.senderAccountsDatabaseUrl = document.getElementById('modalSenderAccountsDatabaseUrl').value.trim() || '';
        const batchVal = Number(document.getElementById('modalQueueBatchSize').value);
        ind.batchSize = (Number.isInteger(batchVal) && batchVal >= 1 && batchVal <= 100) ? batchVal : 20;
      } else {
        const notionUrl = document.getElementById('modalNotionUrl').value.trim() || '';
        const newChatEveryRunsMin = Number(document.getElementById('modalNewChatEveryRunsMin').value);
        const newChatEveryRunsMax = Number(document.getElementById('modalNewChatEveryRunsMax').value);
        const modelSwitchIntervalMin = Number(document.getElementById('modalModelSwitchIntervalMin').value);
        const modelSwitchIntervalMax = Number(document.getElementById('modalModelSwitchIntervalMax').value);
        const chainRunsPerSlotVal = Number(document.getElementById('modalChainRunsPerSlot')?.value ?? 0);
        const tasks = [];
        document.querySelectorAll('#modalTasksContainer .task-row').forEach(tr => {
          const content = (tr.querySelector('[data-key="content"]') && tr.querySelector('[data-key="content"]').value) || '';
          const runCount = Number(tr.querySelector('[data-key="runCount"]') && tr.querySelector('[data-key="runCount"]').value) || 1;
          tasks.push({ content, runCount });
        });
        ind.notionUrl = notionUrl;
        const nMin = Number.isInteger(newChatEveryRunsMin) && newChatEveryRunsMin >= 0 ? newChatEveryRunsMin : 1;
        const nMax = Number.isInteger(newChatEveryRunsMax) && newChatEveryRunsMax >= 0 ? newChatEveryRunsMax : 1;
        ind.newChatEveryRunsMin = Math.min(nMin, nMax);
        ind.newChatEveryRunsMax = Math.max(nMin, nMax);
        const mMin = Number.isInteger(modelSwitchIntervalMin) && modelSwitchIntervalMin >= 0 ? modelSwitchIntervalMin : 0;
        const mMax = Number.isInteger(modelSwitchIntervalMax) && modelSwitchIntervalMax >= 0 ? modelSwitchIntervalMax : 0;
        ind.modelSwitchIntervalMin = Math.min(mMin, mMax);
        ind.modelSwitchIntervalMax = Math.max(mMin, mMax);
        const cr = Number.isInteger(chainRunsPerSlotVal) && chainRunsPerSlotVal >= 0 ? chainRunsPerSlotVal : 0;
        ind.chainRunsPerSlot = cr;
        ind.tasks = tasks;
      }
      if (oldId !== newId) {
        (currentSchedule.timeSlots || []).forEach(slot => {
          if (slot.industryId === oldId) slot.industryId = newId;
        });
      }
      closeEditModal();
      syncScheduleUI();
    }

    document.getElementById('modalSave').onclick = saveEditModal;
    document.getElementById('modalCancel').onclick = closeEditModal;
    /* 弹窗仅通过「保存」或「取消」关闭，点击遮罩不关闭 */

    function fillGlobal(schedule) {
      document.getElementById('intervalSecondsMin').value = schedule.intervalMinMs != null ? Math.round(schedule.intervalMinMs / 1000) : 120;
      document.getElementById('intervalSecondsMax').value = schedule.intervalMaxMs != null ? Math.round(schedule.intervalMaxMs / 1000) : 120;
      document.getElementById('loginWaitSeconds').value = schedule.loginWaitMs != null ? Math.round(schedule.loginWaitMs / 1000) : 60;
      document.getElementById('maxRetries').value = schedule.maxRetries ?? 3;
      const names = schedule.autoClickDuringOutputWait || [];
      autoClickButtonsContainer.innerHTML = '';
      names.forEach(function (name) {
        appendAutoClickRow(name);
      });
    }
    /** 在「自动点击按钮」列表末尾追加一行；value 为输入框初始值 */
    function appendAutoClickRow(value) {
      const row = document.createElement('div');
      row.className = 'row auto-click-row';
      row.innerHTML = '<input type="text" data-key="name" placeholder="例如 Delete pages" value="' + escapeAttr(value || '') + '" style="flex:1; max-width:20rem">' +
        '<button type="button" class="danger" data-remove-auto-click>删除</button>';
      row.querySelector('[data-remove-auto-click]').onclick = function () { row.remove(); };
      autoClickButtonsContainer.appendChild(row);
    }

    /** 从 DOM 收集时间区间，行业数据以内存 currentSchedule.industries 为准 */
    function collectSchedule() {
      const secMin = Number(document.getElementById('intervalSecondsMin').value) || 120;
      const secMax = Number(document.getElementById('intervalSecondsMax').value) || 120;
      const intervalMinMs = Math.min(secMin, secMax) * 1000;
      const intervalMaxMs = Math.max(secMin, secMax) * 1000;
      const loginWaitMs = (Number(document.getElementById('loginWaitSeconds').value) || 60) * 1000;
      const maxRetries = Number(document.getElementById('maxRetries').value) || 3;
      const slots = [];
      timeSlotsContainer.querySelectorAll('.slot-row').forEach(row => {
        const startHour = (Number(row.querySelector('[data-key="startHour"]')?.value) | 0);
        const startMinute = (Number(row.querySelector('[data-key="startMinute"]')?.value) | 0);
        const endHour = (Number(row.querySelector('[data-key="endHour"]')?.value) | 0);
        const endMinute = (Number(row.querySelector('[data-key="endMinute"]')?.value) | 0);
        const sh = (startHour >= 0 && startHour <= 23) ? startHour : 0;
        const sm = (startMinute >= 0 && startMinute <= 59) ? startMinute : 0;
        const eh = (endHour >= 0 && endHour <= 23) ? endHour : 23;
        const em = (endMinute >= 0 && endMinute <= 59) ? endMinute : 59;
        const industryId = (row.querySelector('[data-key="industryId"]') && row.querySelector('[data-key="industryId"]').value) || '';
        if (industryId === NEW_INDUSTRY_VALUE) return;
        slots.push({ startHour: sh, startMinute: sm, endHour: eh, endMinute: em, industryId });
      });
      const industries = (currentSchedule && currentSchedule.industries) ? currentSchedule.industries : [];
      const autoClickDuringOutputWait = [];
      autoClickButtonsContainer.querySelectorAll('.auto-click-row').forEach(function (row) {
        const input = row.querySelector('[data-key="name"]');
        const val = (input && input.value && input.value.trim()) || '';
        if (val) autoClickDuringOutputWait.push(val);
      });
      return { intervalMinMs, intervalMaxMs, loginWaitMs, maxRetries, storagePath: '.notion-auth.json', timeSlots: slots, industries, autoClickDuringOutputWait };
    }

    document.getElementById('btnAddAutoClickButton').onclick = function () { appendAutoClickRow(''); };

    async function loadSchedule() {
      const s = await api('/api/schedule');
      currentSchedule = s;
      fillGlobal(s);
      renderTimeSlots(s);
      renderIndustries(s);
    }

    document.getElementById('btnStart').onclick = async () => {
      showMsg('');
      try {
        const schedule = collectSchedule();
        await api('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule) });
        await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await refreshStatus();
        await refreshLogs();
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };
    document.getElementById('btnStop').onclick = async () => {
      showMsg('');
      try {
        await api('/api/stop', { method: 'POST' });
        await refreshStatus();
        await refreshLogs();
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };
    document.getElementById('btnQueueSenderStart').onclick = async () => {
      showMsg('');
      try {
        await api('/api/queue-sender/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await refreshQueueSenderStatus();
        await refreshLogs();
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };
    document.getElementById('btnQueueSenderStop').onclick = async () => {
      showMsg('');
      try {
        await api('/api/queue-sender/stop', { method: 'POST' });
        await refreshQueueSenderStatus();
        await refreshLogs();
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };
    document.getElementById('btnInboundListenerStart').onclick = async () => {
      showMsg('');
      try {
        await api('/api/inbound-listener/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await refreshInboundListenerStatus();
        await refreshLogs();
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };
    document.getElementById('btnInboundListenerStop').onclick = async () => {
      showMsg('');
      try {
        await api('/api/inbound-listener/stop', { method: 'POST' });
        await refreshInboundListenerStatus();
        await refreshLogs();
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };
    document.getElementById('btnSave').onclick = async () => {
      showMsg('');
      try {
        const schedule = collectSchedule();
        await api('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(schedule) });
        showMsg('已保存', false);
        setTimeout(() => showMsg(''), 2000);
      } catch (e) { showMsg(e instanceof Error ? e.message : String(e), true); }
    };

    document.getElementById('btnPullRestart').onclick = async () => {
      const btn = document.getElementById('btnPullRestart');
      showMsg('');
      btn.disabled = true;
      try {
        const res = await fetch('/api/pull-and-restart', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await res.json();
        if (data.ok === true) {
          showMsg('即将重启，请稍后刷新', false);
        } else {
          const parts = [data.error || res.statusText];
          if (data.stdout && data.stdout.trim()) parts.push('stdout: ' + data.stdout.trim());
          if (data.stderr && data.stderr.trim()) parts.push('stderr: ' + data.stderr.trim());
          showMsg(parts.join('\\n'), true);
        }
      } catch (e) {
        showMsg(e instanceof Error ? e.message : String(e), true);
      } finally {
        btn.disabled = false;
      }
    };

    let runs = [];
    function renderLogTabs() {
      logTabs.innerHTML = '';
      runs.forEach((r, i) => {
        const kind = r.kind === 'queue-sender' ? 'Queue' : r.kind === 'inbound-listener' ? 'Inbound' : 'Playwright';
        const label = r.endTime ? kind + ' #' + r.id + ' ' + new Date(r.startTime).toLocaleTimeString() : kind + ' #' + r.id + ' 运行中';
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.onclick = () => { logContent.textContent = (r.lines || []).join('\\n') || '（无输出）'; logTabs.querySelectorAll('button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); };
        logTabs.appendChild(btn);
        if (i === 0) { btn.click(); btn.classList.add('active'); }
      });
      if (runs.length === 0) logContent.textContent = '（暂无运行记录）';
    }
    async function refreshLogs() {
      const { runs: list } = await api('/api/logs');
      runs = list || [];
      renderLogTabs();
    }

    (async () => {
      try {
        await loadSchedule();
        await loadInboundListenerConfig();
        await loadReplyTasksConfig();
        await refreshStatus();
        await refreshQueueSenderStatus();
        await refreshInboundListenerStatus();
        await refreshLogs();
        setInterval(refreshStatus, 3000);
        setInterval(refreshQueueSenderStatus, 3000);
        setInterval(refreshInboundListenerStatus, 3000);
        setInterval(refreshLogs, 5000);
      } catch (e) {
        var errMsg = e instanceof Error ? e.message : String(e);
        if (msgEl) msgEl.textContent = '初始化失败: ' + errMsg + ' — 若持续出现，请用无痕模式或禁用本页的浏览器扩展后刷新';
        if (msgEl) msgEl.style.color = '#dc3545';
        console.error('[Dashboard] init error', e);
      }
    })();
  </script>
</body>
</html>`;
}

const server = createServer(handleRequest);

/** 方案 B：若为拉取并重启拉起的新进程，先延迟 2 秒再 listen，确保旧进程已 exit 释放端口 */
async function startListening(): Promise<void> {
  if (process.env.NOTION_AUTO_RESTART === "1") {
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  server.listen(PORT, HOST, () => {
    logger.info(`Dashboard: http://${HOST}:${PORT}`);
  });
}
startListening();
