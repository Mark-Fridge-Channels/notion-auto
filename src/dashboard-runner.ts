/**
 * Dashboard 子进程管理：启动/停止 notion-auto 脚本，采集 stdout/stderr，保留最近 10 次运行日志（仅内存）。
 * 支持异常退出后自动重启（userWantsRunning 且 progress 未 completed），连续 >5 次发告警邮件。
 *
 * 重构为类：每个账号可 new DashboardRunner(accountId, configPath, storagePath) 获取独立的子进程管理器。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { loadProgress } from "./progress.js";
import { getSchedulePath } from "./schedule.js";
import { sendRestartAlertEmail } from "./alert-email.js";
import { logger } from "./logger.js";
import { EXIT_RECOVERY_RESTART } from "./exit-codes.js";
import { markAdhocJobFailedIfActive } from "./adhoc-queue.js";

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

/** Windows cmd.exe：含空格/引号等时用双引号包裹 */
function escapeArgForWindowsCmd(arg: string): string {
  if (!/[\s"&|<>^]/.test(arg)) return arg;
  return '"' + arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const STOP_GRACE_MS = 3000;

export class DashboardRunner {
  private accountId: string;
  private label: string;
  private configPath: string;
  private storagePath: string;

  private runIdCounter = 0;
  private currentProcess: ChildProcess | null = null;
  private runLogs: RunLog[] = [];
  private currentRunLog: RunLog | null = null;
  /** 正在执行 stop 流程（等待子进程退出）时置为 true，避免重复 stop 写入已结束 stdin。 */
  private stopInProgress = false;
  /** 用户点击启动后为 true，点击停止后为 false；用于决定 exit 时是否自动重启 */
  private userWantsRunning = false;
  /** 连续自动重启次数，仅用户点击「启动」时归零 */
  private consecutiveRestartCount = 0;
  /** 本周期是否已发过告警邮件（只发一封） */
  private emailSent = false;
  /** 若当前子进程为「一次性插队」任务，记录 jobId，异常退出时回写队列 */
  private pendingAdhocJobId: string | null = null;

  constructor(accountId: string, label: string, configPath: string, storagePath: string) {
    this.accountId = accountId;
    this.label = label;
    this.configPath = configPath;
    this.storagePath = storagePath;
  }

  private appendLine(line: string): void {
    if (!this.currentRunLog) return;
    this.currentRunLog.lines.push(line);
    if (this.currentRunLog.lines.length > MAX_LINES_PER_RUN)
      this.currentRunLog.lines = this.currentRunLog.lines.slice(-MAX_LINES_PER_RUN);
  }

  getRunStatus(): RunStatus {
    return this.currentProcess != null ? "running" : "idle";
  }

  /**
   * 当前活跃子进程是否为「一次性插队」进程（startAdhocOnce 启动，执行完即退出）。
   * server 侧据此实现全局一次性子进程并发上限，保护内存。
   */
  isAdhocOnceRunning(): boolean {
    return this.currentProcess != null && this.pendingAdhocJobId != null;
  }

  /**
   * 启动脚本子进程；若已在运行则先不处理（由调用方先 stop）。
   */
  start(opts?: { headlessOverride?: boolean }): void {
    if (this.currentProcess != null) return;
    this.pendingAdhocJobId = null;
    this.stopInProgress = false;
    this.userWantsRunning = true;
    this.consecutiveRestartCount = 0;
    this.emailSent = false;
    this.spawnChild(false, opts?.headlessOverride);
  }

  /**
   * 仅执行一条 Webhook 插队任务后退出：`userWantsRunning` 为 false，子进程异常退出时不会自动重启主循环。
   * 若该账号已有子进程在跑则抛错（由 account-manager 保证仅 idle 调用）。
   */
  startAdhocOnce(jobId: string, opts?: { headlessOverride?: boolean }): void {
    if (this.currentProcess != null) {
      throw new Error(`账号 "${this.accountId}" 已有子进程在运行，无法启动插队子进程`);
    }
    this.pendingAdhocJobId = jobId;
    this.stopInProgress = false;
    this.userWantsRunning = false;
    this.consecutiveRestartCount = 0;
    this.emailSent = false;
    this.spawnChild(false, opts?.headlessOverride, jobId);
  }

  private spawnChild(isAutoResume: boolean, headlessOverride?: boolean, adhocJobId?: string): void {
    const args = ["--config", this.configPath, "--storage", this.storagePath];
    if (adhocJobId) args.push("--adhoc-job", adhocJobId);
    const env = { ...process.env };
    if (isAutoResume) env.NOTION_AUTO_RESUME = "1";
    if (headlessOverride) env.NOTION_AUTO_HEADLESS = "1";
    env.NOTION_AUTO_EXECUTOR = this.label;
    if (adhocJobId) {
      env.NOTION_AUTO_ADHOC_JOB = adhocJobId;
      env.NOTION_AUTO_ACCOUNT_ID = this.accountId;
    }

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
    this.currentProcess = child;
    this.currentRunLog = {
      id: ++this.runIdCounter,
      startTime: Date.now(),
      endTime: null,
      lines: [],
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      text.split("\n").forEach((line) => {
        if (line) this.appendLine(line);
      });
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      text.split("\n").forEach((line) => {
        if (line) this.appendLine(line);
      });
    });

    const finishRun = (exitCode?: number, spawnError?: boolean): void => {
      // 仅处理当前活跃子进程；忽略过期进程的 exit/error 事件
      if (this.currentProcess !== child) return;
      this.currentProcess = null;
      this.stopInProgress = false;
      const adhocId = this.pendingAdhocJobId;
      this.pendingAdhocJobId = null;
      if (this.currentRunLog) this.currentRunLog.endTime = Date.now();
      if (this.currentRunLog) {
        this.runLogs.unshift(this.currentRunLog);
        if (this.runLogs.length > MAX_RUN_LOGS) this.runLogs = this.runLogs.slice(0, MAX_RUN_LOGS);
        this.currentRunLog = null;
      }
      if (adhocId) {
        const numericFail = typeof exitCode === "number" && exitCode !== 0;
        if (spawnError || numericFail) {
          void markAdhocJobFailedIfActive(
            adhocId,
            spawnError
              ? "插队子进程 spawn/运行 error 事件"
              : `插队子进程异常退出，退出码 ${exitCode}`,
          );
        }
      }
      setImmediate(() => this.maybeAutoRestart(exitCode));
    };

    child.on("exit", (code) => finishRun(code ?? undefined, false));
    child.on("error", (err) => {
      logger.warn(`[${this.accountId}] 子进程 error 事件`, err);
      finishRun(undefined, true);
    });
  }

  /** exit 后若 userWantsRunning 且 progress 未 completed 则自动重启；恢复重启（exitCode=2）不计入连续重启次数，不触发告警。 */
  private async maybeAutoRestart(exitCode?: number): Promise<void> {
    if (!this.userWantsRunning) return;
    const progress = await loadProgress(this.configPath);
    if (progress?.completed === true) return;

    const isRecoveryRestart = exitCode === EXIT_RECOVERY_RESTART;
    if (!isRecoveryRestart) {
      this.consecutiveRestartCount++;
      if (this.consecutiveRestartCount > RESTART_ALERT_THRESHOLD && !this.emailSent) {
        await sendRestartAlertEmail();
        this.emailSent = true;
      }
      logger.warn(`[${this.accountId}] 脚本异常退出，自动重启（第 ${this.consecutiveRestartCount} 次）`);
    } else {
      logger.info(`[${this.accountId}] 脚本请求恢复重启（浏览器卡住等），立即重启并继续，不计入连续重启次数`);
    }
    this.spawnChild(true);
  }

  /**
   * 停止当前脚本子进程（若有）；并标记用户不再希望运行，exit 时不再自动重启。
   * 所有平台先向 stdin 发 "stop" 触发子进程优雅停机（先点页面 stop 再关浏览器）；
   * 超时未退再走平台兜底（Windows taskkill；非 Windows SIGTERM）。
   */
  stop(): void {
    this.userWantsRunning = false;
    if (this.currentProcess == null) return;
    if (this.stopInProgress) return;
    this.stopInProgress = true;
    const child = this.currentProcess;
    const pid = child.pid;
    const fallbackKill = () => {
      if (this.currentProcess !== child) return;
      if (process.platform === "win32") {
        if (pid != null) {
          logger.warn(`[${this.accountId}] 子进程未在限定时间内退出，使用 taskkill 结束进程树`);
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
      logger.warn(`[${this.accountId}] 子进程未在限定时间内退出，改用 SIGTERM 强制结束`);
      child.kill("SIGTERM");
    };

    if (child.stdin) {
      // 兜底监听：避免 write/end 在边界时序触发 error 冒泡导致主进程崩溃。
      child.stdin.once("error", (err) => {
        logger.warn(`[${this.accountId}] 向子进程 stdin 发送 stop 时发生错误`, err);
      });
      const writable = child.stdin.writable && !child.stdin.writableEnded && !child.stdin.destroyed;
      if (writable) {
        child.stdin.write("stop\n");
        child.stdin.end();
        const timeout = setTimeout(() => fallbackKill(), STOP_GRACE_MS);
        child.once("exit", () => clearTimeout(timeout));
        return;
      }
      logger.warn(`[${this.accountId}] 子进程 stdin 不可写，直接走兜底信号`);
    }

    fallbackKill();
  }

  /**
   * 最近 N 次运行的日志（含当前未结束的一次）；按时间倒序（最近在前）。
   */
  getRecentRunLogs(n: number = MAX_RUN_LOGS): RunLog[] {
    const list = this.currentRunLog ? [this.currentRunLog, ...this.runLogs] : [...this.runLogs];
    return list.slice(0, n);
  }
}

// ──────────────────────────────────────────────
// 向后兼容：保留旧的模块级导出，供 server.ts 在迁移期间使用
// ──────────────────────────────────────────────

let _compat: DashboardRunner | null = null;

function getCompat(): DashboardRunner {
  if (!_compat) _compat = new DashboardRunner("default", "default", getSchedulePath(), ".notion-auth.json");
  return _compat;
}

export function start(options: { configPath?: string; headlessOverride?: boolean }): void {
  getCompat().start(options);
}
export function stop(): void {
  getCompat().stop();
}
export function getRunStatus(): RunStatus {
  return getCompat().getRunStatus();
}
export function getRecentRunLogs(n?: number): RunLog[] {
  return getCompat().getRecentRunLogs(n);
}
