/**
 * Reply Tasks 自动发送子进程管理：启动/停止 src/reply-tasks-auto-sender.ts，
 * 采集 stdout/stderr，保留最近 10 次运行日志。无自动重启；由 Dashboard 启停。
 * 停止时使用 tree-kill 结束整棵进程树，避免残留。节流由 server 在 start 前注入 env。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const treeKill = require("tree-kill") as (
  pid: number,
  signal?: string,
  callback?: (err?: Error) => void,
) => void;

const MAX_RUN_LOGS = 10;
const MAX_LINES_PER_RUN = 2000;

export type ReplyTasksAutoSendStatus = "idle" | "running";

export interface ReplyTasksAutoSendRunLog {
  id: number;
  startTime: number;
  endTime: number | null;
  lines: string[];
}

let runIdCounter = 0;
let currentProcess: ChildProcess | null = null;
let runLogs: ReplyTasksAutoSendRunLog[] = [];
let currentRunLog: ReplyTasksAutoSendRunLog | null = null;

function appendLine(line: string): void {
  if (!currentRunLog) return;
  currentRunLog.lines.push(line);
  if (currentRunLog.lines.length > MAX_LINES_PER_RUN)
    currentRunLog.lines = currentRunLog.lines.slice(-MAX_LINES_PER_RUN);
}

export function getReplyTasksAutoSendStatus(): ReplyTasksAutoSendStatus {
  return currentProcess != null ? "running" : "idle";
}

/** Windows cmd.exe：含空格/引号等时用双引号包裹 */
function escapeArgForWindowsCmd(arg: string): string {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return '"' + arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

export function startReplyTasksAutoSend(): void {
  if (currentProcess != null) return;
  const opts: Parameters<typeof spawn>[2] = {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  };
  let child: ChildProcess;
  if (process.platform === "win32") {
    opts.shell = true;
    const args = ["tsx", "src/reply-tasks-auto-sender.ts"];
    const fullCmd = "npx " + args.map(escapeArgForWindowsCmd).join(" ");
    child = spawn(fullCmd, opts);
  } else {
    child = spawn("npx", ["tsx", "src/reply-tasks-auto-sender.ts"], opts);
  }
  currentProcess = child;
  currentRunLog = {
    id: ++runIdCounter,
    startTime: Date.now(),
    endTime: null,
    lines: [],
  };
  const verbose = process.env.NOTION_AUTO_VERBOSE === "1";
  child.stdout?.on("data", (chunk: Buffer) => {
    chunk
      .toString("utf-8")
      .split("\n")
      .forEach((line) => {
        if (line) {
          appendLine(line);
          if (verbose) process.stderr.write(`[Reply Tasks AutoSend] ${line}\n`);
        }
      });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    chunk
      .toString("utf-8")
      .split("\n")
      .forEach((line) => {
        if (line) {
          appendLine(line);
          if (verbose) process.stderr.write(`[Reply Tasks AutoSend] ${line}\n`);
        }
      });
  });
  child.on("exit", () => {
    currentProcess = null;
    if (currentRunLog) currentRunLog.endTime = Date.now();
    if (currentRunLog) {
      runLogs.unshift(currentRunLog);
      if (runLogs.length > MAX_RUN_LOGS) runLogs = runLogs.slice(0, MAX_RUN_LOGS);
      currentRunLog = null;
    }
  });
  child.on("error", (err) => {
    logger.warn("Reply Tasks 自动发送子进程 error", err);
  });
}

/** 停止 Reply Tasks 自动发送：结束进程树。 */
export function stopReplyTasksAutoSend(): void {
  if (currentProcess == null) return;
  const pid = currentProcess.pid;
  currentProcess = null;
  if (pid != null) {
    treeKill(pid, "SIGTERM", (err) => {
      if (err) logger.warn("Reply Tasks 自动发送进程树结束时报错", err);
    });
  }
}

export function getReplyTasksAutoSendRunLogs(
  n: number = MAX_RUN_LOGS,
): ReplyTasksAutoSendRunLog[] {
  const list = currentRunLog ? [currentRunLog, ...runLogs] : [...runLogs];
  return list.slice(0, n);
}
