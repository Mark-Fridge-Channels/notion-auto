/**
 * Dashboard Web 服务：端口 9000，默认 0.0.0.0（支持局域网访问）；API 支持多账号。
 * 支持同时管理多个账号（各自有独立的 config, storage, 子进程）。
 * 启动前加载 .env（dotenv），以便全局环境变量生效。
 */

import "dotenv/config";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdir, stat as fsStat, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as accountManager from "./account-manager.js";
import { mergeSchedule } from "./schedule.js";
import { logger } from "./logger.js";

const PORT = Number(process.env.PORT) || 9000;
const HOST = process.env.HOST || "0.0.0.0";

let isPullRestartInProgress = false;

async function readJsonBody(req: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw);
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
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0), stdout, stderr));
    child.on("error", (err) => { stderr += (err?.message ?? String(err)) + "\\n"; finish(1, stdout, stderr); });
  });
}

function runNpmInstall(cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
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
      resolve({ exitCode, stdout: out, stderr: err });
    }
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });
    child.on("close", (code, signal) => finish(code ?? (signal ? 1 : 0), stdout, stderr));
    child.on("error", (err) => { stderr += (err?.message ?? String(err)) + "\\n"; finish(1, stdout, stderr); });
  });
}

function spawnNewServerAndExit(): void {
  const env = { ...process.env, NOTION_AUTO_RESTART: "1" };
  const cwd = process.cwd();
  const opts = { cwd, env, detached: true, stdio: "ignore" as const };
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
  const [path] = url.split("?");

  try {
    if (path === "/" && method === "GET") {
      sendHtml(res, getDashboardHtml());
      return;
    }

    if (path === "/api/accounts" && method === "GET") {
      sendJson(res, 200, accountManager.listAccounts());
      return;
    }
    if (path === "/api/accounts" && method === "POST") {
      const body = await readJsonBody(req) as { id: string; label: string };
      await accountManager.addAccount(body.id, body.label);
      res.writeHead(204);
      res.end();
      return;
    }

    const accountMatch = path.match(new RegExp("^/api/accounts/([^/]+)(?:/(.+))?$"));
    if (accountMatch) {
      const accountId = decodeURIComponent(accountMatch[1]);
      const action = accountMatch[2];

      if (!action && method === "DELETE") {
        await accountManager.removeAccount(accountId);
        res.writeHead(204);
        res.end();
        return;
      }
      if (action === "status" && method === "GET") {
        sendJson(res, 200, { status: accountManager.getAccountStatus(accountId) });
        return;
      }
      if (action === "start" && method === "POST") {
        accountManager.startAccount(accountId);
        res.writeHead(204);
        res.end();
        return;
      }
      if (action === "stop" && method === "POST") {
        accountManager.stopAccount(accountId);
        res.writeHead(204);
        res.end();
        return;
      }
      if (action === "schedule" && method === "GET") {
        const schedule = await accountManager.getAccountSchedule(accountId);
        sendJson(res, 200, schedule);
        return;
      }
      if (action === "schedule" && method === "POST") {
        const body = await readJsonBody(req);
        const schedule = mergeSchedule(body);
        await accountManager.saveAccountScheduleData(accountId, schedule);
        res.writeHead(204);
        res.end();
        return;
      }
      if (action === "logs" && method === "GET") {
        const runs = accountManager.getAccountLogs(accountId, 10);
        sendJson(res, 200, { runs });
        return;
      }
    }

    if (path === "/api/start-all" && method === "POST") {
      accountManager.startAll();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/stop-all" && method === "POST") {
      accountManager.stopAll();
      res.writeHead(204);
      res.end();
      return;
    }
    if (path === "/api/broadcast-schedule" && method === "POST") {
      const body = await readJsonBody(req) as { schedule: unknown; accountIds?: string[] };
      const schedule = mergeSchedule(body.schedule);
      const saved = await accountManager.broadcastSchedule(schedule, body.accountIds);
      sendJson(res, 200, { saved });
      return;
    }

    if (path === "/api/pull-and-restart" && method === "POST") {
      if (isPullRestartInProgress) {
        sendJson(res, 409, { error: "拉取并重启正在进行中" });
        return;
      }
      isPullRestartInProgress = true;
      try {
        accountManager.stopAll();
        // Wait briefly for stops
        await new Promise((r) => setTimeout(r, 3000));
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
        setTimeout(() => process.exit(0), 100);
      } finally {
        isPullRestartInProgress = false;
      }
      return;
    }

    // 列出 serviceFailed 目录的文件（项目级，所有账号共用）
    if (path === "/api/service-failed" && method === "GET") {
      const dir = join(process.cwd(), "serviceFailed");
      try {
        const names = await readdir(dir);
        const files = await Promise.all(
          names.map(async (name) => {
            const s = await fsStat(join(dir, name));
            return { name, size: s.size, mtime: s.mtimeMs };
          }),
        );
        files.sort((a, b) => b.mtime - a.mtime);
        sendJson(res, 200, { files });
      } catch {
        sendJson(res, 200, { files: [] });
      }
      return;
    }

    // 下载 / 查看 serviceFailed 目录中的单个文件
    const sfFileMatch = path.match(/^\/api\/service-failed\/([^/]+)$/);
    if (sfFileMatch && method === "GET") {
      const filename = decodeURIComponent(sfFileMatch[1]);
      // 安全校验：禁止路径穿越
      if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
        res.writeHead(400);
        res.end();
        return;
      }
      const filePath = join(process.cwd(), "serviceFailed", filename);
      try {
        const data = await readFile(filePath);
        const ext = filename.split(".").pop()?.toLowerCase() ?? "";
        const ct = ext === "png" ? "image/png" : ext === "html" ? "text/html; charset=utf-8" : "application/octet-stream";
        const inline = ext === "html";
        res.writeHead(200, {
          "Content-Type": ct,
          "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end();
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

function getDashboardTitle(): string {
  const name = (process.env.NOTION_AUTO_NAME ?? "").trim();
  if (!name) return "notion-auto 多账号控制台";
  const safe = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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
    html { -webkit-text-size-adjust: 100%; height: 100%; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; background: #f5f5f5; color: #333; height: 100%; display: flex; flex-direction: column; }
    
    .top-bar { display: flex; align-items: center; justify-content: space-between; padding: 1rem; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); z-index: 10; }
    .top-bar h1 { margin: 0; font-size: 1.25rem; font-weight: 600; }
    .top-bar .global-actions { display: flex; gap: 0.5rem; }
    
    button { min-height: 36px; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 0.875rem; touch-action: manipulation; transition: all 0.2s; }
    button:hover:not(:disabled) { background: #f0f0f0; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    button.primary { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    button.primary:hover:not(:disabled) { background: #0b5ed7; }
    button.danger { border-color: #dc3545; color: #dc3545; }
    button.danger:hover:not(:disabled) { background: #fff5f5; }
    
    .main-container { display: flex; flex: 1; overflow: hidden; }
    
    /* Left sidebar */
    .sidebar { width: 280px; background: #fafafa; border-right: 1px solid #ddd; display: flex; flex-direction: column; overflow-y: auto; }
    .sidebar-header { padding: 1rem; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
    .account-list { flex: 1; overflow-y: auto; padding: 0.5rem; }
    .account-item { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem; margin-bottom: 0.5rem; background: #fff; border: 1px solid #eee; border-radius: 6px; cursor: pointer; transition: all 0.2s; }
    .account-item:hover { border-color: #ccc; }
    .account-item.active { border-color: #0d6efd; box-shadow: 0 0 0 1px #0d6efd; }
    .account-item .info { display: flex; align-items: center; gap: 0.5rem; overflow: hidden; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; background: #ccc; flex-shrink: 0; }
    .status-dot.running { background: #28a745; box-shadow: 0 0 5px rgba(40,167,69,0.5); }
    .account-item .name { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 0.95rem; }
    .account-item .actions { display: flex; gap: 0.25rem; flex-shrink: 0; }
    .account-item .actions button { padding: 0.25rem 0.5rem; min-height: 28px; font-size: 0.75rem; }
    
    /* Right content */
    .content { flex: 1; overflow-y: auto; padding: 1.5rem; display: flex; flex-direction: column; }
    .no-selection { margin: auto; color: #888; text-align: center; }
    
    /* Content sections */
    .account-header { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid #ddd; }
    .account-header h2 { margin: 0 0 0.5rem 0; font-size: 1.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .account-id-badge { font-size: 0.8rem; background: #eee; padding: 0.2rem 0.5rem; border-radius: 4px; font-weight: normal; color: #666; }
    .account-header-actions { display: flex; gap: 0.5rem; align-items: center; }
    #msg { font-size: 0.875rem; margin-right: 1rem; font-weight: 500; }
    
    /* Layout inside config */
    .config-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
    .card { background: #fff; border-radius: 8px; padding: 1.25rem; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .card h3 { margin: 0 0 1rem; font-size: 1.1rem; font-weight: 600; color: #444; border-bottom: 1px solid #f0f0f0; padding-bottom: 0.5rem; }
    
    /* Form elements */
    .row { margin-bottom: 1rem; }
    label { display: block; margin-bottom: 0.25rem; font-size: 0.875rem; font-weight: 500; }
    .hint { font-weight: normal; color: #888; font-size: 0.8rem; }
    input, textarea, select { width: 100%; padding: 0.5rem 0.65rem; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
    input:focus, textarea:focus, select:focus { outline: 2px solid #0d6efd; outline-offset: 1px; }
    textarea { min-height: 48px; resize: vertical; }
    
    /* Config specifics */
    .slot-row, .task-row { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
    .slot-row { padding: 0.6rem 0.75rem; background: #f8f9fa; border-radius: 6px; border: 1px solid #eee; }
    .slot-time-group { display: inline-flex; align-items: center; gap: 0.35rem; margin-right: 0.5rem; }
    .slot-time-group label { margin: 0; font-size: 0.8rem; color: #666; flex-shrink: 0; }
    .slot-row input[type="number"], .task-row input[type="number"] { width: 3.5rem; padding: 0.4rem; }
    .slot-row select { flex: 1; min-width: 8rem; }
    
    .industry-list { border: 1px solid #eee; border-radius: 6px; overflow: hidden; }
    .industry-row { display: flex; align-items: center; justify-content: space-between; padding: 0.6rem 1rem; border-bottom: 1px solid #eee; background: #fff; }
    .industry-row:last-child { border-bottom: none; }
    .industry-row .details { display: flex; flex-direction: column; min-width: 0; flex: 1; margin-right: 1rem; }
    .industry-row .id { font-weight: 600; font-size: 0.9rem; margin-bottom: 0.2rem; }
    .industry-row .url { color: #666; font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    
    .logs-card { grid-column: 1 / -1; }
    .logs { background: #1e1e1e; color: #d4d4d4; padding: 1rem; border-radius: 6px; font-family: ui-monospace, monospace; font-size: 12px; white-space: pre-wrap; max-height: 380px; overflow-y: auto; }
    .log-tabs { margin-bottom: 0.5rem; display: flex; flex-wrap: wrap; gap: 0.35rem; }
    .log-tabs button { min-height: 32px; padding: 0.25rem 0.65rem; font-size: 0.8rem; }
    .log-tabs button.active { background: #0d6efd; color: #fff; border-color: #0d6efd; }
    
    /* Modals */
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 100; align-items: center; justify-content: center; }
    .modal-overlay.visible { display: flex; }
    .modal-box { background: #fff; border-radius: 8px; padding: 1.5rem; min-width: 320px; max-width: min(90vw, 600px); max-height: 85vh; overflow-y: auto; box-shadow: 0 4px 20px rgba(0,0,0,.15); }
    .modal-box h3 { margin: 0 0 1rem; font-size: 1.25rem; }
    .modal-box .form-actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; justify-content: flex-end; }
    
    /* Broadcast dialog specific */
    .account-checkbox-list { border: 1px solid #ddd; border-radius: 6px; max-height: 200px; overflow-y: auto; padding: 0.5rem; margin-top: 0.5rem; }
    .account-checkbox-list label { display: flex; align-items: center; gap: 0.5rem; padding: 0.25rem 0; cursor: pointer; font-size: 0.9rem; font-weight: normal; margin-bottom: 0; }
    
    .sf-pair { display:flex; align-items:center; justify-content:space-between; padding:0.65rem 1rem; border-bottom:1px solid #eee; background:#fff; gap:0.75rem; }
    .sf-pair:last-child { border-bottom:none; }
    .sf-pair:hover { background:#fafafa; }
    .sf-meta { flex:1; min-width:0; }
    .sf-meta .sf-name { font-size:0.875rem; font-weight:600; color:#333; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .sf-meta .sf-time { font-size:0.78rem; color:#888; margin-top:0.15rem; }
    .sf-actions { display:flex; gap:0.4rem; flex-shrink:0; }
    .sf-actions a { display:inline-block; padding:0.25rem 0.6rem; font-size:0.78rem; border-radius:5px; border:1px solid #ddd; background:#fff; color:#333; text-decoration:none; white-space:nowrap; cursor:pointer; transition:background 0.15s; }
    .sf-actions a:hover { background:#f0f0f0; }
    .sf-empty { padding:2rem; text-align:center; color:#888; font-size:0.9rem; }

    @media (max-width: 768px) {
      .main-container { flex-direction: column; }
      .sidebar { width: 100%; border-right: none; border-bottom: 1px solid #ddd; max-height: 30vh; }
      .config-layout { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="top-bar">
    <h1>${pageTitle}</h1>
    <div class="global-actions">
      <label style="display:flex;align-items:center;gap:0.3rem;cursor:pointer;font-size:0.85rem;color:#495057;user-select:none;">
        <input type="checkbox" id="globalHeadless"> 所有强制后台运行
      </label>
      <button onclick="startAll()" class="primary">全部启动</button>
      <button onclick="stopAll()" class="danger">全部停止</button>
      <button onclick="pullAndRestart()">拉取并重启</button>
      <button onclick="openServiceFailedModal()" style="border-color:#f0ad4e;color:#856404;">失败记录</button>
    </div>
  </div>
  
  <div class="main-container">
    <div class="sidebar">
      <div class="sidebar-header">
        <h2 style="margin:0;font-size:1rem;">账号列表</h2>
        <button onclick="openAddAccountModal()" class="primary" style="padding:0.25rem 0.6rem;min-height:28px;font-size:0.8rem;">+ 添加</button>
      </div>
      <div class="account-list" id="accountList"></div>
    </div>
    
    <div class="content" id="mainContent">
      <div class="no-selection" id="noSelectionMsg">
        <h2>请在左侧选择一个账号</h2>
        <p>或点击右上角“添加”增加新账号</p>
      </div>
      <div id="accountConfig" style="display:none;">
        <div class="account-header">
          <div>
            <h2 id="viewAccountName">Account Name <span class="account-id-badge" id="viewAccountId">id</span></h2>
            <div style="font-size:0.9rem;display:flex;align-items:center;gap:0.5rem;">
              状态: <span id="viewAccountStatus" style="font-weight:600;">获取中...</span>
            </div>
          </div>
          <div class="account-header-actions">
            <span id="msg"></span>
            <button id="btnStart" class="primary" onclick="startCurrent()">启动</button>
            <button id="btnStop" class="danger" onclick="stopCurrent()">停止</button>
            <button onclick="saveCurrent()" class="primary">保存配置</button>
            <button onclick="openBroadcastModal()">广播配置</button>
            <button onclick="deleteCurrent()" class="danger">删除账号</button>
          </div>
        </div>
        
        <div class="config-layout">
          <!-- Global settings -->
          <div class="card">
            <h3>全局设置</h3>
            <div class="row">
              <label>发送间隔（秒） <span class="hint">min~max</span></label>
              <div style="display:flex;gap:0.5rem;align-items:center;">
                <input id="intervalMin" type="number" style="width:5rem"> ~ <input id="intervalMax" type="number" style="width:5rem">
              </div>
            </div>
            <div class="row">
              <label>首次登录等待超时（秒）</label>
              <input id="loginWait" type="number" style="width:8rem">
            </div>
            <div class="row">
              <label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;">
                <input id="headless" type="checkbox" style="width:auto;"> 后台运行 (不显示浏览器窗口)
              </label>
            </div>
            <div class="row">
              <label>等待期间自动点击的按钮 <span class="hint">精确文字匹配</span></label>
              <div id="autoClickList"></div>
              <button onclick="addAutoClickRow('')" style="margin-top:0.5rem;font-size:0.8rem;padding:0.25rem 0.6rem;">+ 添加按钮</button>
            </div>
          </div>
          
          <!-- Notion Queue -->
          <div class="card">
            <h3>Notion 任务队列 <span class="hint">全局共享 NOTION_API_KEY</span></h3>
            <div class="row"><label>数据库 URL</label><input type="url" id="qDbUrl" placeholder="https://www.notion.so/..."></div>
            <div style="display:flex;gap:1rem;">
              <div class="row" style="flex:1"><label>状态列</label><input type="text" id="qColStatus" value="Status"></div>
              <div class="row" style="flex:1"><label>操作名列</label><input type="text" id="qColAction" value="Action Name"></div>
            </div>
            <div style="display:flex;gap:1rem;">
              <div class="row" style="flex:1"><label>文件URL列</label><input type="text" id="qColUrl" value="File URL"></div>
              <div class="row" style="flex:1"><label>排序列</label><input type="text" id="qColBatch" value="batch_phase"></div>
            </div>
            <div style="display:flex;gap:0.5rem;">
              <div class="row" style="flex:1"><label>初始态</label><input type="text" id="qStatQ" value="Queued"></div>
              <div class="row" style="flex:1"><label>成功态</label><input type="text" id="qStatD" value="Done"></div>
              <div class="row" style="flex:1"><label>失败态</label><input type="text" id="qStatF" value="Failed"></div>
            </div>
            <div class="row">
              <label>成功后操作</label>
              <select id="qOnSuccess"><option value="update">更新为成功态</option><option value="delete">删除记录</option></select>
            </div>
          </div>
          
          <!-- Time Slots -->
          <div class="card">
            <h3>时间区间 <span class="hint">本地时区</span></h3>
            <div id="slotsContainer"></div>
            <button onclick="addSlotRow()" class="primary" style="margin-top:0.5rem;">+ 添加时间区间</button>
          </div>
          
          <!-- Industries -->
          <div class="card" style="grid-column: 1 / -1;">
            <h3>任务链</h3>
            <div id="industriesContainer" class="industry-list"></div>
            <button onclick="addIndustryRow()" class="primary" style="margin-top:0.5rem;">+ 添加任务链</button>
          </div>
          
          <!-- Logs -->
          <div class="card logs-card">
            <h3>最近运行日志</h3>
            <div class="log-tabs" id="logTabs"></div>
            <div id="logContent" class="logs">选择日志查看</div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Add Account Modal -->
  <div id="modalAddAccount" class="modal-overlay">
    <div class="modal-box" style="min-width:300px;">
      <h3>添加新账号</h3>
      <div class="row"><label>账号 ID <span class="hint">必须唯一，只支持英文数字</span></label><input type="text" id="newAccId"></div>
      <div class="row"><label>显示名 <span class="hint">方便辨认的名字</span></label><input type="text" id="newAccLabel"></div>
      <div class="form-actions">
        <button onclick="closeModal('modalAddAccount')">取消</button>
        <button onclick="submitAddAccount()" class="primary">保存</button>
      </div>
    </div>
  </div>

  <!-- Edit Industry Modal -->
  <div id="modalEditIndustry" class="modal-overlay">
    <div class="modal-box">
      <h3>编辑任务链</h3>
      <div class="row"><label>标识 ID</label><input type="text" id="indId"></div>
      <div class="row"><label>任务来源</label><select id="indSource" onchange="toggleIndSource()"><option value="schedule">任务链</option><option value="notionQueue">Notion 队列</option></select></div>
      <div class="row"><label>Portal URL</label><input type="url" id="indUrl"></div>
      <div style="display:flex;gap:1rem;">
        <div class="row" style="flex:1"><label>新建对话频率(N)</label><div style="display:flex;gap:0.5rem;align-items:center;"><input type="number" id="indNMin" min="0">~<input type="number" id="indNMax" min="0"></div></div>
        <div class="row" style="flex:1"><label>模型切换频率(M)</label><div style="display:flex;gap:0.5rem;align-items:center;"><input type="number" id="indMMin" min="0">~<input type="number" id="indMMax" min="0"></div></div>
      </div>
      <div class="row" id="tasksGroup">
        <label>任务列表</label>
        <div id="indTasksContainer"></div>
        <button onclick="addIndTaskRow()" style="margin-top:0.5rem;padding:0.25rem 0.5rem;">+ 添加任务</button>
      </div>
      <div class="form-actions">
        <button onclick="closeModal('modalEditIndustry')">取消</button>
        <button onclick="saveIndustryModal()" class="primary">确定</button>
      </div>
    </div>
  </div>

  <!-- Service Failed Records Modal -->
  <div id="modalServiceFailed" class="modal-overlay">
    <div class="modal-box" style="min-width:min(90vw,700px);max-height:80vh;display:flex;flex-direction:column;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
        <h3 style="margin:0;">启动失败记录</h3>
        <div style="display:flex;gap:0.5rem;">
          <button onclick="loadServiceFailed()" style="padding:0.25rem 0.6rem;min-height:28px;font-size:0.8rem;">刷新</button>
          <button onclick="closeModal('modalServiceFailed')">关闭</button>
        </div>
      </div>
      <p style="margin:0 0 0.75rem;font-size:0.85rem;color:#666;">服务在任务执行前失败时自动保存的截图与页面 HTML，文件名含账号和时间戳。</p>
      <div id="sfList" style="flex:1;overflow-y:auto;"></div>
    </div>
  </div>

  <!-- Broadcast Modal -->
  <div id="modalBroadcast" class="modal-overlay">
    <div class="modal-box">
      <h3>广播配置</h3>
      <p>将当前账号 <strong><span id="bcSourceName"></span></strong> 的所有配置同步到以下选中的账号：</p>
      <div class="account-checkbox-list" id="bcAccountsList"></div>
      <div class="form-actions">
        <button onclick="closeModal('modalBroadcast')">取消</button>
        <button onclick="submitBroadcast()" class="primary">确认广播</button>
      </div>
    </div>
  </div>

  <script>
    let accounts = [];
    let currentAccountId = null;
    let currentSchedule = null;
    let refreshInterval = null;
    let editingIndIdx = -1;

    // 日志增量更新状态：记录当前选中的 runId 及各 run 已显示的行数
    let logViewState = {
      selectedRunId: null,
      knownRunIds: [],        // 上次 fetch 时的 run id 列表（用于判断是否需要重建 tabs）
      lineCountByRunId: {}    // { runId: number } 已显示的行数
    };

    function resetLogState() {
      logViewState = { selectedRunId: null, knownRunIds: [], lineCountByRunId: {} };
    }

    async function api(method, path, body) {
      const opts = { method };
      if (body) {
        opts.headers = { 'Content-Type': 'application/json' };
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(path, opts);
      if (res.status === 204) return;
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    function showMsg(text, isError) {
      const el = document.getElementById('msg');
      el.textContent = text;
      el.style.color = isError ? '#dc3545' : '#155724';
      if(text) setTimeout(() => el.textContent='', 4000);
    }
    function escapeHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

    // ==== 账号列表 ====
    async function fetchAccounts() {
      accounts = await api('GET', '/api/accounts');
      renderSidebar();
      if (currentAccountId) {
        const acc = accounts.find(a => a.id === currentAccountId);
        if (acc) {
          document.getElementById('viewAccountStatus').textContent = acc.status === 'running' ? '运行中' : '已停止';
          document.getElementById('viewAccountStatus').style.color = acc.status === 'running' ? '#28a745' : '#dc3545';
          document.getElementById('btnStart').disabled = acc.status === 'running';
          document.getElementById('btnStop').disabled = acc.status !== 'running';
        } else {
          selectAccount(null);
        }
      }
    }

    function renderSidebar() {
      const list = document.getElementById('accountList');
      list.innerHTML = '';
      accounts.forEach(acc => {
        const div = document.createElement('div');
        div.className = 'account-item' + (acc.id === currentAccountId ? ' active' : '');
        div.onclick = () => selectAccount(acc.id);
        
        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = '<div class="status-dot ' + acc.status + '"></div><div class="name">' + escapeHtml(acc.label) + '</div>';
        
        const actions = document.createElement('div');
        actions.className = 'actions';
        
        const btnToggle = document.createElement('button');
        btnToggle.textContent = acc.status === 'running' ? '停止' : '启动';
        btnToggle.onclick = async (e) => {
          e.stopPropagation();
          btnToggle.disabled = true;
          try {
            await api('POST', '/api/accounts/' + acc.id + '/' + (acc.status === 'running' ? 'stop' : 'start'));
            fetchAccounts();
          } catch(err) { alert(err.message); }
        };
        actions.appendChild(btnToggle);
        div.appendChild(info);
        div.appendChild(actions);
        list.appendChild(div);
      });
    }

    // ==== 选择账号 & 加载配置 ====
    async function selectAccount(id) {
      currentAccountId = id;
      renderSidebar();
      if (!id) {
        document.getElementById('noSelectionMsg').style.display = 'block';
        document.getElementById('accountConfig').style.display = 'none';
        return;
      }
      document.getElementById('noSelectionMsg').style.display = 'none';
      document.getElementById('accountConfig').style.display = 'block';
      
      const acc = accounts.find(a => a.id === id);
      document.getElementById('viewAccountName').innerHTML = escapeHtml(acc.label) + ' <span class="account-id-badge">' + acc.id + '</span>';
      document.getElementById('viewAccountStatus').textContent = acc.status === 'running' ? '运行中' : '已停止';
      document.getElementById('viewAccountStatus').style.color = acc.status === 'running' ? '#28a745' : '#dc3545';
      document.getElementById('btnStart').disabled = acc.status === 'running';
      document.getElementById('btnStop').disabled = acc.status !== 'running';
      
      try {
        currentSchedule = await api('GET', '/api/accounts/' + id + '/schedule');
        renderSchedule();
        resetLogState();
        fetchLogs();
      } catch(e) { showMsg(e.message, true); }
    }

    // ==== 渲染 Schedule 表单 ====
    function renderSchedule() {
      const s = currentSchedule;
      if (!s) return;
      document.getElementById('intervalMin').value = Math.round((s.intervalMinMs||120000)/1000);
      document.getElementById('intervalMax').value = Math.round((s.intervalMaxMs||120000)/1000);
      document.getElementById('loginWait').value = Math.round((s.loginWaitMs||60000)/1000);
      document.getElementById('headless').checked = s.headless ?? false;
      
      const acl = document.getElementById('autoClickList');
      acl.innerHTML = '';
      (s.autoClickDuringOutputWait || []).forEach(name => addAutoClickRow(name));
      
      const q = s.notionQueue || {};
      document.getElementById('qDbUrl').value = q.databaseUrl || '';
      document.getElementById('qColStatus').value = q.columnStatus || 'Status';
      document.getElementById('qColAction').value = q.columnActionName || 'Action Name';
      document.getElementById('qColUrl').value = q.columnFileUrl || 'File URL';
      document.getElementById('qColBatch').value = q.columnBatchPhase !== undefined ? q.columnBatchPhase : 'batch_phase';
      document.getElementById('qStatQ').value = q.statusQueued || 'Queued';
      document.getElementById('qStatD').value = q.statusDone || 'Done';
      document.getElementById('qStatF').value = q.statusFailed || 'Failed';
      document.getElementById('qOnSuccess').value = q.onSuccess === 'delete' ? 'delete' : 'update';
      
      // 从服务端加载数据时 skipSync=true，防止旧账号DOM数据覆盖新 schedule
      renderSlots(true);
      renderIndustries();
    }

    function addAutoClickRow(val) {
      const div = document.createElement('div');
      div.className = 'auto-click-row row';
      div.style.marginBottom = '0.5rem';
      div.innerHTML = '<div style="display:flex;gap:0.5rem;"><input type="text" value="' + escapeHtml(val) + '" placeholder="Button Name" style="flex:1"><button type="button" class="danger">删除</button></div>';
      div.querySelector('button').onclick = () => div.remove();
      document.getElementById('autoClickList').appendChild(div);
    }

    function getIndustryIds() { return (currentSchedule.industries || []).map(i => i.id); }

    function syncSlotsFromDOM() {
      if (!currentSchedule) return;
      const rows = document.querySelectorAll('.slot-row');
      rows.forEach((row, i) => {
        if(i >= currentSchedule.timeSlots.length) return;
        const slot = currentSchedule.timeSlots[i];
        slot.startHour = Number(row.querySelector('.sh').value)||0;
        slot.startMinute = Number(row.querySelector('.sm').value)||0;
        slot.endHour = Number(row.querySelector('.eh').value)||0;
        slot.endMinute = Number(row.querySelector('.em').value)||0;
        slot.industryId = row.querySelector('.ind').value||'';
      });
    }

    // skipSync=true 时跳过 DOM→model 同步（账号切换/首次加载时使用，避免旧DOM数据覆盖新schedule）
    function renderSlots(skipSync) {
      if (!skipSync) syncSlotsFromDOM();
      const slots = currentSchedule.timeSlots || [];
      const con = document.getElementById('slotsContainer');
      con.innerHTML = '';
      const ids = getIndustryIds();
      slots.forEach((s, idx) => {
        const div = document.createElement('div');
        div.className = 'slot-row';
        let opts = ids.map(id => '<option value="' + escapeHtml(id) + '"' + (id===s.industryId?' selected':'') + '>' + escapeHtml(id) + '</option>').join('');
        div.innerHTML = '<div class="slot-time-group"><label>起</label><input type="number" class="sh" value="' + s.startHour + '"><input type="number" class="sm" value="' + s.startMinute + '"></div>' + '<div class="slot-time-group"><label>止</label><input type="number" class="eh" value="' + s.endHour + '"><input type="number" class="em" value="' + s.endMinute + '"></div>' + '<select class="ind">' + opts + '</select>' + '<button class="danger" onclick="removeSlot(' + idx + ')">删</button>';
        con.appendChild(div);
      });
    }
    window.addSlotRow = function() {
      syncSlotsFromDOM();
      currentSchedule.timeSlots.push({startHour:0, startMinute:0, endHour:23, endMinute:59, industryId: getIndustryIds()[0]||''});
      renderSlots();
    };
    window.removeSlot = function(i) {
      syncSlotsFromDOM();
      currentSchedule.timeSlots.splice(i, 1);
      renderSlots();
    };

    function renderIndustries() {
      const con = document.getElementById('industriesContainer');
      con.innerHTML = '';
      (currentSchedule.industries || []).forEach((ind, i) => {
        const div = document.createElement('div');
        div.className = 'industry-row';
        div.innerHTML = '<div class="details"><div class="id">' + escapeHtml(ind.id) + ' <span class="hint">' + (ind.taskSource==='notionQueue'?'Notion队列':'任务链') + '</span></div><div class="url">' + escapeHtml(ind.notionUrl||'未配置URL') + '</div></div><div style="display:flex;gap:0.5rem;flex-shrink:0;"><button onclick="editIndustry(' + i + ')">编辑</button><button class="danger" onclick="removeIndustry(' + i + ')">删除</button></div>';
        con.appendChild(div);
      });
    }
    window.addIndustryRow = function() {
      currentSchedule.industries.push({ 
        id: 'new_ind_'+Math.floor(Math.random()*1000), taskSource: 'schedule', notionUrl:'',
        newChatEveryRunsMin:1, newChatEveryRunsMax:1, modelSwitchIntervalMin:0, modelSwitchIntervalMax:0,
        chainRunsPerSlot:0, tasks:[{content:'', runCount:1}] 
      });
      syncSlotsFromDOM();
      renderSlots();
      renderIndustries();
    };
    window.removeIndustry = function(i) {
      const oldId = currentSchedule.industries[i].id;
      currentSchedule.industries.splice(i, 1);
      const newId = currentSchedule.industries.length ? currentSchedule.industries[0].id : '';
      currentSchedule.timeSlots.forEach(s => { if(s.industryId === oldId) s.industryId = newId; });
      syncSlotsFromDOM();
      renderSlots();
      renderIndustries();
    };

    // ==== Industry Edit Modal ====
    window.editIndustry = function(i) {
      editingIndIdx = i;
      const ind = currentSchedule.industries[i];
      document.getElementById('indId').value = ind.id;
      document.getElementById('indSource').value = ind.taskSource === 'notionQueue' ? 'notionQueue' : 'schedule';
      document.getElementById('indUrl').value = ind.notionUrl || '';
      document.getElementById('indNMin').value = ind.newChatEveryRunsMin??1;
      document.getElementById('indNMax').value = ind.newChatEveryRunsMax??1;
      document.getElementById('indMMin').value = ind.modelSwitchIntervalMin??0;
      document.getElementById('indMMax').value = ind.modelSwitchIntervalMax??0;
      toggleIndSource();
      
      const tc = document.getElementById('indTasksContainer');
      tc.innerHTML = '';
      (ind.tasks||[]).forEach(t => addIndTaskRowObj(t.content, t.model));
      document.getElementById('modalEditIndustry').classList.add('visible');
    };
    window.toggleIndSource = function() {
      document.getElementById('tasksGroup').style.display = document.getElementById('indSource').value === 'notionQueue' ? 'none' : 'block';
    };
    function addIndTaskRowObj(content, model) {
      const div = document.createElement('div');
      div.className = 'task-row';
      div.innerHTML = '<textarea placeholder="发送内容" style="flex:1" rows="1">' + escapeHtml(content||'') + '</textarea><input type="text" placeholder="指定模型(可选)" value="' + escapeHtml(model||'') + '" style="width:7rem"><button class="danger" onclick="this.parentElement.remove()">删</button>';
      document.getElementById('indTasksContainer').appendChild(div);
    }
    window.addIndTaskRow = () => addIndTaskRowObj('','');
    window.saveIndustryModal = function() {
      const ind = currentSchedule.industries[editingIndIdx];
      const oldId = ind.id;
      ind.id = document.getElementById('indId').value.trim()||'unnamed';
      ind.taskSource = document.getElementById('indSource').value;
      ind.notionUrl = document.getElementById('indUrl').value.trim();
      ind.newChatEveryRunsMin = Number(document.getElementById('indNMin').value)||1;
      ind.newChatEveryRunsMax = Number(document.getElementById('indNMax').value)||1;
      ind.modelSwitchIntervalMin = Number(document.getElementById('indMMin').value)||0;
      ind.modelSwitchIntervalMax = Number(document.getElementById('indMMax').value)||0;
      
      ind.tasks = [];
      if(ind.taskSource === 'schedule') {
        document.querySelectorAll('#indTasksContainer .task-row').forEach(row => {
          const content = row.querySelector('textarea').value;
          const model = row.querySelector('input').value.trim();
          const t = { content, runCount:1 };
          if(model) t.model = model;
          ind.tasks.push(t);
        });
      }
      if(oldId !== ind.id) {
        currentSchedule.timeSlots.forEach(s => { if(s.industryId === oldId) s.industryId = ind.id; });
      }
      closeModal('modalEditIndustry');
      renderSlots();
      renderIndustries();
    };

    // ====收集保存 ====
    function collectSchedule() {
      syncSlotsFromDOM();
      const s = { ...currentSchedule };
      s.intervalMinMs = (Number(document.getElementById('intervalMin').value)||120)*1000;
      s.intervalMaxMs = (Number(document.getElementById('intervalMax').value)||120)*1000;
      s.loginWaitMs = (Number(document.getElementById('loginWait').value)||60)*1000;
      s.headless = document.getElementById('headless').checked;
      
      s.autoClickDuringOutputWait = [];
      document.querySelectorAll('#autoClickList input').forEach(input => {
        if(input.value.trim()) s.autoClickDuringOutputWait.push(input.value.trim());
      });
      
      if(document.getElementById('qDbUrl').value.trim()) {
        s.notionQueue = {
          databaseUrl: document.getElementById('qDbUrl').value.trim(),
          columnStatus: document.getElementById('qColStatus').value.trim(),
          columnActionName: document.getElementById('qColAction').value.trim(),
          columnFileUrl: document.getElementById('qColUrl').value.trim(),
          columnBatchPhase: document.getElementById('qColBatch').value.trim(),
          statusQueued: document.getElementById('qStatQ').value.trim(),
          statusDone: document.getElementById('qStatD').value.trim(),
          statusFailed: document.getElementById('qStatF').value.trim(),
          onSuccess: document.getElementById('qOnSuccess').value
        };
      } else s.notionQueue = undefined;
      return s;
    }

    window.saveCurrent = async function() {
      try {
        const s = collectSchedule();
        await api('POST', '/api/accounts/' + currentAccountId + '/schedule', s);
        showMsg('配置已保存', false);
      } catch(e) { showMsg(e.message, true); }
    };
    window.startCurrent = async function() {
      try {
        await saveCurrent();
        await api('POST', '/api/accounts/' + currentAccountId + '/start');
        await fetchAccounts();
      } catch(e) { showMsg(e.message, true); }
    };
    window.stopCurrent = async function() {
      try { await api('POST', '/api/accounts/' + currentAccountId + '/stop'); await fetchAccounts(); } 
      catch(e) { showMsg(e.message, true); }
    };

    // ==== 模态框 ====
    window.closeModal = function(id) { document.getElementById(id).classList.remove('visible'); };
    window.openAddAccountModal = function() {
      document.getElementById('newAccId').value = '';
      document.getElementById('newAccLabel').value = '';
      document.getElementById('modalAddAccount').classList.add('visible');
    };
    window.submitAddAccount = async function() {
      const id = document.getElementById('newAccId').value;
      const label = document.getElementById('newAccLabel').value;
      try {
        await api('POST', '/api/accounts', { id, label });
        closeModal('modalAddAccount');
        await fetchAccounts();
        selectAccount(id);
      } catch(e) { alert(e.message); }
    };
    window.deleteCurrent = async function() {
      if(!confirm('确定删除此账号？数据不会从磁盘删除，但将从列表中移除。')) return;
      try {
        await api('DELETE', '/api/accounts/' + currentAccountId);
        await fetchAccounts();
        selectAccount(accounts.length ? accounts[0].id : null);
      } catch(e) { alert(e.message); }
    };

    // ==== Broadcast ====
    window.openBroadcastModal = function() {
      document.getElementById('bcSourceName').textContent = accounts.find(a=>a.id===currentAccountId)?.label;
      const list = document.getElementById('bcAccountsList');
      list.innerHTML = '';
      accounts.forEach(acc => {
        if(acc.id === currentAccountId) return;
        const lbl = document.createElement('label');
        lbl.innerHTML = '<input style="width:30%" type="checkbox" value="' + acc.id + '" checked> ' + escapeHtml(acc.label) + ' (' + acc.id + ')';
        list.appendChild(lbl);
      });
      document.getElementById('modalBroadcast').classList.add('visible');
    };
    window.submitBroadcast = async function() {
      const s = collectSchedule();
      const ids = Array.from(document.querySelectorAll('#bcAccountsList input:checked')).map(cb=>cb.value);
      if(!ids.length) { alert('未选择目标账号'); return; }
      try {
        await api('POST', '/api/broadcast-schedule', { schedule: s, accountIds: ids });
        closeModal('modalBroadcast');
        showMsg('已广播配置给 ' + ids.length + ' 个账号', false);
      } catch(e) { alert(e.message); }
    };

    // ==== Logs（增量更新：仅在 run 列表结构变化时重建 tabs；同一 run 只追加新增行）====
    function buildLogTabBtn(r, tabs) {
      const btn = document.createElement('button');
      btn.textContent = r.endTime
        ? '#' + r.id + ' (' + new Date(r.startTime).toLocaleTimeString() + ')'
        : '#' + r.id + ' (当前)';
      btn.dataset.runId = String(r.id);
      btn.onclick = () => {
        tabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        logViewState.selectedRunId = r.id;
        const logContent = document.getElementById('logContent');
        logContent.textContent = (r.lines || []).join('\\n') || '(无输出)';
        logViewState.lineCountByRunId[r.id] = r.lines.length;
        logContent.scrollTop = logContent.scrollHeight;
      };
      return btn;
    }

    async function fetchLogs() {
      if (!currentAccountId) return;
      try {
        const { runs } = await api('GET', '/api/accounts/' + currentAccountId + '/logs');
        const tabs = document.getElementById('logTabs');
        const logContent = document.getElementById('logContent');

        if (!runs || runs.length === 0) {
          logContent.textContent = '(无记录)';
          tabs.innerHTML = '';
          resetLogState();
          return;
        }

        const newIds = runs.map(r => r.id).join(',');
        const oldIds = logViewState.knownRunIds.join(',');

        if (newIds !== oldIds) {
          // Run 列表结构变化（新增/切换了 run）→ 重建 tabs
          tabs.innerHTML = '';
          logViewState.knownRunIds = runs.map(r => r.id);
          logViewState.lineCountByRunId = {};

          // 保留之前选中的 run（若仍存在），否则选最新一条
          const targetRun = (logViewState.selectedRunId !== null && runs.find(r => r.id === logViewState.selectedRunId))
            || runs[0];
          logViewState.selectedRunId = targetRun.id;

          runs.forEach(r => {
            const btn = buildLogTabBtn(r, tabs);
            tabs.appendChild(btn);
            if (r.id === targetRun.id) {
              btn.classList.add('active');
              logContent.textContent = (r.lines || []).join('\\n') || '(无输出)';
              logViewState.lineCountByRunId[r.id] = r.lines.length;
              logContent.scrollTop = logContent.scrollHeight;
            }
          });
        } else {
          // Run 列表结构未变 → 增量追加当前选中 run 的新日志行
          runs.forEach(r => {
            // 更新 tab 按钮文字（run 结束后 "(当前)" → 时间戳）
            const btn = tabs.querySelector('button[data-run-id="' + r.id + '"]');
            if (btn && r.endTime && btn.textContent.includes('(当前)')) {
              btn.textContent = '#' + r.id + ' (' + new Date(r.startTime).toLocaleTimeString() + ')';
            }
          });

          const selectedId = logViewState.selectedRunId;
          if (selectedId !== null) {
            const run = runs.find(r => r.id === selectedId);
            if (run) {
              const knownCount = logViewState.lineCountByRunId[selectedId] || 0;
              const newLines = run.lines.slice(knownCount);
              if (newLines.length > 0) {
                const atBottom = logContent.scrollHeight - logContent.scrollTop - logContent.clientHeight < 60;
                logContent.textContent += (knownCount > 0 ? '\\n' : '') + newLines.join('\\n');
                logViewState.lineCountByRunId[selectedId] = run.lines.length;
                if (atBottom) logContent.scrollTop = logContent.scrollHeight;
              }
            }
          }
        }
      } catch(e) {}
    }

    window.startAll = async () => { 
      try { 
        const isHeadless = document.getElementById('globalHeadless').checked;
        await api('POST','/api/start-all', { headless: isHeadless }); 
        fetchAccounts();
      } catch(e){ alert(e.message); } 
    };
    window.stopAll = async () => { try { await api('POST','/api/stop-all'); fetchAccounts();}catch(e){alert(e.message);} };
    window.pullAndRestart = async () => {
      document.body.style.opacity = '0.5';
      try {
        const data = await api('POST','/api/pull-and-restart');
        if(data && data.ok) alert('即将重启，请几秒后刷新页面');
      } catch(e) { alert(e.message); document.body.style.opacity='1'; }
    };

    // ==== 启动失败记录 ====
    window.openServiceFailedModal = function() {
      document.getElementById('modalServiceFailed').classList.add('visible');
      loadServiceFailed();
    };

    window.loadServiceFailed = async function() {
      const list = document.getElementById('sfList');
      list.innerHTML = '<div class="sf-empty">加载中…</div>';
      try {
        const { files } = await api('GET', '/api/service-failed');
        if (!files || files.length === 0) {
          list.innerHTML = '<div class="sf-empty">暂无失败记录</div>';
          return;
        }
        // 将同基名的 .png / .html 两个文件配对展示
        const pairMap = {};
        files.forEach(f => {
          const dot = f.name.lastIndexOf('.');
          const base = dot >= 0 ? f.name.slice(0, dot) : f.name;
          const ext = dot >= 0 ? f.name.slice(dot + 1).toLowerCase() : '';
          if (!pairMap[base]) pairMap[base] = { base, mtime: f.mtime };
          pairMap[base][ext] = f.name;
        });
        const pairs = Object.values(pairMap).sort((a, b) => b.mtime - a.mtime);

        list.innerHTML = '';
        const container = document.createElement('div');
        container.style.cssText = 'border:1px solid #eee;border-radius:6px;overflow:hidden;';
        pairs.forEach(p => {
          // 解析文件名：{account}_{YYYY-MM-DD_HH-mm-ss}
          const parts = p.base.split('_');
          const account = parts.length >= 4 ? parts.slice(0, parts.length - 3).join('_') : p.base;
          const dateStr = parts.length >= 3 ? parts.slice(-3).join(' ').replace(/-/g, ':').replace(' ', ' ') : '';
          const timeLabel = (() => {
            try {
              const d = parts.slice(-3);
              // d = ['YYYY-MM-DD', 'HH-mm-ss']  (actually 3 parts: date, h-m-s but split by _ not -)
              // Actually format is YYYY-MM-DD_HH-mm-ss, split by _ gives: [...account..., 'YYYY-MM-DD', 'HH-mm-ss']
              const datePart = parts[parts.length - 2];
              const timePart = parts[parts.length - 1].replace(/-/g, ':');
              return datePart + ' ' + timePart;
            } catch { return p.base; }
          })();

          const row = document.createElement('div');
          row.className = 'sf-pair';
          const meta = document.createElement('div');
          meta.className = 'sf-meta';
          meta.innerHTML = '<div class="sf-name">' + escapeHtml(account) + '</div><div class="sf-time">' + escapeHtml(timeLabel) + '</div>';

          const actions = document.createElement('div');
          actions.className = 'sf-actions';
          if (p.png) {
            const a = document.createElement('a');
            a.href = '/api/service-failed/' + encodeURIComponent(p.png);
            a.download = p.png;
            a.textContent = '下载截图';
            actions.appendChild(a);
          }
          if (p.html) {
            const a = document.createElement('a');
            a.href = '/api/service-failed/' + encodeURIComponent(p.html);
            a.target = '_blank';
            a.textContent = '查看HTML';
            actions.appendChild(a);
          }
          row.appendChild(meta);
          row.appendChild(actions);
          container.appendChild(row);
        });
        list.appendChild(container);
      } catch(e) {
        list.innerHTML = '<div class="sf-empty">加载失败: ' + escapeHtml(e.message) + '</div>';
      }
    };

    // Init
    fetchAccounts().then(() => {
      if(accounts.length) selectAccount(accounts[0].id);
      setInterval(fetchAccounts, 3000);
      setInterval(fetchLogs, 10000);
    });
  </script>
</body>
</html>`;
}

// ──────────────────────────────────────────────
// 启动服务
// ──────────────────────────────────────────────

const server = createServer(handleRequest);

async function start() {
  await accountManager.init();
  if (process.env.NOTION_AUTO_RESTART === "1") {
    await new Promise<void>((r) => setTimeout(r, 2000));
  }
  server.listen(PORT, HOST, () => {
    logger.info(`Dashboard 启动: http://${HOST}:${PORT}`);
  });
}
start();
