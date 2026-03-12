/**
 * Dashboard Web 服务：端口 9000，仅 localhost；提供主脚本与 Warmup Executor 的状态、配置、日志与拉取重启。
 */

import "dotenv/config";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { resolve, relative } from "node:path";
import * as runner from "./dashboard-runner.js";
import * as queueSenderRunner from "./dashboard-queue-sender-runner.js";
import {
  loadSchedule,
  saveSchedule,
  getSchedulePath,
  mergeSchedule,
  validateSchedule,
  getDefaultSchedule,
  type QueueThrottle,
} from "./schedule.js";
import {
  loadQueueSenderConfigOrDefault,
  saveQueueSenderConfig,
  validateQueueSenderConfig,
} from "./queue-sender-config.js";
import { logger } from "./logger.js";

const PORT = 9000;
const HOST = "127.0.0.1";
const DEFAULT_BATCH_SIZE = 20;

function shutdown(): void {
  queueSenderRunner.stopQueueSender();
  runner.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

let isPullRestartInProgress = false;

function resolveConfigPath(configured: string | undefined): string {
  const base = getSchedulePath();
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

function sendHtml(res: import("node:http").ServerResponse, html: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function runGitPull(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const child = spawn("git", ["pull"], { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    function finish(exitCode: number, out: string, err: string) {
      if (settled) return;
      settled = true;
      resolveResult({ exitCode, stdout: out, stderr: err });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0), stdout, stderr));
    child.on("error", (err) => finish(1, stdout, (err?.message ?? String(err)) + "\n"));
  });
}

function runNpmInstall(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    const cmd = process.platform === "win32" ? "npm i" : "npm";
    const args = process.platform === "win32" ? [] : ["i"];
    const opts: Parameters<typeof spawn>[2] = { cwd };
    if (process.platform === "win32") opts.shell = true;
    const child = spawn(cmd, args, opts);
    let stdout = "";
    let stderr = "";
    let settled = false;
    function finish(exitCode: number, out: string, err: string) {
      if (settled) return;
      settled = true;
      resolveResult({ exitCode, stdout: out, stderr: err });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0), stdout, stderr));
    child.on("error", (err) => finish(1, stdout, (err?.message ?? String(err)) + "\n"));
  });
}

function spawnNewServerAndExit(): void {
  queueSenderRunner.stopQueueSender();
  runner.stop();
  const env = { ...process.env, NOTION_AUTO_RESTART: "1" };
  const opts = {
    cwd: process.cwd(),
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

  try {
    if (path === "/" && method === "GET") {
      sendHtml(res, getDashboardHtml());
      return;
    }
    if (path === "/api/status" && method === "GET") {
      sendJson(res, 200, { status: runner.getRunStatus() });
      return;
    }
    if (path === "/api/schedule" && method === "GET") {
      sendJson(res, 200, await loadSchedule(getSchedulePath()));
      return;
    }
    if (path === "/api/schedule" && method === "POST") {
      const schedule = mergeSchedule(await readJsonBody(req));
      validateSchedule(schedule);
      await saveSchedule(getSchedulePath(), schedule);
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
      const schedule = await loadSchedule(getSchedulePath());
      const qt: QueueThrottle = schedule.queueThrottle ?? getDefaultSchedule().queueThrottle!;
      const prevDay = process.env.QUEUE_THROTTLE_MAX_PER_DAY;
      process.env.QUEUE_THROTTLE_MAX_PER_DAY = String(qt.maxPerDay ?? 50);
      if (queueSenderRunner.getQueueSenderStatus() !== "running") {
        queueSenderRunner.startQueueSender();
      }
      runner.start({ configPath });
      if (prevDay !== undefined) process.env.QUEUE_THROTTLE_MAX_PER_DAY = prevDay;
      else delete process.env.QUEUE_THROTTLE_MAX_PER_DAY;
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/stop" && method === "POST") {
      runner.stop();
      queueSenderRunner.stopQueueSender();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/logs" && method === "GET") {
      const u = new URL(req.url ?? "", `http://${req.headers.host}`);
      const kind = u.searchParams.get("kind")?.toLowerCase().trim() === "queue-sender" ? "queue-sender" : "playwright";
      const runs = kind === "playwright"
        ? runner.getRecentRunLogs(10).map((r) => ({ kind: "playwright" as const, ...r }))
        : queueSenderRunner.getQueueSenderRunLogs(10).map((r) => ({ kind: "queue-sender" as const, ...r }));
      sendJson(res, 200, { runs });
      return;
    }
    if (path === "/api/queue-sender/status" && method === "GET") {
      sendJson(res, 200, { status: queueSenderRunner.getQueueSenderStatus() });
      return;
    }
    if (path === "/api/queue-sender/start" && method === "POST") {
      if (queueSenderRunner.getQueueSenderStatus() === "running") {
        sendJson(res, 400, { error: "Warmup Executor 已在运行，请先停止" });
        return;
      }
      const schedule = await loadSchedule(getSchedulePath());
      const qt: QueueThrottle = schedule.queueThrottle ?? getDefaultSchedule().queueThrottle!;
      const prevDay = process.env.QUEUE_THROTTLE_MAX_PER_DAY;
      process.env.QUEUE_THROTTLE_MAX_PER_DAY = String(qt.maxPerDay ?? 50);
      try {
        queueSenderRunner.startQueueSender();
      } finally {
        if (prevDay !== undefined) process.env.QUEUE_THROTTLE_MAX_PER_DAY = prevDay;
        else delete process.env.QUEUE_THROTTLE_MAX_PER_DAY;
      }
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
    if (path === "/api/queue-sender/config" && method === "GET") {
      sendJson(res, 200, await loadQueueSenderConfigOrDefault());
      return;
    }
    if (path === "/api/queue-sender/config" && method === "POST") {
      const config = validateQueueSenderConfig(await readJsonBody(req));
      await saveQueueSenderConfig(config);
      res.writeHead(204);
      res.end();
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
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

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
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 0 auto; padding: 1.25rem; background: #f5f5f5; color: #333; }
    .header, .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .header { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; padding: 1rem; }
    .header h1 { margin: 0; font-size: 1.25rem; }
    .status { display: inline-block; padding: 0.35rem 0.75rem; border-radius: 6px; font-size: 0.875rem; font-weight: 500; }
    .status.running { background: #d4edda; color: #155724; }
    .status.idle { background: #f8d7da; color: #721c24; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    button { min-height: 40px; padding: 0.5rem 0.9rem; border-radius: 8px; border: 1px solid #ddd; background: #fff; cursor: pointer; }
    button.primary { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    button.danger { color: #dc3545; border-color: #dc3545; }
    .tabs { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
    .tabs button.active { background: #0d6efd; border-color: #0d6efd; color: #fff; }
    .panel { display: none; }
    .panel.active { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .card { padding: 1rem; }
    .card h2 { margin-top: 0; font-size: 1rem; }
    .row { margin-bottom: 0.9rem; }
    label { display: block; margin-bottom: 0.25rem; font-size: 0.9rem; font-weight: 500; }
    .hint { color: #666; font-size: 0.8rem; }
    input, textarea, select { width: 100%; padding: 0.5rem 0.65rem; border: 1px solid #ddd; border-radius: 6px; font-size: 16px; }
    textarea { min-height: 56px; resize: vertical; }
    .slot-row, .task-row, .list-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; padding: 0.6rem; border: 1px solid #eee; border-radius: 6px; margin-bottom: 0.6rem; background: #fafafa; }
    .list-row .title { font-weight: 600; min-width: 5rem; }
    .list-row .url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #666; }
    .slot-row input[type="number"], .task-row input[type="number"] { width: 5rem; }
    .logs { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; max-height: 360px; overflow-y: auto; }
    .log-tabs { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
    .log-tabs button.active { background: #0d6efd; border-color: #0d6efd; color: #fff; }
    .full { grid-column: 1 / -1; }
    .modal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); align-items: center; justify-content: center; padding: 1rem; }
    .modal.visible { display: flex; }
    .modal-box { width: min(90vw, 720px); max-height: 85vh; overflow-y: auto; background: #fff; border-radius: 8px; padding: 1rem; }
    .form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 1rem; }
    #msg { margin-top: 0.5rem; min-height: 1.2rem; font-size: 0.9rem; word-break: break-word; }
    @media (max-width: 768px) {
      body { padding: 0.75rem; }
      .panel.active { grid-template-columns: 1fr; }
      .header { flex-direction: column; }
      .actions { width: 100%; }
      .actions button { flex: 1; }
    }
  </style>
</head>
<body>
  <header class="header">
    <div>
      <h1>${pageTitle}</h1>
      <div id="statusEl" class="status" style="margin-top:0.5rem">加载中…</div>
      <div id="warmupStatusEl" class="status" style="margin-top:0.25rem">Warmup Executor：—</div>
    </div>
    <div>
      <div class="actions">
        <button id="btnStart" class="primary" type="button">启动</button>
        <button id="btnStop" class="danger" type="button">停止</button>
        <button id="btnSave" type="button">保存配置</button>
        <button id="btnPullRestart" type="button">拉取并重启</button>
      </div>
      <div id="msg"></div>
    </div>
  </header>

  <nav class="tabs" id="tabNav">
    <button class="active" data-tab="main" type="button">主视图</button>
    <button data-tab="warmup" type="button">Warmup Executor 配置</button>
  </nav>

  <section id="panel-main" class="panel active">
    <div class="card">
      <h2>全局设置</h2>
      <div class="row">
        <label>每隔多少秒检查一次对话结束 <span class="hint">最小～最大，默认 120～120</span></label>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <input id="intervalSecondsMin" type="number" min="1" placeholder="120">
          <span>～</span>
          <input id="intervalSecondsMax" type="number" min="1" placeholder="120">
        </div>
      </div>
      <div class="row">
        <label>首次登录等待秒数 <span class="hint">默认 60</span></label>
        <input id="loginWaitSeconds" type="number" min="0" placeholder="60">
      </div>
      <div class="row">
        <label>最大重试次数 <span class="hint">默认 3</span></label>
        <input id="maxRetries" type="number" min="1" placeholder="3">
      </div>
      <div class="row">
        <label>Warmup 启动时兼容注入的每日上限 <span class="hint">默认 50</span></label>
        <input id="queueThrottleMaxPerDay" type="number" min="1" placeholder="50">
      </div>
      <div class="row">
        <label>等待输出期间自动点击按钮 <span class="hint">精确匹配按钮文案</span></label>
        <div id="autoClickButtonsContainer"></div>
        <button id="btnAddAutoClickButton" class="primary" type="button" style="margin-top:0.4rem;">添加一项</button>
      </div>
    </div>

    <div class="card">
      <h2>时间区间 <span class="hint">左闭右开，本地时区</span></h2>
      <div id="timeSlotsContainer"></div>
      <button id="btnAddSlot" class="primary" type="button">添加时间区间</button>
    </div>

    <div class="card full">
      <h2>行业与任务链</h2>
      <div id="industriesContainer"></div>
      <button id="btnAddIndustry" class="primary" type="button">添加行业</button>
    </div>

    <div class="card full">
      <h2>Playwright 最近运行日志</h2>
      <div id="playwrightLogTabs" class="log-tabs"></div>
      <div id="playwrightLogContent" class="logs">（选择一次运行查看）</div>
    </div>
  </section>

  <section id="panel-warmup" class="panel">
    <div class="card full">
      <h2>Warmup Executor 配置 <span class="hint">写入 queue-sender.json</span></h2>
      <p class="hint">每条配置对应一套 Warmup 数据层：Queue、Credential Registry、Execution Log、Conversation Event Log、BandWidth Detail、Warmup Mailbox Pool。</p>
      <div id="warmupEntriesContainer"></div>
      <button id="btnAddWarmupEntry" class="primary" type="button">添加一条</button>
      <button id="btnSaveWarmupConfig" class="primary" type="button">保存 Warmup 配置</button>
    </div>

    <div class="card full">
      <h2>Warmup Executor 最近运行日志</h2>
      <div id="warmupLogTabs" class="log-tabs"></div>
      <div id="warmupLogContent" class="logs">（选择一次运行查看）</div>
    </div>
  </section>

  <div id="industryModal" class="modal">
    <div class="modal-box">
      <h3 id="industryModalTitle">编辑行业</h3>
      <div class="row"><label>行业 id</label><input id="modalIndustryId" type="text" placeholder="id"></div>
      <div class="row"><label>Notion Portal URL</label><input id="modalNotionUrl" type="url" placeholder="https://..."></div>
      <div class="row"><label>每 N 次开启新会话</label><div style="display:flex;gap:0.5rem;align-items:center;"><input id="modalNewChatEveryRunsMin" type="number" min="0"><span>～</span><input id="modalNewChatEveryRunsMax" type="number" min="0"></div></div>
      <div class="row"><label>每 M 次换模型（0=不换）</label><div style="display:flex;gap:0.5rem;align-items:center;"><input id="modalModelSwitchIntervalMin" type="number" min="0"><span>～</span><input id="modalModelSwitchIntervalMax" type="number" min="0"></div></div>
      <div class="row"><label>时段内跑几轮任务链（0=一直跑）</label><input id="modalChainRunsPerSlot" type="number" min="0"></div>
      <div class="row"><label>任务链</label><div id="modalTasksContainer"></div><button id="modalAddTask" type="button">添加任务</button></div>
      <div class="form-actions">
        <button id="modalSaveIndustry" class="primary" type="button">保存</button>
        <button id="modalCancelIndustry" type="button">取消</button>
      </div>
    </div>
  </div>

  <div id="warmupModal" class="modal">
    <div class="modal-box">
      <h3>编辑 Warmup 条目</h3>
      <div class="row"><label>显示名</label><input id="modalWarmupName" type="text" placeholder="主 Warmup"></div>
      <div class="row"><label>Email Warmup Queue URL</label><input id="modalWarmupQueueUrl" type="url" placeholder="https://www.notion.so/..."></div>
      <div class="row"><label>Credential Registry URL</label><input id="modalWarmupCredentialUrl" type="url" placeholder="https://www.notion.so/..."></div>
      <div class="row"><label>Execution Log URL</label><input id="modalWarmupExecutionLogUrl" type="url" placeholder="https://www.notion.so/..."></div>
      <div class="row"><label>Conversation Event Log URL</label><input id="modalWarmupConversationLogUrl" type="url" placeholder="https://www.notion.so/..."></div>
      <div class="row"><label>BandWidth Detail URL</label><input id="modalWarmupBandwidthUrl" type="url" placeholder="https://www.notion.so/..."></div>
      <div class="row"><label>Warmup Mailbox Pool URL</label><input id="modalWarmupMailboxPoolUrl" type="url" placeholder="https://www.notion.so/..."></div>
      <div class="row"><label>每批条数</label><input id="modalWarmupBatchSize" type="number" min="1" max="100" value="${DEFAULT_BATCH_SIZE}"></div>
      <div class="form-actions">
        <button id="modalSaveWarmup" class="primary" type="button">保存</button>
        <button id="modalCancelWarmup" type="button">取消</button>
      </div>
    </div>
  </div>

  <script>
    const NEW_INDUSTRY_VALUE = '__new__';
    const DEFAULT_BATCH_SIZE = ${DEFAULT_BATCH_SIZE};
    let currentSchedule = null;
    let currentWarmupConfig = null;
    let editingIndustryIndex = -1;
    let editingWarmupIndex = -1;
    let playwrightRuns = [];
    let warmupRuns = [];

    const statusEl = document.getElementById('statusEl');
    const warmupStatusEl = document.getElementById('warmupStatusEl');
    const msgEl = document.getElementById('msg');
    const timeSlotsContainer = document.getElementById('timeSlotsContainer');
    const industriesContainer = document.getElementById('industriesContainer');
    const autoClickButtonsContainer = document.getElementById('autoClickButtonsContainer');
    const warmupEntriesContainer = document.getElementById('warmupEntriesContainer');

    function showMsg(text, isError) {
      msgEl.textContent = text || '';
      msgEl.style.color = isError ? '#dc3545' : '#155724';
    }
    function escapeHtml(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function escapeAttr(s) { return escapeHtml(s); }
    function truncateUrl(url) {
      if (!url || !String(url).trim()) return '—';
      const s = String(url).trim();
      return s.length <= 48 ? s : s.slice(0, 45) + '...';
    }
    async function api(path, opts) {
      const res = await fetch(path, opts);
      if (res.status === 204) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    (function initTabs() {
      const nav = document.getElementById('tabNav');
      nav.querySelectorAll('button[data-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          nav.querySelectorAll('button[data-tab]').forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
          btn.classList.add('active');
          document.getElementById('panel-' + btn.getAttribute('data-tab')).classList.add('active');
        });
      });
    })();

    function appendAutoClickRow(value) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.innerHTML = '<input type="text" data-key="name" value="' + escapeAttr(value || '') + '" placeholder="按钮名称">' +
        '<button type="button" class="danger" data-remove>删除</button>';
      row.querySelector('[data-remove]').onclick = () => row.remove();
      autoClickButtonsContainer.appendChild(row);
    }

    function fillSchedule(schedule) {
      document.getElementById('intervalSecondsMin').value = Math.round((schedule.intervalMinMs ?? 120000) / 1000);
      document.getElementById('intervalSecondsMax').value = Math.round((schedule.intervalMaxMs ?? 120000) / 1000);
      document.getElementById('loginWaitSeconds').value = Math.round((schedule.loginWaitMs ?? 60000) / 1000);
      document.getElementById('maxRetries').value = schedule.maxRetries ?? 3;
      document.getElementById('queueThrottleMaxPerDay').value = (schedule.queueThrottle && schedule.queueThrottle.maxPerDay) || 50;
      autoClickButtonsContainer.innerHTML = '';
      (schedule.autoClickDuringOutputWait || []).forEach((name) => appendAutoClickRow(name));
    }

    function syncTimeSlotsFromDom() {
      if (!currentSchedule) return;
      const rows = timeSlotsContainer.querySelectorAll('.slot-row');
      rows.forEach((row, idx) => {
        if (idx >= currentSchedule.timeSlots.length) return;
        const slot = currentSchedule.timeSlots[idx];
        const startHour = Number(row.querySelector('[data-key="startHour"]').value);
        const startMinute = Number(row.querySelector('[data-key="startMinute"]').value);
        const endHour = Number(row.querySelector('[data-key="endHour"]').value);
        const endMinute = Number(row.querySelector('[data-key="endMinute"]').value);
        const industryId = row.querySelector('[data-key="industryId"]').value;
        slot.startHour = Number.isInteger(startHour) ? Math.max(0, Math.min(23, startHour)) : 0;
        slot.startMinute = Number.isInteger(startMinute) ? Math.max(0, Math.min(59, startMinute)) : 0;
        slot.endHour = Number.isInteger(endHour) ? Math.max(0, Math.min(23, endHour)) : 23;
        slot.endMinute = Number.isInteger(endMinute) ? Math.max(0, Math.min(59, endMinute)) : 59;
        if (industryId && industryId !== NEW_INDUSTRY_VALUE) slot.industryId = industryId;
      });
    }

    function renderTimeSlots() {
      if (!currentSchedule) return;
      syncTimeSlotsFromDom();
      const industryIds = currentSchedule.industries.map((ind) => ind.id);
      timeSlotsContainer.innerHTML = '';
      currentSchedule.timeSlots.forEach((slot, idx) => {
        const row = document.createElement('div');
        row.className = 'slot-row';
        const selectHtml = (industryIds.length
          ? industryIds.map((id) => '<option value="' + escapeAttr(id) + '"' + (slot.industryId === id ? ' selected' : '') + '>' + escapeHtml(id) + '</option>').join('')
          : '<option value="">（先添加行业）</option>') +
          '<option value="' + NEW_INDUSTRY_VALUE + '">+ 新建行业</option>';
        row.innerHTML =
          '<label>起</label><input data-key="startHour" type="number" min="0" max="23" value="' + slot.startHour + '">' +
          '<input data-key="startMinute" type="number" min="0" max="59" value="' + slot.startMinute + '">' +
          '<label>止</label><input data-key="endHour" type="number" min="0" max="23" value="' + slot.endHour + '">' +
          '<input data-key="endMinute" type="number" min="0" max="59" value="' + slot.endMinute + '">' +
          '<select data-key="industryId">' + selectHtml + '</select>' +
          '<button type="button" class="danger" data-remove>删除</button>';
        row.querySelector('[data-key="industryId"]').onchange = (event) => {
          const value = event.target.value;
          if (value !== NEW_INDUSTRY_VALUE) return;
          const newIndustry = {
            id: 'new_' + Date.now(),
            type: 'playwright',
            notionUrl: '',
            newChatEveryRunsMin: 1,
            newChatEveryRunsMax: 1,
            modelSwitchIntervalMin: 0,
            modelSwitchIntervalMax: 0,
            chainRunsPerSlot: 0,
            tasks: [{ content: '', runCount: 1 }]
          };
          currentSchedule.industries.push(newIndustry);
          currentSchedule.timeSlots[idx].industryId = newIndustry.id;
          renderTimeSlots();
          renderIndustries();
          openIndustryModal(currentSchedule.industries.length - 1);
        };
        row.querySelector('[data-remove]').onclick = () => {
          currentSchedule.timeSlots.splice(idx, 1);
          renderTimeSlots();
        };
        timeSlotsContainer.appendChild(row);
      });
    }

    function renderIndustries() {
      if (!currentSchedule) return;
      industriesContainer.innerHTML = '';
      currentSchedule.industries.forEach((industry, idx) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = '<span class="title">' + escapeHtml(industry.id) + '</span>' +
          '<span class="url" title="' + escapeAttr(industry.notionUrl || '') + '">' + escapeHtml(truncateUrl(industry.notionUrl || '')) + '</span>' +
          '<button type="button" data-edit>编辑</button>' +
          '<button type="button" class="danger" data-remove>删除</button>';
        row.querySelector('[data-edit]').onclick = () => openIndustryModal(idx);
        row.querySelector('[data-remove]').onclick = () => {
          const removed = currentSchedule.industries[idx];
          currentSchedule.industries.splice(idx, 1);
          const fallback = currentSchedule.industries[0] ? currentSchedule.industries[0].id : '';
          currentSchedule.timeSlots.forEach((slot) => {
            if (slot.industryId === removed.id) slot.industryId = fallback;
          });
          renderIndustries();
          renderTimeSlots();
        };
        industriesContainer.appendChild(row);
      });
    }

    function openIndustryModal(index) {
      if (!currentSchedule) return;
      editingIndustryIndex = index;
      const industry = currentSchedule.industries[index];
      document.getElementById('industryModalTitle').textContent = industry.id ? '编辑行业: ' + industry.id : '新建行业';
      document.getElementById('modalIndustryId').value = industry.id || '';
      document.getElementById('modalNotionUrl').value = industry.notionUrl || '';
      document.getElementById('modalNewChatEveryRunsMin').value = industry.newChatEveryRunsMin ?? 1;
      document.getElementById('modalNewChatEveryRunsMax').value = industry.newChatEveryRunsMax ?? 1;
      document.getElementById('modalModelSwitchIntervalMin').value = industry.modelSwitchIntervalMin ?? 0;
      document.getElementById('modalModelSwitchIntervalMax').value = industry.modelSwitchIntervalMax ?? 0;
      document.getElementById('modalChainRunsPerSlot').value = industry.chainRunsPerSlot ?? 0;
      const tasksContainer = document.getElementById('modalTasksContainer');
      tasksContainer.innerHTML = '';
      function appendTask(task) {
        const row = document.createElement('div');
        row.className = 'task-row';
        row.innerHTML = '<textarea data-key="content" placeholder="任务内容">' + escapeHtml(task.content || '') + '</textarea>' +
          '<input data-key="runCount" type="number" min="1" value="' + (task.runCount || 1) + '">' +
          '<button type="button" class="danger" data-remove>删</button>';
        row.querySelector('[data-remove]').onclick = () => row.remove();
        tasksContainer.appendChild(row);
      }
      (industry.tasks || []).forEach((task) => appendTask(task));
      document.getElementById('modalAddTask').onclick = () => appendTask({ content: '', runCount: 1 });
      document.getElementById('industryModal').classList.add('visible');
    }

    function closeIndustryModal() {
      editingIndustryIndex = -1;
      document.getElementById('industryModal').classList.remove('visible');
    }

    function saveIndustryModal() {
      if (!currentSchedule || editingIndustryIndex < 0) return closeIndustryModal();
      const industry = currentSchedule.industries[editingIndustryIndex];
      const oldId = industry.id;
      const newId = document.getElementById('modalIndustryId').value.trim() || 'unnamed';
      industry.id = newId;
      industry.notionUrl = document.getElementById('modalNotionUrl').value.trim();
      const nMin = Number(document.getElementById('modalNewChatEveryRunsMin').value);
      const nMax = Number(document.getElementById('modalNewChatEveryRunsMax').value);
      const mMin = Number(document.getElementById('modalModelSwitchIntervalMin').value);
      const mMax = Number(document.getElementById('modalModelSwitchIntervalMax').value);
      const chainRuns = Number(document.getElementById('modalChainRunsPerSlot').value);
      industry.newChatEveryRunsMin = Number.isInteger(nMin) ? Math.max(0, Math.min(nMin, nMax || nMin)) : 1;
      industry.newChatEveryRunsMax = Number.isInteger(nMax) ? Math.max(industry.newChatEveryRunsMin, nMax) : industry.newChatEveryRunsMin;
      industry.modelSwitchIntervalMin = Number.isInteger(mMin) ? Math.max(0, Math.min(mMin, mMax || mMin)) : 0;
      industry.modelSwitchIntervalMax = Number.isInteger(mMax) ? Math.max(industry.modelSwitchIntervalMin, mMax) : industry.modelSwitchIntervalMin;
      industry.chainRunsPerSlot = Number.isInteger(chainRuns) && chainRuns >= 0 ? chainRuns : 0;
      industry.tasks = Array.from(document.querySelectorAll('#modalTasksContainer .task-row')).map((row) => ({
        content: row.querySelector('[data-key="content"]').value || '',
        runCount: Number(row.querySelector('[data-key="runCount"]').value) || 1,
      }));
      currentSchedule.timeSlots.forEach((slot) => {
        if (slot.industryId === oldId) slot.industryId = newId;
      });
      closeIndustryModal();
      renderIndustries();
      renderTimeSlots();
    }

    function renderWarmupEntries() {
      if (!currentWarmupConfig) return;
      warmupEntriesContainer.innerHTML = '';
      currentWarmupConfig.entries.forEach((entry, idx) => {
        const row = document.createElement('div');
        row.className = 'list-row';
        row.innerHTML = '<span class="title">' + escapeHtml(entry.name || '—') + '</span>' +
          '<span class="url" title="' + escapeAttr(entry.queue_database_url || '') + '">' + escapeHtml(truncateUrl(entry.queue_database_url || '')) + '</span>' +
          '<span class="url" title="' + escapeAttr(entry.credential_registry_database_url || '') + '">' + escapeHtml(truncateUrl(entry.credential_registry_database_url || '')) + '</span>' +
          '<span class="hint">' + ((entry.batch_size != null ? entry.batch_size : DEFAULT_BATCH_SIZE) + ' 条/批') + '</span>' +
          '<button type="button" data-edit>编辑</button>' +
          '<button type="button" class="danger" data-remove>删除</button>';
        row.querySelector('[data-edit]').onclick = () => openWarmupModal(idx);
        row.querySelector('[data-remove]').onclick = () => {
          currentWarmupConfig.entries.splice(idx, 1);
          renderWarmupEntries();
        };
        warmupEntriesContainer.appendChild(row);
      });
    }

    function openWarmupModal(index) {
      editingWarmupIndex = index;
      const entry = currentWarmupConfig.entries[index] || {};
      document.getElementById('modalWarmupName').value = entry.name || '';
      document.getElementById('modalWarmupQueueUrl').value = entry.queue_database_url || '';
      document.getElementById('modalWarmupCredentialUrl').value = entry.credential_registry_database_url || '';
      document.getElementById('modalWarmupExecutionLogUrl').value = entry.execution_log_database_url || '';
      document.getElementById('modalWarmupConversationLogUrl').value = entry.conversation_event_log_database_url || '';
      document.getElementById('modalWarmupBandwidthUrl').value = entry.bandwidth_detail_database_url || '';
      document.getElementById('modalWarmupMailboxPoolUrl').value = entry.warmup_mailbox_pool_database_url || '';
      document.getElementById('modalWarmupBatchSize').value = entry.batch_size != null ? entry.batch_size : DEFAULT_BATCH_SIZE;
      document.getElementById('warmupModal').classList.add('visible');
    }

    function closeWarmupModal() {
      editingWarmupIndex = -1;
      document.getElementById('warmupModal').classList.remove('visible');
    }

    function saveWarmupModal() {
      if (!currentWarmupConfig || editingWarmupIndex < 0) return closeWarmupModal();
      const entry = currentWarmupConfig.entries[editingWarmupIndex];
      entry.name = document.getElementById('modalWarmupName').value.trim() || '未命名';
      entry.queue_database_url = document.getElementById('modalWarmupQueueUrl').value.trim();
      entry.credential_registry_database_url = document.getElementById('modalWarmupCredentialUrl').value.trim();
      entry.execution_log_database_url = document.getElementById('modalWarmupExecutionLogUrl').value.trim();
      entry.conversation_event_log_database_url = document.getElementById('modalWarmupConversationLogUrl').value.trim();
      entry.bandwidth_detail_database_url = document.getElementById('modalWarmupBandwidthUrl').value.trim();
      entry.warmup_mailbox_pool_database_url = document.getElementById('modalWarmupMailboxPoolUrl').value.trim();
      const batchSize = Number(document.getElementById('modalWarmupBatchSize').value);
      entry.batch_size = Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 100 ? batchSize : DEFAULT_BATCH_SIZE;
      closeWarmupModal();
      renderWarmupEntries();
    }

    function collectSchedule() {
      syncTimeSlotsFromDom();
      const secMin = Number(document.getElementById('intervalSecondsMin').value) || 120;
      const secMax = Number(document.getElementById('intervalSecondsMax').value) || 120;
      const loginWaitMs = (Number(document.getElementById('loginWaitSeconds').value) || 60) * 1000;
      const maxRetries = Number(document.getElementById('maxRetries').value) || 3;
      const throttlePerDay = Number(document.getElementById('queueThrottleMaxPerDay').value);
      const autoClickDuringOutputWait = Array.from(autoClickButtonsContainer.querySelectorAll('[data-key="name"]'))
        .map((input) => input.value.trim())
        .filter(Boolean);
      return {
        intervalMinMs: Math.min(secMin, secMax) * 1000,
        intervalMaxMs: Math.max(secMin, secMax) * 1000,
        loginWaitMs,
        maxRetries,
        storagePath: '.notion-auth.json',
        timeSlots: currentSchedule.timeSlots,
        industries: currentSchedule.industries,
        autoClickDuringOutputWait,
        queueThrottle: {
          maxPerDay: Number.isInteger(throttlePerDay) && throttlePerDay >= 1 ? throttlePerDay : 50,
        },
      };
    }

    function renderRunTabs(targetTabs, targetContent, runs) {
      targetTabs.innerHTML = '';
      runs.forEach((run, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = run.endTime ? ('#' + run.id + ' ' + new Date(run.startTime).toLocaleTimeString()) : ('#' + run.id + ' 运行中');
        btn.onclick = () => {
          targetTabs.querySelectorAll('button').forEach((item) => item.classList.remove('active'));
          btn.classList.add('active');
          targetContent.textContent = (run.lines || []).join('\\n') || '（无输出）';
        };
        targetTabs.appendChild(btn);
        if (idx === 0) btn.click();
      });
      if (runs.length === 0) targetContent.textContent = '（暂无运行记录）';
    }

    async function refreshStatus() {
      const { status } = await api('/api/status');
      statusEl.textContent = status === 'running' ? 'Notion Auto 运行中' : 'Notion Auto 已停止';
      statusEl.className = 'status ' + status;
      document.getElementById('btnStart').disabled = status === 'running';
      document.getElementById('btnStop').disabled = status === 'idle';
    }

    async function refreshWarmupStatus() {
      const { status } = await api('/api/queue-sender/status');
      warmupStatusEl.textContent = status === 'running' ? 'Warmup Executor：运行中' : 'Warmup Executor：已停止';
      warmupStatusEl.className = 'status ' + status;
    }

    async function refreshLogs() {
      const play = await api('/api/logs?kind=playwright');
      const warm = await api('/api/logs?kind=queue-sender');
      playwrightRuns = play.runs || [];
      warmupRuns = warm.runs || [];
      renderRunTabs(document.getElementById('playwrightLogTabs'), document.getElementById('playwrightLogContent'), playwrightRuns);
      renderRunTabs(document.getElementById('warmupLogTabs'), document.getElementById('warmupLogContent'), warmupRuns);
    }

    async function loadScheduleState() {
      currentSchedule = await api('/api/schedule');
      fillSchedule(currentSchedule);
      renderTimeSlots();
      renderIndustries();
    }

    async function loadWarmupConfig() {
      currentWarmupConfig = await api('/api/queue-sender/config');
      renderWarmupEntries();
    }

    document.getElementById('btnAddAutoClickButton').onclick = () => appendAutoClickRow('');
    document.getElementById('btnAddSlot').onclick = () => {
      const firstIndustryId = currentSchedule && currentSchedule.industries[0] ? currentSchedule.industries[0].id : '';
      currentSchedule.timeSlots.push({ startHour: 0, startMinute: 0, endHour: 1, endMinute: 0, industryId: firstIndustryId });
      renderTimeSlots();
    };
    document.getElementById('btnAddIndustry').onclick = () => {
      currentSchedule.industries.push({
        id: 'new_' + Date.now(),
        type: 'playwright',
        notionUrl: '',
        newChatEveryRunsMin: 1,
        newChatEveryRunsMax: 1,
        modelSwitchIntervalMin: 0,
        modelSwitchIntervalMax: 0,
        chainRunsPerSlot: 0,
        tasks: [{ content: '', runCount: 1 }],
      });
      renderIndustries();
      renderTimeSlots();
      openIndustryModal(currentSchedule.industries.length - 1);
    };
    document.getElementById('modalSaveIndustry').onclick = saveIndustryModal;
    document.getElementById('modalCancelIndustry').onclick = closeIndustryModal;
    document.getElementById('btnAddWarmupEntry').onclick = () => {
      currentWarmupConfig.entries.push({
        name: '',
        queue_database_url: '',
        credential_registry_database_url: '',
        execution_log_database_url: '',
        conversation_event_log_database_url: '',
        bandwidth_detail_database_url: '',
        warmup_mailbox_pool_database_url: '',
        batch_size: DEFAULT_BATCH_SIZE,
      });
      openWarmupModal(currentWarmupConfig.entries.length - 1);
    };
    document.getElementById('modalSaveWarmup').onclick = saveWarmupModal;
    document.getElementById('modalCancelWarmup').onclick = closeWarmupModal;

    document.getElementById('btnSave').onclick = async () => {
      showMsg('');
      try {
        await api('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectSchedule()),
        });
        showMsg('已保存', false);
        setTimeout(() => showMsg(''), 2000);
      } catch (error) {
        showMsg(error instanceof Error ? error.message : String(error), true);
      }
    };

    document.getElementById('btnStart').onclick = async () => {
      showMsg('');
      try {
        await api('/api/schedule', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(collectSchedule()),
        });
        await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await refreshStatus();
        await refreshWarmupStatus();
        await refreshLogs();
      } catch (error) {
        showMsg(error instanceof Error ? error.message : String(error), true);
      }
    };

    document.getElementById('btnStop').onclick = async () => {
      showMsg('');
      try {
        await api('/api/stop', { method: 'POST' });
        await refreshStatus();
        await refreshWarmupStatus();
        await refreshLogs();
      } catch (error) {
        showMsg(error instanceof Error ? error.message : String(error), true);
      }
    };

    document.getElementById('btnSaveWarmupConfig').onclick = async () => {
      showMsg('');
      try {
        await api('/api/queue-sender/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(currentWarmupConfig),
        });
        showMsg('Warmup Executor 配置已保存', false);
        setTimeout(() => showMsg(''), 2000);
      } catch (error) {
        showMsg(error instanceof Error ? error.message : String(error), true);
      }
    };

    document.getElementById('btnPullRestart').onclick = async () => {
      const button = document.getElementById('btnPullRestart');
      showMsg('');
      button.disabled = true;
      try {
        const response = await fetch('/api/pull-and-restart', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        const data = await response.json();
        if (data.ok === true) {
          showMsg('即将重启，请稍后刷新', false);
        } else {
          const parts = [data.error || response.statusText];
          if (data.stdout && data.stdout.trim()) parts.push('stdout: ' + data.stdout.trim());
          if (data.stderr && data.stderr.trim()) parts.push('stderr: ' + data.stderr.trim());
          showMsg(parts.join('\\n'), true);
        }
      } catch (error) {
        showMsg(error instanceof Error ? error.message : String(error), true);
      } finally {
        button.disabled = false;
      }
    };

    (async () => {
      try {
        await loadScheduleState();
        await loadWarmupConfig();
        await refreshStatus();
        await refreshWarmupStatus();
        await refreshLogs();
        setInterval(refreshStatus, 3000);
        setInterval(refreshWarmupStatus, 3000);
        setInterval(refreshLogs, 5000);
      } catch (error) {
        showMsg('初始化失败: ' + (error instanceof Error ? error.message : String(error)), true);
      }
    })();
  </script>
</body>
</html>`;
}

const server = createServer(handleRequest);

async function startListening(): Promise<void> {
  if (process.env.NOTION_AUTO_RESTART === "1") {
    await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
  }
  server.listen(PORT, HOST, () => {
    logger.info(`Dashboard: http://${HOST}:${PORT}`);
    if (queueSenderRunner.getQueueSenderStatus() !== "running") {
      loadSchedule(getSchedulePath())
        .then((schedule) => {
          const qt = schedule.queueThrottle ?? getDefaultSchedule().queueThrottle!;
          const prev = process.env.QUEUE_THROTTLE_MAX_PER_DAY;
          process.env.QUEUE_THROTTLE_MAX_PER_DAY = String(qt.maxPerDay ?? 50);
          queueSenderRunner.startQueueSender();
          if (prev !== undefined) process.env.QUEUE_THROTTLE_MAX_PER_DAY = prev;
          else delete process.env.QUEUE_THROTTLE_MAX_PER_DAY;
        })
        .catch((error) => logger.warn("Warmup Executor 启动时加载 schedule 失败", error));
    }
    setInterval(() => {
      if (queueSenderRunner.getQueueSenderStatus() === "idle") {
        loadSchedule(getSchedulePath())
          .then((schedule) => {
            const qt = schedule.queueThrottle ?? getDefaultSchedule().queueThrottle!;
            const prev = process.env.QUEUE_THROTTLE_MAX_PER_DAY;
            process.env.QUEUE_THROTTLE_MAX_PER_DAY = String(qt.maxPerDay ?? 50);
            queueSenderRunner.startQueueSender();
            if (prev !== undefined) process.env.QUEUE_THROTTLE_MAX_PER_DAY = prev;
            else delete process.env.QUEUE_THROTTLE_MAX_PER_DAY;
          })
          .catch((error) => logger.warn("Warmup Executor watcher 加载 schedule 失败", error));
      }
    }, 60_000);
  });
}

startListening();
