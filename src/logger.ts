/**
 * 简单 logger：进度与错误统一输出到 stderr，便于与 --help（stdout）区分；
 * 同时追加写入项目根下 log/ 目录，文件名：本地日期 + 进程号（每次进程启动一份，便于区分并行实例与多次运行）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(process.cwd(), "log");

/** 进程内固定：首次写日志时确定路径，避免跨天同一进程内切换文件名 */
let resolvedLogFile: string | null = null;
let logFileDisabled = false;

function localDateYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function appendToLogFile(line: string): void {
  if (logFileDisabled) return;
  try {
    if (resolvedLogFile == null) {
      mkdirSync(LOG_DIR, { recursive: true });
      resolvedLogFile = join(LOG_DIR, `${localDateYmd()}_${process.pid}.log`);
    }
    appendFileSync(resolvedLogFile, line, "utf-8");
  } catch {
    logFileDisabled = true;
  }
}

function log(level: string, ...args: unknown[]): void {
  const prefix = `[notion-auto ${level}]`;
  const msg = args.length === 1 && typeof args[0] === "string"
    ? args[0]
    : args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  const line = `${prefix} ${msg}\n`;
  process.stderr.write(line);
  appendToLogFile(line);
}

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return String(err);
}

export const logger = {
  info: (msg: string) => log("INFO", msg),
  warn: (msg: string, err?: unknown) =>
    err !== undefined ? log("WARN", msg, formatErr(err)) : log("WARN", msg),
  error: (err: unknown) =>
    log("ERROR", err instanceof Error && err.stack ? err.stack : formatErr(err)),
};
