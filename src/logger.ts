/**
 * 简单 logger：进度与错误统一输出到 stderr，便于与 --help（stdout）区分
 */

function log(level: string, ...args: unknown[]): void {
  const prefix = `[notion-auto ${level}]`;
  const msg = args.length === 1 && typeof args[0] === "string"
    ? args[0]
    : args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
  process.stderr.write(`${prefix} ${msg}\n`);
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
