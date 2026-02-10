/**
 * Dashboard 子进程管理：启动/停止 notion-auto 脚本，采集 stdout/stderr，保留最近 10 次运行日志（仅内存）。
 * 支持异常退出后自动重启（userWantsRunning 且 progress 未 completed），连续 >5 次发告警邮件。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { DashboardParams } from "./dashboard-params.js";
import { paramsToArgv } from "./dashboard-params.js";
import { loadProgress } from "./progress.js";
import { sendRestartAlertEmail } from "./alert-email.js";
import { logger } from "./logger.js";
import { EXIT_RECOVERY_RESTART } from "./exit-codes.js";

const MAX_RUN_LOGS = 10;
const MAX_LINES_PER_RUN = 2000;
const RESTART_ALERT_THRESHOLD = 5;

export type RunStatus = "idle" | "running";

export interface RunLog {
  id: number;
  startTime: number;
  endTime: number | null;
  lines: string[];
}

let runIdCounter = 0;
let currentProcess: ChildProcess | null = null;
let runLogs: RunLog[] = [];
let currentRunLog: RunLog | null = null;
/** 用户点击启动后为 true，点击停止后为 false；用于决定 exit 时是否自动重启 */
let userWantsRunning = false;
/** 连续自动重启次数，仅用户点击「启动」时归零 */
let consecutiveRestartCount = 0;
/** 本周期是否已发过告警邮件（只发一封） */
let emailSent = false;
/** 最近一次 start 使用的参数，供自动重启时复用 */
let lastParams: DashboardParams | null = null;

function appendLine(line: string): void {
  if (!currentRunLog) return;
  currentRunLog.lines.push(line);
  if (currentRunLog.lines.length > MAX_LINES_PER_RUN)
    currentRunLog.lines = currentRunLog.lines.slice(-MAX_LINES_PER_RUN);
}

function getStatus(): RunStatus {
  return currentProcess != null ? "running" : "idle";
}

/**
 * 启动脚本子进程；若已在运行则先不处理（由调用方先 stop）。
 * 用户点击启动时：userWantsRunning=true，consecutiveRestartCount=0，emailSent=false。
 */
export function start(params: DashboardParams): void {
  if (currentProcess != null) return;
  userWantsRunning = true;
  consecutiveRestartCount = 0;
  emailSent = false;
  lastParams = params;
  spawnChild(params, false);
}

function spawnChild(params: DashboardParams, isAutoResume: boolean): void {
  const args = paramsToArgv(params);
  const env = { ...process.env };
  if (isAutoResume) env.NOTION_AUTO_RESUME = "1";

  // Windows：必须用 shell，否则 spawn("npx"/"npx.cmd") 会 ENOENT 或 EINVAL（.cmd 由 cmd 解释）
  const opts: Parameters<typeof spawn>[2] = {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env,
  };
  if (process.platform === "win32") opts.shell = true;
  const child = spawn("npx", ["tsx", "src/index.ts", ...args], opts);
  currentProcess = child;
  currentRunLog = {
    id: ++runIdCounter,
    startTime: Date.now(),
    endTime: null,
    lines: [],
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    text.split("\n").forEach((line) => {
      if (line) appendLine(line);
    });
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf-8");
    text.split("\n").forEach((line) => {
      if (line) appendLine(line);
    });
  });

  function finishRun(exitCode?: number): void {
    if (currentProcess == null) return;
    currentProcess = null;
    if (currentRunLog) currentRunLog.endTime = Date.now();
    if (currentRunLog) {
      runLogs.unshift(currentRunLog);
      if (runLogs.length > MAX_RUN_LOGS) runLogs = runLogs.slice(0, MAX_RUN_LOGS);
      currentRunLog = null;
    }
    setImmediate(() => maybeAutoRestart(exitCode));
  }

  child.on("exit", (code) => finishRun(code ?? undefined));
  child.on("error", (err) => {
    logger.warn("子进程 error 事件", err);
    finishRun();
  });
}

/** exit 后若 userWantsRunning 且 progress 未 completed 则自动重启；恢复重启（exitCode=2）不计入连续重启次数，不触发告警。 */
async function maybeAutoRestart(exitCode?: number): Promise<void> {
  if (!userWantsRunning || lastParams == null) return;
  const progress = await loadProgress();
  if (progress?.completed === true) return;

  const isRecoveryRestart = exitCode === EXIT_RECOVERY_RESTART;
  if (!isRecoveryRestart) {
    consecutiveRestartCount++;
    if (consecutiveRestartCount > RESTART_ALERT_THRESHOLD && !emailSent) {
      await sendRestartAlertEmail();
      emailSent = true;
    }
    logger.warn(`脚本异常退出，自动重启（第 ${consecutiveRestartCount} 次）`);
  } else {
    logger.info("脚本请求恢复重启（浏览器卡住等），立即重启并继续，不计入连续重启次数");
  }
  spawnChild(lastParams, true);
}

/**
 * 停止当前脚本子进程（若有）；并标记用户不再希望运行，exit 时不再自动重启。
 */
export function stop(): void {
  userWantsRunning = false;
  if (currentProcess == null) return;
  currentProcess.kill("SIGTERM");
  currentProcess = null;
}

export function getRunStatus(): RunStatus {
  return getStatus();
}

/**
 * 最近 N 次运行的日志（含当前未结束的一次）；按时间倒序（最近在前）。
 */
export function getRecentRunLogs(n: number = MAX_RUN_LOGS): RunLog[] {
  const list = currentRunLog ? [currentRunLog, ...runLogs] : [...runLogs];
  return list.slice(0, n);
}
