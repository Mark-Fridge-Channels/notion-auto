/**
 * Dashboard Web 服务：端口 9000，仅 localhost；API（状态/参数/停止·启动/日志）+ 单页 HTML。
 */

import { createServer } from "node:http";
import { join } from "node:path";
import {
  loadParams,
  saveParams,
  mergeAndValidate,
  getDefaultParams,
} from "./dashboard-params.js";
import * as runner from "./dashboard-runner.js";
import { logger } from "./logger.js";

const PORT = 9000;
const HOST = "127.0.0.1";
const PARAMS_PATH = join(process.cwd(), "params.json");

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
    if (path === "/api/params" && method === "GET") {
      const params = await loadParams(PARAMS_PATH);
      sendJson(res, 200, params);
      return;
    }
    if (path === "/api/params" && method === "POST") {
      const body = await readJsonBody(req);
      const params = mergeAndValidate(body);
      await saveParams(PARAMS_PATH, params);
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
      const body = await readJsonBody(req);
      const params = mergeAndValidate(body ?? await loadParams(PARAMS_PATH));
      runner.start(params);
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/logs" && method === "GET") {
      const runs = runner.getRecentRunLogs(10);
      sendJson(res, 200, { runs });
      return;
    }

    res.writeHead(404);
    res.end();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    sendJson(res, 400, { error: message });
  }
}

function getIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>notion-auto 控制台</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 0 auto; padding: 1.25rem; background: #f5f5f5; color: #333; }
    .header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; padding: 1rem; background: #fff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .header h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
    .status { padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.875rem; font-weight: 500; }
    .status.running { background: #d4edda; color: #155724; }
    .status.idle { background: #f8d7da; color: #721c24; }
    .actions { display: flex; gap: 0.5rem; }
    .actions button { padding: 0.45rem 1rem; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.875rem; }
    .actions button:hover:not(:disabled) { background: #f0f0f0; }
    .actions button:disabled { opacity: 0.6; cursor: not-allowed; }
    .actions button.primary { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    .actions button.primary:hover:not(:disabled) { background: #0b5ed7; }
    .actions button.danger { border-color: #dc3545; color: #dc3545; }
    .actions button.danger:hover:not(:disabled) { background: #fff5f5; }
    .layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    @media (max-width: 768px) { .layout { grid-template-columns: 1fr; } }
    .card { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .card h2 { margin: 0 0 1rem; font-size: 1rem; font-weight: 600; color: #555; }
    form .row { margin-bottom: 1rem; }
    form label { display: block; margin-bottom: 0.25rem; font-size: 0.875rem; font-weight: 500; }
    form label .required { color: #dc3545; margin-left: 0.15rem; }
    form label .hint { font-weight: normal; color: #888; font-size: 0.8rem; }
    form input, form textarea { width: 100%; padding: 0.45rem 0.6rem; border: 1px solid #ddd; border-radius: 6px; font-size: 0.875rem; }
    form input:focus, form textarea:focus { outline: none; border-color: #0d6efd; box-shadow: 0 0 0 2px rgba(13,110,253,.2); }
    form input.invalid { border-color: #dc3545; }
    form textarea { min-height: 56px; resize: vertical; }
    .logs-card { grid-column: 1 / -1; }
    .logs { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; max-height: 380px; overflow-y: auto; }
    .log-tabs { margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .log-tabs button { padding: 0.35rem 0.65rem; border-radius: 4px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.8rem; }
    .log-tabs button.active { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    #paramError { margin-top: 0.5rem; font-size: 0.875rem; min-height: 1.25em; }
  </style>
</head>
<body>
  <header class="header">
    <div>
      <h1>notion-auto 控制台</h1>
      <div id="statusEl" class="status" style="margin-top:0.5rem">加载中…</div>
    </div>
    <div>
      <div class="actions">
        <button type="button" id="btnStart" class="primary">启动</button>
        <button type="button" id="btnStop" class="danger">停止</button>
        <button type="button" id="btnSaveParams">保存参数</button>
      </div>
      <div id="paramError"></div>
    </div>
  </header>

  <div class="layout">
    <div class="card">
      <h2>运行设置</h2>
      <form id="paramsForm">
        <div class="row">
          <label>总轮数 (total) <span class="required">*</span> <span class="hint">必填，默认 25</span></label>
          <input name="totalRuns" type="number" min="1" placeholder="25" required>
        </div>
        <div class="row">
          <label>每轮间隔秒 (interval) <span class="required">*</span> <span class="hint">必填，默认 120</span></label>
          <input name="intervalSeconds" type="number" min="1" placeholder="120" required>
        </div>
        <div class="row">
          <label>登录等待秒 (login-wait) <span class="hint">默认 60</span></label>
          <input name="loginWaitSeconds" type="number" min="0" placeholder="60">
        </div>
        <div class="row">
          <label>Notion URL <span class="required">*</span> <span class="hint">必填，脚本打开后访问的地址</span></label>
          <input name="notionUrl" type="url" placeholder="https://www.notion.so/..." required>
        </div>
        <div class="row">
          <label>每 N 轮新建对话 (new-chat-every) <span class="required">*</span> <span class="hint">必填，最小 1，默认 10</span></label>
          <input name="newChatEveryRuns" type="number" min="1" placeholder="10" required>
        </div>
        <div class="row">
          <label>每 N 轮切换模型 <span class="hint">0=不切换，默认 50</span></label>
          <input name="modelSwitchInterval" type="number" min="0" placeholder="50">
        </div>
        <div class="row">
          <label>最大重试次数 <span class="hint">默认 3</span></label>
          <input name="maxRetries" type="number" min="1" placeholder="3">
        </div>
      </form>
    </div>
    <div class="card">
      <h2>文案设置</h2>
      <form id="paramsForm2">
        <div class="row">
          <label>Prompt 网关 (prompt-gateway) <span class="hint">填写则每轮使用该文案，<strong>有值时必填不可为空</strong>；留空则使用下方 Task 1/2/3</span></label>
          <input name="promptGateway" type="text" placeholder="留空则使用 task1/2/3">
        </div>
        <div class="row">
          <label>Task 1 <span class="hint">第 1～5 轮</span></label>
          <textarea name="promptTask1" placeholder="默认 @Task 1 — Add new DTC companies"></textarea>
        </div>
        <div class="row">
          <label>Task 2 <span class="hint">第 6～10 轮</span></label>
          <textarea name="promptTask2" placeholder="默认 @Task 2 — Find high-priority contacts"></textarea>
        </div>
        <div class="row">
          <label>Task 3 <span class="hint">第 11 轮起随机</span></label>
          <textarea name="promptTask3" placeholder="默认 @Task 3 — Find people contact ..."></textarea>
        </div>
      </form>
    </div>
    <div class="card logs-card">
      <h2>最近运行日志</h2>
      <div class="log-tabs" id="logTabs"></div>
      <div id="logContent" class="logs">（选择一次运行查看）</div>
    </div>
  </div>

  <script>
    const statusEl = document.getElementById('statusEl');
    const paramsForm = document.getElementById('paramsForm');
    const paramsForm2 = document.getElementById('paramsForm2');
    const logTabs = document.getElementById('logTabs');
    const logContent = document.getElementById('logContent');
    const paramError = document.getElementById('paramError');

    function showParamError(msg) {
      paramError.textContent = msg || '';
      paramError.style.display = msg ? 'block' : 'none';
      paramError.style.color = '#dc3545';
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

    async function loadParams() {
      const p = await api('/api/params');
      if (!p) return;
      paramsForm.totalRuns.value = p.totalRuns;
      paramsForm.intervalSeconds.value = p.intervalSeconds;
      paramsForm.loginWaitSeconds.value = p.loginWaitSeconds;
      paramsForm.notionUrl.value = p.notionUrl || '';
      paramsForm.newChatEveryRuns.value = p.newChatEveryRuns;
      paramsForm.modelSwitchInterval.value = p.modelSwitchInterval;
      paramsForm.maxRetries.value = p.maxRetries;
      paramsForm2.promptGateway.value = p.promptGateway || '';
      paramsForm2.promptTask1.value = p.promptTask1 || '';
      paramsForm2.promptTask2.value = p.promptTask2 || '';
      paramsForm2.promptTask3.value = p.promptTask3 || '';
    }

    function formToParams() {
      const gw = paramsForm2.promptGateway.value.trim();
      return {
        totalRuns: Number(paramsForm.totalRuns.value),
        intervalSeconds: Number(paramsForm.intervalSeconds.value),
        loginWaitSeconds: Number(paramsForm.loginWaitSeconds.value),
        notionUrl: String(paramsForm.notionUrl.value),
        newChatEveryRuns: Number(paramsForm.newChatEveryRuns.value),
        modelSwitchInterval: Number(paramsForm.modelSwitchInterval.value),
        promptGateway: gw === '' ? null : gw,
        promptTask1: String(paramsForm2.promptTask1.value),
        promptTask2: String(paramsForm2.promptTask2.value),
        promptTask3: String(paramsForm2.promptTask3.value),
        maxRetries: Number(paramsForm.maxRetries.value),
      };
    }

    function validateForm() {
      showParamError('');
      const total = Number(paramsForm.totalRuns.value);
      const interval = Number(paramsForm.intervalSeconds.value);
      const newChat = Number(paramsForm.newChatEveryRuns.value);
      const gw = paramsForm2.promptGateway.value.trim();
      if (!Number.isFinite(total) || total < 1) { showParamError('总轮数必填且为正整数'); return false; }
      if (!Number.isFinite(interval) || interval < 1) { showParamError('每轮间隔秒必填且为正整数'); return false; }
      if (!paramsForm.notionUrl.value.trim()) { showParamError('Notion URL 必填'); return false; }
      if (!Number.isFinite(newChat) || newChat < 1) { showParamError('每 N 轮新建对话必填且最小为 1'); return false; }
      if (gw.length > 0 && gw.replace(/\s/g, '') === '') { showParamError('使用 Prompt 网关时不可只填空格，请填写内容或留空'); return false; }
      return true;
    }

    document.getElementById('btnStart').onclick = async () => {
      showParamError('');
      if (!validateForm()) return;
      try {
        await api('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formToParams()) });
        await refreshStatus();
        await refreshLogs();
      } catch (e) { showParamError(e instanceof Error ? e.message : String(e)); }
    };
    document.getElementById('btnStop').onclick = async () => {
      await api('/api/stop', { method: 'POST' });
      await refreshStatus();
      await refreshLogs();
    };
    document.getElementById('btnSaveParams').onclick = async () => {
      showParamError('');
      if (!validateForm()) return;
      try {
        await api('/api/params', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(formToParams()) });
        paramError.textContent = '已保存';
        paramError.style.color = '#155724';
        paramError.style.display = 'block';
        setTimeout(() => showParamError(''), 2000);
      } catch (e) { showParamError(e instanceof Error ? e.message : String(e)); }
    };

    let runs = [];
    function renderLogTabs() {
      logTabs.innerHTML = '';
      runs.forEach((r, i) => {
        const btn = document.createElement('button');
        const label = r.endTime ? '运行 #' + r.id + ' (' + new Date(r.startTime).toLocaleTimeString() + ')' : '当前运行 #' + r.id;
        btn.textContent = label;
        btn.onclick = () => { logContent.textContent = r.lines.join('\\n') || '（无输出）'; logTabs.querySelectorAll('button').forEach(b => b.classList.remove('active')); btn.classList.add('active'); };
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
      await loadParams();
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
server.listen(PORT, HOST, () => {
  logger.info(`Dashboard: http://${HOST}:${PORT}`);
});
