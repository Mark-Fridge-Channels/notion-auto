/**
 * 多账号管理器：维护 accounts.json，为每个账号创建独立的 DashboardRunner 实例。
 * 首次加载时自动将根目录的 schedule.json + .notion-auth.json 迁移到 accounts/default/。
 */

import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { DashboardRunner, type RunStatus, type RunLog } from "./dashboard-runner.js";
import { loadSchedule, saveSchedule, getDefaultSchedule, validateSchedule, type Schedule } from "./schedule.js";
import { logger } from "./logger.js";

const ACCOUNTS_DIR = "accounts";
const ACCOUNTS_JSON = "accounts.json";

export interface AccountMeta {
  id: string;
  label: string;
}

export interface AccountInfo extends AccountMeta {
  status: RunStatus;
}

interface AccountsFile {
  accounts: AccountMeta[];
}

/** 内部实例 */
interface AccountInstance {
  meta: AccountMeta;
  runner: DashboardRunner;
  configPath: string;
  storagePath: string;
}

const instances = new Map<string, AccountInstance>();
let accountsMeta: AccountMeta[] = [];
let initialized = false;

// ──────────────────────────────────────────────
// 路径工具
// ──────────────────────────────────────────────

function accountsDir(): string {
  return join(process.cwd(), ACCOUNTS_DIR);
}
function accountDir(id: string): string {
  return join(accountsDir(), id);
}
function accountConfigPath(id: string): string {
  return join(accountDir(id), "schedule.json");
}
function accountStoragePath(id: string): string {
  return join(accountDir(id), ".notion-auth.json");
}
function accountsJsonPath(): string {
  return join(process.cwd(), ACCOUNTS_JSON);
}

// ──────────────────────────────────────────────
// 持久化 accounts.json
// ──────────────────────────────────────────────

async function loadAccountsJson(): Promise<AccountsFile> {
  try {
    const raw = await readFile(accountsJsonPath(), "utf-8");
    const data = JSON.parse(raw) as AccountsFile;
    if (data && Array.isArray(data.accounts)) return data;
  } catch {
    // 不存在或无效
  }
  return { accounts: [] };
}

async function saveAccountsJson(): Promise<void> {
  const data: AccountsFile = { accounts: accountsMeta };
  await writeFile(accountsJsonPath(), JSON.stringify(data, null, 2), "utf-8");
}

// ──────────────────────────────────────────────
// 自动迁移
// ──────────────────────────────────────────────

async function autoMigrate(): Promise<void> {
  const rootSchedule = join(process.cwd(), "schedule.json");
  const rootAuth = join(process.cwd(), ".notion-auth.json");
  const hasRootSchedule = existsSync(rootSchedule);
  const hasRootAuth = existsSync(rootAuth);
  const hasAccountsDir = existsSync(accountsDir());

  // 仅在 accounts/ 目录不存在 且 根目录有旧文件时迁移
  if (hasAccountsDir) return;
  if (!hasRootSchedule && !hasRootAuth) return;

  logger.info("检测到根目录配置文件，自动迁移到 accounts/default/ ...");
  const defaultDir = accountDir("default");
  await mkdir(defaultDir, { recursive: true });

  if (hasRootSchedule) {
    await copyFile(rootSchedule, accountConfigPath("default"));
    logger.info("已迁移 schedule.json → accounts/default/schedule.json");
  }
  if (hasRootAuth) {
    await copyFile(rootAuth, accountStoragePath("default"));
    logger.info("已迁移 .notion-auth.json → accounts/default/.notion-auth.json");
  }

  // 写入 accounts.json
  accountsMeta = [{ id: "default", label: "默认账号" }];
  await saveAccountsJson();
  logger.info("自动迁移完成，已创建 accounts.json");
}

// ──────────────────────────────────────────────
// 初始化
// ──────────────────────────────────────────────

export async function init(): Promise<void> {
  if (initialized) return;
  initialized = true;

  await autoMigrate();

  const file = await loadAccountsJson();
  accountsMeta = file.accounts;

  // 为每个已有账号创建 runner 实例
  for (const meta of accountsMeta) {
    await ensureAccountDir(meta.id);
    const inst = createInstance(meta);
    instances.set(meta.id, inst);
  }
  logger.info(`已加载 ${accountsMeta.length} 个账号`);
}

function createInstance(meta: AccountMeta): AccountInstance {
  const configPath = accountConfigPath(meta.id);
  const storagePath = accountStoragePath(meta.id);
  const runner = new DashboardRunner(meta.id, meta.label, configPath, storagePath);
  return { meta, runner, configPath, storagePath };
}

async function ensureAccountDir(id: string): Promise<void> {
  const dir = accountDir(id);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  // 确保有默认 schedule.json
  const cfg = accountConfigPath(id);
  if (!existsSync(cfg)) {
    const defaultSchedule = getDefaultSchedule();
    await saveSchedule(cfg, defaultSchedule);
  }
}

// ──────────────────────────────────────────────
// 公开 API
// ──────────────────────────────────────────────

export function listAccounts(): AccountInfo[] {
  return accountsMeta.map((m) => ({
    id: m.id,
    label: m.label,
    status: instances.get(m.id)?.runner.getRunStatus() ?? "idle",
  }));
}

export async function addAccount(id: string, label: string): Promise<void> {
  if (instances.has(id)) throw new Error(`账号 "${id}" 已存在`);
  if (!id || !id.trim()) throw new Error("账号 ID 不能为空");
  if (/[\/\\\.]+/.test(id)) throw new Error("账号 ID 不能包含路径分隔符或点号");

  const meta: AccountMeta = { id: id.trim(), label: label.trim() || id.trim() };
  await ensureAccountDir(meta.id);
  const inst = createInstance(meta);
  instances.set(meta.id, inst);
  accountsMeta.push(meta);
  await saveAccountsJson();
}

export async function removeAccount(id: string): Promise<void> {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  // 先停止
  inst.runner.stop();
  instances.delete(id);
  accountsMeta = accountsMeta.filter((m) => m.id !== id);
  await saveAccountsJson();
}

export async function updateAccountLabel(id: string, label: string): Promise<void> {
  const meta = accountsMeta.find((m) => m.id === id);
  if (!meta) throw new Error(`账号 "${id}" 不存在`);
  meta.label = label.trim() || id;
  await saveAccountsJson();
}

export function startAccount(id: string): void {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  if (inst.runner.getRunStatus() === "running") throw new Error(`账号 "${id}" 已在运行`);
  inst.runner.start();
}

/**
 * 在 **idle** 账号上启动一次性插队子进程（执行完一条后退出，不进入 7×24 主循环）。
 * 若账号非 idle 则抛错（插队已分配给 running 账号时由主进程自行消费，无需调用本函数）。
 */
export function startAdhocOnce(accountId: string, jobId: string): void {
  const inst = instances.get(accountId);
  if (!inst) throw new Error(`账号 "${accountId}" 不存在`);
  if (inst.runner.getRunStatus() !== "idle") {
    throw new Error(`账号 "${accountId}" 非空闲，无法启动插队子进程`);
  }
  inst.runner.startAdhocOnce(jobId);
}

/**
 * 当前处于「一次性插队子进程」状态的账号数，用于 server 侧全局并发上限判断。
 * 不包含正在跑主循环（`start()` 启动）的账号。
 */
export function countAdhocOnceInFlight(): number {
  let n = 0;
  for (const [, inst] of instances) {
    if (inst.runner.isAdhocOnceRunning()) n++;
  }
  return n;
}

export function stopAccount(id: string): void {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  inst.runner.stop();
}

/**
 * 错峰启动间隔（毫秒）：避免 6 个 Chromium 在同一秒抢带宽 / CPU / swap，
 * 导致 Notion SPA 初刷互相拖累、`page.goto` 30s 超时。
 *
 * - env `NOTION_AUTO_STARTUP_STAGGER_MS` 覆盖（整数，>=0）
 * - 默认 25_000ms（6 个账号约 2.5 分钟全部到位，可接受）
 * - 设为 0 等同旧行为：同时 spawn
 */
const STARTUP_STAGGER_MS = (() => {
  const raw = Number(process.env.NOTION_AUTO_STARTUP_STAGGER_MS);
  if (!Number.isFinite(raw) || raw < 0) return 25_000;
  return Math.floor(raw);
})();

/**
 * 全部启动：按 `STARTUP_STAGGER_MS` 间隔逐个 spawn，非阻塞返回。
 * 已 running 的账号自动跳过。后续新添加的账号不会被这次调用覆盖。
 */
export function startAll(opts?: { headlessOverride: boolean }): void {
  const pending: AccountInstance[] = [];
  for (const [, inst] of instances) {
    if (inst.runner.getRunStatus() === "idle") pending.push(inst);
  }
  if (pending.length === 0) return;
  // 首账号立刻启动，后续按间隔排 setTimeout；中途有账号被手动起跑则跳过，避免重复 start。
  pending[0]!.runner.start(opts);
  for (let i = 1; i < pending.length; i++) {
    const inst = pending[i]!;
    setTimeout(() => {
      if (inst.runner.getRunStatus() === "idle") inst.runner.start(opts);
    }, i * STARTUP_STAGGER_MS);
  }
}

export function stopAll(): void {
  for (const [, inst] of instances) {
    inst.runner.stop();
  }
}

export function getAccountStatus(id: string): RunStatus {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  return inst.runner.getRunStatus();
}

export function getAccountLogs(id: string, n: number = 10): RunLog[] {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  return inst.runner.getRecentRunLogs(n);
}

export async function getAccountSchedule(id: string): Promise<Schedule> {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  return loadSchedule(inst.configPath);
}

export async function saveAccountScheduleData(id: string, schedule: Schedule): Promise<void> {
  const inst = instances.get(id);
  if (!inst) throw new Error(`账号 "${id}" 不存在`);
  validateSchedule(schedule);
  await saveSchedule(inst.configPath, schedule);
}

/**
 * 广播：将同一份 schedule 写入多个账号。
 * 若 accountIds 为空/undefined 则写入所有账号。
 */
export async function broadcastSchedule(schedule: Schedule, accountIds?: string[]): Promise<string[]> {
  validateSchedule(schedule);
  const targets = accountIds && accountIds.length > 0
    ? accountIds
    : accountsMeta.map((m) => m.id);
  const saved: string[] = [];
  for (const id of targets) {
    const inst = instances.get(id);
    if (!inst) {
      logger.warn(`广播跳过不存在的账号 "${id}"`);
      continue;
    }
    await saveSchedule(inst.configPath, schedule);
    saved.push(id);
  }
  return saved;
}
