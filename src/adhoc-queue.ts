/**
 * Webhook 插队任务：持久化队列（data/adhoc-queue.json）、互斥锁文件、分配与状态更新。
 * 与 Notion 队列（notion-queue.ts）无数据关联。
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { logger } from "./logger.js";

const DATA_DIR = "data";
const QUEUE_FILE = "adhoc-queue.json";
const LOCK_FILE = "adhoc-queue.lock";
/** 超过该时间未更新的 lock 视为陈旧（仅防崩溃遗留）；正常持锁可能达数分钟，不宜过短 */
const LOCK_STALE_MS = 900_000;
/** 0 字节锁文件仅在存在一小段时间后才视为遗留，避免误删「刚独占创建尚未写入 PID」的文件 */
const LOCK_EMPTY_ABANDON_MS = 2_500;
const LOCK_RETRY_MS = 50;
const MAX_URL_LEN = 4096;
const MAX_PROMPT_LEN = 100_000;
const MAX_MODEL_LEN = 256;

export type AdhocJobStatus = "queued" | "assigned" | "running" | "done" | "failed";

/** 单条插队任务（持久化） */
export interface AdhocJob {
  id: string;
  createdAt: number;
  url: string;
  prompt: string;
  timeoutGotoMs: number;
  timeoutSendMs: number;
  model?: string;
  status: AdhocJobStatus;
  assignedAccountId?: string;
  lastError?: string;
}

interface AdhocQueueStore {
  jobs: AdhocJob[];
  /** 在「可分配账号」列表上的轮询游标，用于同优先级内轮转 */
  assignRoundRobin: number;
}

function queueDir(): string {
  return join(process.cwd(), DATA_DIR);
}

function queuePath(): string {
  return join(queueDir(), QUEUE_FILE);
}

function lockPath(): string {
  return join(queueDir(), LOCK_FILE);
}

/** 从 schedule 路径解析账号 id（accounts/<id>/schedule.json）；非多账号布局返回 null */
export function deriveAccountIdFromConfigPath(configPath: string): string | null {
  const norm = configPath.replace(/\\/g, "/");
  const m = norm.match(/\/accounts\/([^/]+)\/schedule\.json$/i);
  return m ? m[1] : null;
}

let terminalListener: (() => void) | null = null;

/** 在任务进入终态（done/failed）后调用，用于 server 侧继续分配 queued 任务 */
export function setAdhocTerminalListener(fn: (() => void) | null): void {
  terminalListener = fn;
}

function notifyTerminal(): void {
  try {
    terminalListener?.();
  } catch (e) {
    logger.warn("adhoc terminal listener 回调失败", e);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function ensureDataDir(): Promise<void> {
  if (!existsSync(queueDir())) {
    await mkdir(queueDir(), { recursive: true });
  }
}

function defaultStore(): AdhocQueueStore {
  return { jobs: [], assignRoundRobin: 0 };
}

const VALID_STATUSES: ReadonlySet<string> = new Set(["queued", "assigned", "running", "done", "failed"]);

/** 从磁盘恢复的 job：字段合法才保留，避免损坏 JSON 拖垮运行时 */
function parseAndFilterJob(raw: unknown): AdhocJob | null {
  if (raw == null || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const id = typeof j.id === "string" ? j.id.trim() : "";
  const url = typeof j.url === "string" ? j.url.trim() : "";
  const prompt = typeof j.prompt === "string" ? j.prompt : "";
  const tg = Number(j.timeoutGotoMs);
  const ts = Number(j.timeoutSendMs);
  const status = typeof j.status === "string" ? j.status : "";
  const createdAt = Number(j.createdAt);
  if (!id || !url || !VALID_STATUSES.has(status)) return null;
  if (!/^https?:\/\//i.test(url) || url.length > MAX_URL_LEN) return null;
  if (!Number.isInteger(tg) || tg <= 0 || tg > 3_600_000) return null;
  if (!Number.isInteger(ts) || ts <= 0 || ts > 3_600_000) return null;
  if (prompt.length > MAX_PROMPT_LEN) return null;
  const assignedAccountId =
    typeof j.assignedAccountId === "string" && j.assignedAccountId.trim() ? j.assignedAccountId.trim() : undefined;
  const modelRaw = typeof j.model === "string" ? j.model.trim() : "";
  const lastError = typeof j.lastError === "string" ? j.lastError.slice(0, 2000) : undefined;
  const job: AdhocJob = {
    id,
    createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    url,
    prompt,
    timeoutGotoMs: tg,
    timeoutSendMs: ts,
    status: status as AdhocJobStatus,
    ...(assignedAccountId ? { assignedAccountId } : {}),
    ...(modelRaw && modelRaw.length <= MAX_MODEL_LEN ? { model: modelRaw } : {}),
    ...(lastError ? { lastError } : {}),
  };
  return job;
}

function parseStore(raw: string): AdhocQueueStore {
  try {
    const data = JSON.parse(raw) as unknown;
    if (data == null || typeof data !== "object") return defaultStore();
    const o = data as Record<string, unknown>;
    const rawJobs = Array.isArray(o.jobs) ? o.jobs : [];
    const jobs: AdhocJob[] = [];
    for (const item of rawJobs) {
      const parsed = parseAndFilterJob(item);
      if (parsed) jobs.push(parsed);
      else if (item != null) logger.warn("adhoc 队列：跳过无效或损坏的任务条目");
    }
    const assignRoundRobin = Number(o.assignRoundRobin);
    return {
      jobs,
      assignRoundRobin: Number.isFinite(assignRoundRobin) ? Math.max(0, Math.floor(assignRoundRobin)) : 0,
    };
  } catch {
    return defaultStore();
  }
}

async function readStoreUnlocked(): Promise<AdhocQueueStore> {
  await ensureDataDir();
  const p = queuePath();
  try {
    const raw = await readFile(p, "utf-8");
    return parseStore(raw);
  } catch {
    return defaultStore();
  }
}

async function writeStoreUnlocked(store: AdhocQueueStore): Promise<void> {
  await ensureDataDir();
  const p = queuePath();
  const tmp = `${p}.${process.pid}.tmp`;
  const json = JSON.stringify(store, null, 2);
  await writeFile(tmp, json, "utf-8");
  await rename(tmp, p);
}

function isLikelyPidDead(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** 尝试摘除明显无主的 lock：崩溃常留下 0 字节文件或持有者进程已不存在 */
async function tryRemoveAbandonedLock(lp: string): Promise<boolean> {
  let st;
  try {
    st = await stat(lp);
  } catch {
    return false;
  }
  const age = Date.now() - st.mtimeMs;
  if (age > LOCK_STALE_MS) {
    await unlink(lp).catch(() => {});
    return true;
  }
  if (st.size === 0 && age > LOCK_EMPTY_ABANDON_MS) {
    await unlink(lp).catch(() => {});
    return true;
  }
  try {
    const raw = (await readFile(lp, "utf-8")).trim();
    const data = JSON.parse(raw) as { pid?: unknown };
    const pid = typeof data.pid === "number" ? data.pid : NaN;
    if (Number.isFinite(pid) && isLikelyPidDead(pid)) {
      await unlink(lp).catch(() => {});
      return true;
    }
  } catch {
    /* 非 JSON（旧格式空文件已由 size===0 处理）则仅依赖陈旧时间 */
  }
  return false;
}

/** 排他锁：跨平台用独占创建 lock 文件；陈旧锁或可判定为孤儿锁时抢占（防止崩溃遗留） */
async function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  await ensureDataDir();
  const lp = lockPath();
  const deadline = Date.now() + 30_000;
  let lockFd: import("node:fs/promises").FileHandle | null = null;
  while (Date.now() < deadline) {
    try {
      const fd = await open(lp, "wx");
      try {
        await fd.writeFile(`${JSON.stringify({ pid: process.pid, at: Date.now() })}\n`, "utf-8");
        lockFd = fd;
        break;
      } catch {
        await fd.close().catch(() => {});
        await unlink(lp).catch(() => {});
      }
    } catch {
      const removed = await tryRemoveAbandonedLock(lp);
      if (!removed) {
        await sleep(LOCK_RETRY_MS);
      }
    }
  }
  if (!lockFd) {
    throw new Error("无法获取 adhoc 队列锁（超时）");
  }
  try {
    return await fn();
  } finally {
    await lockFd.close().catch(() => {});
    await unlink(lp).catch(() => {});
  }
}

export interface AdhocEnqueuePayload {
  url: string;
  prompt: string;
  timeoutGotoMs: number;
  timeoutSendMs: number;
  model?: string;
}

export function validateAdhocEnqueuePayload(body: unknown): { ok: true; data: AdhocEnqueuePayload } | { ok: false; error: string } {
  if (body == null || typeof body !== "object") return { ok: false, error: "body 须为 JSON 对象" };
  const o = body as Record<string, unknown>;
  const url = typeof o.url === "string" ? o.url.trim() : "";
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  const tg = Number(o.timeoutGotoMs);
  const ts = Number(o.timeoutSendMs);
  const model = typeof o.model === "string" ? o.model.trim() : "";
  if (!url) return { ok: false, error: "url 不能为空" };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "url 须为 http(s) 链接" };
  if (url.length > MAX_URL_LEN) return { ok: false, error: `url 长度不得超过 ${MAX_URL_LEN}` };
  if (!prompt) return { ok: false, error: "prompt 不能为空" };
  if (prompt.length > MAX_PROMPT_LEN) return { ok: false, error: `prompt 长度不得超过 ${MAX_PROMPT_LEN}` };
  if (model.length > MAX_MODEL_LEN) return { ok: false, error: `model 长度不得超过 ${MAX_MODEL_LEN}` };
  if (!Number.isInteger(tg) || tg <= 0) return { ok: false, error: "timeoutGotoMs 须为正整数" };
  if (!Number.isInteger(ts) || ts <= 0) return { ok: false, error: "timeoutSendMs 须为正整数" };
  if (tg > 3_600_000 || ts > 3_600_000) return { ok: false, error: "超时不得超过 3600000 毫秒" };
  return {
    ok: true,
    data: {
      url,
      prompt,
      timeoutGotoMs: tg,
      timeoutSendMs: ts,
      ...(model ? { model } : {}),
    },
  };
}

/** 某账号当前是否有已分配或执行中的插队（用于容量判断） */
function inFlightCountForAccount(store: AdhocQueueStore, accountId: string): number {
  return store.jobs.filter(
    (j) => j.assignedAccountId === accountId && (j.status === "assigned" || j.status === "running"),
  ).length;
}

export type AccountEligibility = { id: string; runStatus: "idle" | "running" };

/**
 * 将一条 queued 任务分配给下一个有容量的账号：idle 优先，其次 running；同档内轮询。
 * 返回是否发生了分配（用于调用方决定是否 spawn adhoc 子进程）。
 */
export async function assignOneQueuedJob(accounts: AccountEligibility[]): Promise<{
  assigned: boolean;
  jobId?: string;
  accountId?: string;
  targetWasIdle: boolean;
}> {
  if (accounts.length === 0) return { assigned: false, targetWasIdle: false };

  return withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const idx = store.jobs.findIndex((j) => j.status === "queued");
    if (idx === -1) return { assigned: false, targetWasIdle: false };

    const eligible = accounts.filter((a) => inFlightCountForAccount(store, a.id) === 0);
    if (eligible.length === 0) return { assigned: false, targetWasIdle: false };

    const idle = eligible.filter((a) => a.runStatus === "idle");
    const running = eligible.filter((a) => a.runStatus === "running");
    const ordered = [...idle, ...running];
    const cursor = store.assignRoundRobin % ordered.length;
    const pick = ordered[cursor]!;
    store.assignRoundRobin = store.assignRoundRobin + 1;

    const job = store.jobs[idx]!;
    job.status = "assigned";
    job.assignedAccountId = pick.id;
    await writeStoreUnlocked(store);
    return {
      assigned: true,
      jobId: job.id,
      accountId: pick.id,
      targetWasIdle: pick.runStatus === "idle",
    };
  });
}

/** 仅入队为 queued，不分配（由 tryAssign 或 webhook 链式调用） */
export async function enqueueAdhocJob(payload: AdhocEnqueuePayload): Promise<string> {
  return withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const id = randomUUID();
    const job: AdhocJob = {
      id,
      createdAt: Date.now(),
      url: payload.url,
      prompt: payload.prompt,
      timeoutGotoMs: payload.timeoutGotoMs,
      timeoutSendMs: payload.timeoutSendMs,
      ...(payload.model ? { model: payload.model } : {}),
      status: "queued",
    };
    store.jobs.push(job);
    await writeStoreUnlocked(store);
    return id;
  });
}

/** Webhook：入队并尽力分配队列中**最早**一条 queued（可能不是刚入队的这条） */
export async function enqueueAndTryAssign(
  payload: AdhocEnqueuePayload,
  accounts: AccountEligibility[],
): Promise<{ jobId: string; assigned: boolean; accountId?: string; targetWasIdle?: boolean }> {
  const jobId = await enqueueAdhocJob(payload);
  const assign = await assignOneQueuedJob(accounts);
  const isOurJob = assign.assigned && assign.jobId === jobId;
  return {
    jobId,
    assigned: isOurJob,
    accountId: isOurJob ? assign.accountId : undefined,
    targetWasIdle: isOurJob ? assign.targetWasIdle : undefined,
  };
}

/** 运行中子进程：原子领取一条已分配给本账号且 status=assigned 的任务 */
export async function takeAssignedAdhocJob(accountId: string): Promise<AdhocJob | null> {
  return withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const job = store.jobs.find((j) => j.assignedAccountId === accountId && j.status === "assigned");
    if (!job) return null;
    job.status = "running";
    await writeStoreUnlocked(store);
    return { ...job };
  });
}

/** 可中断 sleep：是否有已分配待执行（尚未标记 running） */
export async function hasPendingAssignedAdhoc(accountId: string): Promise<boolean> {
  return withQueueLock(async () => {
    const store = await readStoreUnlocked();
    return store.jobs.some((j) => j.assignedAccountId === accountId && j.status === "assigned");
  });
}

/** 一次性子进程：按 jobId 取任务并标为 running（须匹配 accountId） */
export async function claimAdhocJobForOneShot(jobId: string, accountId: string): Promise<AdhocJob | null> {
  return withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const job = store.jobs.find((j) => j.id === jobId);
    if (!job) return null;
    if (job.assignedAccountId !== accountId) {
      logger.warn(`adhoc job ${jobId} 分配账号与当前不符`);
      return null;
    }
    if (job.status !== "assigned") {
      logger.warn(`adhoc job ${jobId} 状态为 ${job.status}，无法认领`);
      return null;
    }
    job.status = "running";
    await writeStoreUnlocked(store);
    return { ...job };
  });
}

export async function markAdhocJobDone(jobId: string): Promise<void> {
  let changed = false;
  await withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const job = store.jobs.find((j) => j.id === jobId);
    if (job) {
      job.status = "done";
      delete job.lastError;
      changed = true;
    }
    await writeStoreUnlocked(store);
  });
  if (changed) notifyTerminal();
}

export async function markAdhocJobFailed(jobId: string, message: string): Promise<void> {
  let changed = false;
  await withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const job = store.jobs.find((j) => j.id === jobId);
    if (job) {
      job.status = "failed";
      job.lastError = message.slice(0, 2000);
      changed = true;
    }
    await writeStoreUnlocked(store);
  });
  if (changed) notifyTerminal();
}

/** 子进程异常退出：assigned 或 running 均标为失败，避免卡死队列 */
export async function markAdhocJobFailedIfActive(jobId: string, message: string): Promise<void> {
  let changed = false;
  await withQueueLock(async () => {
    const store = await readStoreUnlocked();
    const job = store.jobs.find((j) => j.id === jobId);
    if (job && (job.status === "assigned" || job.status === "running")) {
      job.status = "failed";
      job.lastError = message.slice(0, 2000);
      changed = true;
      await writeStoreUnlocked(store);
    }
  });
  if (changed) notifyTerminal();
}
