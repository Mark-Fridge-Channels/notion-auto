/**
 * Dashboard 子进程管理：启动/停止 notion-auto 脚本，采集 stdout/stderr，保留最近 10 次运行日志（仅内存）。
 * 支持异常退出后自动重启（userWantsRunning 且 progress 未 completed），连续 >5 次发告警邮件。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { loadProgress } from "./progress.js";
import { getSchedulePath } from "./schedule.js";
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
/** 正在执行 stop 流程（等待子进程退出）时置为 true，避免重复 stop 写入已结束 stdin。 */
let stopInProgress = false;
/** 用户点击启动后为 true，点击停止后为 false；用于决定 exit 时是否自动重启 */
let userWantsRunning = false;
/** 连续自动重启次数，仅用户点击「启动」时归零 */
let consecutiveRestartCount = 0;
/** 本周期是否已发过告警邮件（只发一封） */
let emailSent = false;
/** 最近一次 start 使用的配置路径，供自动重启时复用 */
let lastConfigPath: string | null = null;

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
 * 使用 --config <path> 传入 schedule 配置路径；自动重启时复用 lastConfigPath。
 */
export function start(options: { configPath?: string }): void {
  if (currentProcess != null) return;
  stopInProgress = false;
  userWantsRunning = true;
  consecutiveRestartCount = 0;
  emailSent = false;
  const configPath = options.configPath ?? getSchedulePath();
  lastConfigPath = configPath;
  spawnChild(configPath, false);
}

/** Windows cmd.exe：含空格/引号等时用双引号包裹 */
function escapeArgForWindowsCmd(arg: string): string {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return '"' + arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const STOP_GRACE_MS = 3000;

function spawnChild(configPath: string, isAutoResume: boolean): void {
  const args = ["--config", configPath, "--storage", ".notion-auth.json"];
  const env = { ...process.env };
  if (isAutoResume) env.NOTION_AUTO_RESUME = "1";

  // 所有平台都启用 stdin pipe：优先发 "stop" 走子进程优雅停机（先点 stop 再关浏览器）
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
  const opts: Parameters<typeof spawn>[2] = {
    cwd: process.cwd(),
    stdio,
    env,
  };

  let child: ChildProcess;
  if (process.platform === "win32") {
    opts.shell = true;
    const escaped = args.map(escapeArgForWindowsCmd).join(" ");
    const fullCmd = "npx tsx src/index.ts " + escaped;
    child = spawn(fullCmd, opts);
  } else {
    child = spawn("npx", ["tsx", "src/index.ts", ...args], opts);
  }
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
    // 仅处理当前活跃子进程；忽略过期进程的 exit/error 事件
    if (currentProcess !== child) return;
    currentProcess = null;
    stopInProgress = false;
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
  if (!userWantsRunning || lastConfigPath == null) return;
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
  spawnChild(lastConfigPath, true);
}

/**
 * 停止当前脚本子进程（若有）；并标记用户不再希望运行，exit 时不再自动重启。
 * 所有平台先向 stdin 发 "stop" 触发子进程优雅停机（先点页面 stop 再关浏览器）；
 * 超时未退再走平台兜底（Windows taskkill；非 Windows SIGTERM）。
 */
export function stop(): void {
  userWantsRunning = false;
  if (currentProcess == null) return;
  if (stopInProgress) return;
  stopInProgress = true;
  const child = currentProcess;
  const pid = child.pid;
  const fallbackKill = () => {
    if (currentProcess !== child) return;
    if (process.platform === "win32") {
      if (pid != null) {
        logger.warn("子进程未在限定时间内退出，使用 taskkill 结束进程树");
        spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
          shell: true,
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGINT");
      }
      return;
    }
    logger.warn("子进程未在限定时间内退出，改用 SIGTERM 强制结束");
    child.kill("SIGTERM");
  };

  if (child.stdin) {
    // 兜底监听：避免 write/end 在边界时序触发 error 冒泡导致主进程崩溃。
    child.stdin.once("error", (err) => {
      logger.warn("向子进程 stdin 发送 stop 时发生错误", err);
    });
    const writable = child.stdin.writable && !child.stdin.writableEnded && !child.stdin.destroyed;
    if (writable) {
      child.stdin.write("stop\n");
      child.stdin.end();
      const timeout = setTimeout(() => fallbackKill(), STOP_GRACE_MS);
      child.once("exit", () => clearTimeout(timeout));
      return;
    }
    logger.warn("子进程 stdin 不可写，直接走兜底信号");
  }

  fallbackKill();
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
