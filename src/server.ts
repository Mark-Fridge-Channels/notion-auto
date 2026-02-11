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
import { loadSchedule, saveSchedule, getSchedulePath, mergeSchedule, validateSchedule } from "./schedule.js";
import { logger } from "./logger.js";

const PORT = 9000;
const HOST = "127.0.0.1";

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
      const runs = runner.getRecentRunLogs(10);
      sendJson(res, 200, { runs });
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
    .slot-row, .task-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.5rem; }
    .slot-row input[type="number"], .task-row input[type="number"] { width: 4rem; min-width: 3rem; }
    .slot-row select { flex: 1; min-width: 0; max-width: 12rem; }
    .industry-list { border: 1px solid #eee; border-radius: 6px; overflow: hidden; }
    .industry-row { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem 0.75rem; padding: 0.6rem 1rem; border-bottom: 1px solid #eee; background: #fff; }
    .industry-row:last-child { border-bottom: none; }
    .industry-row .id { font-weight: 600; min-width: 5rem; }
    .industry-row .url { flex: 1; min-width: 0; color: #666; font-size: 0.85rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .industry-row .actions { display: flex; gap: 0.35rem; flex-shrink: 0; }
    .modal-overlay { display: none; position: fixed; inset: 0; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); background: rgba(0,0,0,.4); z-index: 100; align-items: center; justify-content: center; overflow-y: auto; }
    .modal-overlay.visible { display: flex; }
    .modal-box { background: #fff; border-radius: 8px; padding: 1.25rem; min-width: 280px; max-width: min(90vw, 360px); max-height: 85vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,.15); margin: auto; }
    .modal-box h3 { margin: 0 0 1rem; font-size: 1rem; }
    .modal-box .form-actions { margin-top: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .modal-box .form-actions button { min-height: 44px; }
    .task-row textarea { flex: 1; min-width: 0; }
    .logs-card { grid-column: 1 / -1; }
    .logs { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; max-height: 380px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .log-tabs { margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .log-tabs button { min-height: 36px; padding: 0.35rem 0.65rem; border-radius: 4px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.8rem; touch-action: manipulation; }
    .log-tabs button.active { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    #msg { margin-top: 0.5rem; font-size: 0.875rem; min-height: 1.25em; word-break: break-word; }
    @media (max-width: 768px) {
      body { padding: 0.75rem; }
      .header { padding: 0.75rem; flex-direction: column; align-items: stretch; }
      .header .actions { width: 100%; }
      .header .actions button { flex: 1; min-width: 0; }
      .layout { grid-template-columns: 1fr; gap: 1rem; }
      .card { padding: 1rem; }
      .slot-row { flex-wrap: wrap; }
      .slot-row select { max-width: none; }
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
</head>
<body>
  <header class="header">
    <div>
      <h1>${pageTitle}</h1>
      <div id="statusEl" class="status" style="margin-top:0.5rem">加载中…</div>
    </div>
    <div>
      <div class="actions">
        <button type="button" id="btnStart" class="primary">启动</button>
        <button type="button" id="btnStop" class="danger">停止</button>
        <button type="button" id="btnSave">保存配置</button>
        <button type="button" id="btnPullRestart">拉取并重启</button>
      </div>
      <div id="msg"></div>
    </div>
  </header>

  <div class="layout">
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
    <div id="industryModal" class="modal-overlay">
      <div class="modal-box">
        <h3 id="industryModalTitle">编辑行业</h3>
        <div class="row"><label>行业 id（名称）</label><input type="text" id="modalIndustryId" placeholder="id"></div>
        <div class="row"><label>Notion Portal URL</label><input type="url" id="modalNotionUrl" placeholder="https://..."></div>
        <div class="row"><label>每 N 次开启新会话（区间内随机次数，每次开启新会话后更新N）</label><span><input type="number" id="modalNewChatEveryRunsMin" min="0" value="1" style="width:4rem"> ～ <input type="number" id="modalNewChatEveryRunsMax" min="0" value="1" style="width:4rem"></span></div>
        <div class="row"><label>每 M 次换模型（区间，0=不换）</label><span><input type="number" id="modalModelSwitchIntervalMin" min="0" value="0" style="width:4rem"> ～ <input type="number" id="modalModelSwitchIntervalMax" min="0" value="0" style="width:4rem"></span></div>
        <div class="row"><label>任务链</label><div id="modalTasksContainer"></div><button type="button" id="modalAddTask">添加任务</button></div>
        <div class="form-actions">
          <button type="button" id="modalSave" class="primary">保存</button>
          <button type="button" id="modalCancel">取消</button>
        </div>
      </div>
    </div>
    <div class="card logs-card">
      <h2>最近运行日志</h2>
      <div class="log-tabs" id="logTabs"></div>
      <div id="logContent" class="logs">（选择一次运行查看）</div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('statusEl');
    const msgEl = document.getElementById('msg');
    const timeSlotsContainer = document.getElementById('timeSlotsContainer');
    const industriesContainer = document.getElementById('industriesContainer');
    const logTabs = document.getElementById('logTabs');
    const logContent = document.getElementById('logContent');

    /** 当前页使用的 schedule，行业数据以内存为准，列表仅展示 */
    let currentSchedule = null;

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

    /** 重绘时间区间与行业列表，保持数据一致 */
    function syncScheduleUI() {
      if (!currentSchedule) return;
      renderTimeSlots(currentSchedule);
      renderIndustries(currentSchedule);
    }

    const NEW_INDUSTRY_VALUE = '__new__';
    function renderTimeSlots(schedule) {
      const slots = schedule.timeSlots || [];
      const industryIds = (schedule.industries || []).map(i => i.id);
      timeSlotsContainer.innerHTML = '';
      slots.forEach((slot, idx) => {
        const row = document.createElement('div');
        row.className = 'slot-row';
        let optHtml = industryIds.length
          ? industryIds.map(id => '<option value="' + escapeAttr(id) + '"' + (slot.industryId === id ? ' selected' : '') + '>' + escapeHtml(id) + '</option>').join('') + '<option value="' + NEW_INDUSTRY_VALUE + '">+ 新建行业</option>'
          : '<option value="">（先添加行业）</option><option value="' + NEW_INDUSTRY_VALUE + '">+ 新建行业</option>';
        row.innerHTML = '<label style="width:3rem">起</label><input type="number" min="0" max="23" data-key="startHour" placeholder="0" value="' + (slot.startHour ?? 0) + '">' +
          '<label style="width:3rem">止</label><input type="number" min="0" max="24" data-key="endHour" placeholder="24" value="' + (slot.endHour ?? 24) + '">' +
          '<select data-key="industryId" data-slot-index="' + idx + '">' + optHtml + '</select>' +
          '<button type="button" class="danger" data-remove-slot>删除</button>';
        const selectEl = row.querySelector('[data-key="industryId"]');
        selectEl.onchange = function() {
          if (selectEl.value !== NEW_INDUSTRY_VALUE) return;
          const newId = 'new_' + Date.now();
          const newInd = { id: newId, notionUrl: '', newChatEveryRunsMin: 1, newChatEveryRunsMax: 1, modelSwitchIntervalMin: 0, modelSwitchIntervalMax: 0, tasks: [{ content: '', runCount: 1 }] };
          schedule.industries.push(newInd);
          slot.industryId = newId;
          syncScheduleUI();
          openEditModal(schedule.industries.length - 1);
        };
        row.querySelector('[data-remove-slot]').onclick = () => { slots.splice(idx, 1); syncScheduleUI(); };
        timeSlotsContainer.appendChild(row);
      });
      document.getElementById('btnAddSlot').onclick = () => {
        slots.push({ startHour: 0, endHour: 1, industryId: industryIds[0] || '' });
        syncScheduleUI();
      };
    }

    /** 行业主视图：仅列表行（id、URL 截断、编辑、删除） */
    function renderIndustries(schedule) {
      const industries = schedule.industries || [];
      industriesContainer.innerHTML = '';
      industries.forEach((ind, indIdx) => {
        const row = document.createElement('div');
        row.className = 'industry-row';
        row.innerHTML = '<span class="id">' + escapeHtml(ind.id || '') + '</span>' +
          '<span class="url" title="' + escapeAttr(ind.notionUrl || '') + '">' + escapeHtml(truncateUrl(ind.notionUrl)) + '</span>' +
          '<span class="actions"><button type="button" data-edit-industry>编辑</button><button type="button" class="danger" data-remove-industry>删除</button></span>';
        row.querySelector('[data-edit-industry]').onclick = () => openEditModal(indIdx);
        row.querySelector('[data-remove-industry]').onclick = () => removeIndustry(schedule, indIdx);
        industriesContainer.appendChild(row);
      });
      document.getElementById('btnAddIndustry').onclick = () => {
        industries.push({ id: 'new_' + Date.now(), notionUrl: '', newChatEveryRunsMin: 1, newChatEveryRunsMax: 1, modelSwitchIntervalMin: 0, modelSwitchIntervalMax: 0, tasks: [{ content: '', runCount: 1 }] });
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

    function openEditModal(indIdx) {
      if (!currentSchedule || indIdx < 0 || indIdx >= (currentSchedule.industries || []).length) return;
      editingIndustryIndex = indIdx;
      const ind = currentSchedule.industries[indIdx];
      document.getElementById('industryModalTitle').textContent = ind.id ? ('编辑行业: ' + ind.id) : '新建行业';
      document.getElementById('modalIndustryId').value = ind.id || '';
      document.getElementById('modalNotionUrl').value = ind.notionUrl || '';
      document.getElementById('modalNewChatEveryRunsMin').value = ind.newChatEveryRunsMin ?? 1;
      document.getElementById('modalNewChatEveryRunsMax').value = ind.newChatEveryRunsMax ?? 1;
      document.getElementById('modalModelSwitchIntervalMin').value = ind.modelSwitchIntervalMin ?? 0;
      document.getElementById('modalModelSwitchIntervalMax').value = ind.modelSwitchIntervalMax ?? 0;
      const tasksContainer = document.getElementById('modalTasksContainer');
      tasksContainer.innerHTML = '';
      /** 删除任务：只移除该行并 splice，不重填表单，避免清空用户已填未保存内容 */
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
      const notionUrl = document.getElementById('modalNotionUrl').value.trim() || '';
      const newChatEveryRunsMin = Number(document.getElementById('modalNewChatEveryRunsMin').value);
      const newChatEveryRunsMax = Number(document.getElementById('modalNewChatEveryRunsMax').value);
      const modelSwitchIntervalMin = Number(document.getElementById('modalModelSwitchIntervalMin').value);
      const modelSwitchIntervalMax = Number(document.getElementById('modalModelSwitchIntervalMax').value);
      const tasks = [];
      document.querySelectorAll('#modalTasksContainer .task-row').forEach(tr => {
        const content = (tr.querySelector('[data-key="content"]') && tr.querySelector('[data-key="content"]').value) || '';
        const runCount = Number(tr.querySelector('[data-key="runCount"]') && tr.querySelector('[data-key="runCount"]').value) || 1;
        tasks.push({ content, runCount });
      });
      ind.id = newId;
      ind.notionUrl = notionUrl;
      const nMin = Number.isInteger(newChatEveryRunsMin) && newChatEveryRunsMin >= 0 ? newChatEveryRunsMin : 1;
      const nMax = Number.isInteger(newChatEveryRunsMax) && newChatEveryRunsMax >= 0 ? newChatEveryRunsMax : 1;
      ind.newChatEveryRunsMin = Math.min(nMin, nMax);
      ind.newChatEveryRunsMax = Math.max(nMin, nMax);
      const mMin = Number.isInteger(modelSwitchIntervalMin) && modelSwitchIntervalMin >= 0 ? modelSwitchIntervalMin : 0;
      const mMax = Number.isInteger(modelSwitchIntervalMax) && modelSwitchIntervalMax >= 0 ? modelSwitchIntervalMax : 0;
      ind.modelSwitchIntervalMin = Math.min(mMin, mMax);
      ind.modelSwitchIntervalMax = Math.max(mMin, mMax);
      ind.tasks = tasks;
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
        const startHour = Number(row.querySelector('[data-key="startHour"]').value) || 0;
        const endHour = Number(row.querySelector('[data-key="endHour"]').value);
        const endHourVal = (Number.isFinite(endHour) && endHour >= 0 && endHour <= 24) ? endHour : 24;
        const industryId = (row.querySelector('[data-key="industryId"]') && row.querySelector('[data-key="industryId"]').value) || '';
        if (industryId === NEW_INDUSTRY_VALUE) return;
        slots.push({ startHour, endHour: endHourVal, industryId });
      });
      const industries = (currentSchedule && currentSchedule.industries) ? currentSchedule.industries : [];
      return { intervalMinMs, intervalMaxMs, loginWaitMs, maxRetries, storagePath: '.notion-auth.json', timeSlots: slots, industries };
    }

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
        const btn = document.createElement('button');
        btn.textContent = r.endTime ? '运行 #' + r.id + ' (' + new Date(r.startTime).toLocaleTimeString() + ')' : '当前 #' + r.id;
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
      await loadSchedule();
      await refreshStatus();
      await refreshLogs();
      setInterval(refreshStatus, 3000);
      setInterval(refreshLogs, 5000);
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
