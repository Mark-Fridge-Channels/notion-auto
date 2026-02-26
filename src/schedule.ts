/**
 * 时间区间 + 行业 + 任务链配置：类型定义、加载、校验与时间区间解析。
 * 时间区间左闭右开，使用系统本地时区。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 单个任务：输入内容 + 本轮任务链中执行次数 */
export interface ScheduleTask {
  /** 该任务要输入到 Notion 的文案 */
  content: string;
  /** 该任务在本轮任务链中执行几次 */
  runCount: number;
}

/** 行业类型：Playwright 任务链 或 Queue 出站发送 */
export type ScheduleIndustryType = "playwright" | "queue";

/** 行业：Playwright 时为 Notion Portal URL + 任务链；Queue 时为 Queue 数据库 URL + 发件人库 URL。 */
export interface ScheduleIndustry {
  /** 行业唯一标识，时间区间通过此 id 引用行业 */
  id: string;
  /** 行业类型，默认 playwright；queue 时使用 queueDatabaseUrl / senderAccountsDatabaseUrl，不跑任务链 */
  type?: ScheduleIndustryType;
  /** 该行业对应的 Notion 页面 URL（Playwright 时必填） */
  notionUrl: string;
  /** 每跑 N 次后新建会话：区间 [min, max]，开新会话时随机取 N；0 表示本会话不主动新建（仅 Playwright） */
  newChatEveryRunsMin: number;
  newChatEveryRunsMax: number;
  /** 每跑 M 次后换模型：区间 [min, max]，开新会话时随机取 M；0 表示本会话不换（仅 Playwright） */
  modelSwitchIntervalMin: number;
  modelSwitchIntervalMax: number;
  /** 本时段内跑几轮完整任务链：0 = 一直跑（仅 Playwright） */
  chainRunsPerSlot: number;
  /** 任务链，按顺序执行（仅 Playwright） */
  tasks: ScheduleTask[];
  /** Queue 数据库 URL（type=queue 时必填） */
  queueDatabaseUrl?: string;
  /** 发件人库 URL，各自用（type=queue 时必填） */
  senderAccountsDatabaseUrl?: string;
  /** 每批取条数（type=queue 时可选，默认 20） */
  batchSize?: number;
}

/**
 * 时间区间：左闭右开 [start, end)；小时仅 0–23，不出现 24。
 * 止 23:59 表示「到当日结束」（比较时视为 24:00 独占上界）；跨天如 22:30–次日 6:45 用 start < end 的分钟数表示。
 */
export interface TimeSlot {
  /** 区间起始小时（含）0–23 */
  startHour: number;
  /** 区间起始分钟 0–59 */
  startMinute: number;
  /** 区间结束小时（不含）0–23 */
  endHour: number;
  /** 区间结束分钟 0–59；止 23:59 表示到当日结束 */
  endMinute: number;
  /** 该区间绑定的行业 id */
  industryId: string;
}

export interface Schedule {
  /** 每轮间隔（毫秒）：区间 [min, max]，每次发送完成后随机取再 sleep */
  intervalMinMs: number;
  intervalMaxMs: number;
  /** 首次打开页面时的登录等待（毫秒） */
  loginWaitMs: number;
  /** 单步最大重试次数 */
  maxRetries: number;
  /** 登录态保存路径（相对项目目录） */
  storagePath: string;
  /** 时间区间列表，左闭右开；至少一个 */
  timeSlots: TimeSlot[];
  /** 行业列表 */
  industries: ScheduleIndustry[];
  /** 等待 AI 输出结束期间若出现这些按钮（role=button，name 精确匹配）则自动点击；仅填按钮名称 */
  autoClickDuringOutputWait?: string[];
}

const DEFAULT_STORAGE_PATH = ".notion-auth.json";

/** 默认/示例配置：一个区间 + 一个行业 + 一个任务 */
export function getDefaultSchedule(): Schedule {
  return {
    intervalMinMs: 2 * 60 * 1000,
    intervalMaxMs: 2 * 60 * 1000,
    loginWaitMs: 60 * 1000,
    maxRetries: 3,
    storagePath: DEFAULT_STORAGE_PATH,
    timeSlots: [
      { startHour: 0, startMinute: 0, endHour: 23, endMinute: 59, industryId: "default" },
    ],
    industries: [
      {
        id: "default",
        notionUrl: "https://www.notion.so/",
        newChatEveryRunsMin: 1,
        newChatEveryRunsMax: 1,
        modelSwitchIntervalMin: 1,
        modelSwitchIntervalMax: 1,
        chainRunsPerSlot: 0,
        tasks: [
          { content: "@Task — Add new companies", runCount: 1 },
        ],
      },
    ],
  };
}

function validateTask(t: unknown, index: number): asserts t is ScheduleTask {
  if (t == null || typeof t !== "object") throw new Error(`任务[${index}] 必须为对象`);
  const o = t as Record<string, unknown>;
  if (typeof o.content !== "string") throw new Error(`任务[${index}].content 必须为字符串`);
  const rc = Number(o.runCount);
  if (!Number.isInteger(rc) || rc < 1) throw new Error(`任务[${index}].runCount 必须为正整数`);
}

function validateIndustry(ind: unknown, index: number): asserts ind is ScheduleIndustry {
  if (ind == null || typeof ind !== "object") throw new Error(`行业[${index}] 必须为对象`);
  const o = ind as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id.trim()) throw new Error(`行业[${index}].id 必须为非空字符串`);
  const industryType = o.type === "queue" ? "queue" : "playwright";
  if (industryType === "queue") {
    if (typeof o.queueDatabaseUrl !== "string" || !String(o.queueDatabaseUrl).trim())
      throw new Error(`行业[${index}].queueDatabaseUrl 必须为非空字符串（Queue 类型）`);
    if (typeof o.senderAccountsDatabaseUrl !== "string" || !String(o.senderAccountsDatabaseUrl).trim())
      throw new Error(`行业[${index}].senderAccountsDatabaseUrl 必须为非空字符串（Queue 类型）`);
    const batchSize = Number(o.batchSize);
    if (o.batchSize !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100))
      throw new Error(`行业[${index}].batchSize 必须为 1–100 的整数`);
    return;
  }
  if (typeof o.notionUrl !== "string") throw new Error(`行业[${index}].notionUrl 必须为字符串`);
  const nMin = Number(o.newChatEveryRunsMin);
  const nMax = Number(o.newChatEveryRunsMax);
  if (!Number.isInteger(nMin) || nMin < 0) throw new Error(`行业[${index}].newChatEveryRunsMin 必须为非负整数`);
  if (!Number.isInteger(nMax) || nMax < 0) throw new Error(`行业[${index}].newChatEveryRunsMax 必须为非负整数`);
  if (nMin > nMax) throw new Error(`行业[${index}] newChatEveryRunsMin 不能大于 newChatEveryRunsMax`);
  const mMin = Number(o.modelSwitchIntervalMin);
  const mMax = Number(o.modelSwitchIntervalMax);
  if (!Number.isInteger(mMin) || mMin < 0) throw new Error(`行业[${index}].modelSwitchIntervalMin 必须为非负整数`);
  if (!Number.isInteger(mMax) || mMax < 0) throw new Error(`行业[${index}].modelSwitchIntervalMax 必须为非负整数`);
  if (mMin > mMax) throw new Error(`行业[${index}] modelSwitchIntervalMin 不能大于 modelSwitchIntervalMax`);
  const chainRuns = Number(o.chainRunsPerSlot);
  if (!Number.isInteger(chainRuns) || chainRuns < 0) throw new Error(`行业[${index}].chainRunsPerSlot 必须为非负整数`);
  if (!Array.isArray(o.tasks)) throw new Error(`行业[${index}].tasks 必须为数组`);
  if (o.tasks.length === 0) throw new Error(`行业[${index}].tasks 不能为空`);
  o.tasks.forEach((t, i) => validateTask(t, i));
}

function validateTimeSlot(slot: unknown, index: number): asserts slot is TimeSlot {
  if (slot == null || typeof slot !== "object") throw new Error(`时间区间[${index}] 必须为对象`);
  const o = slot as Record<string, unknown>;
  const startH = Number(o.startHour);
  const endH = Number(o.endHour);
  const startM = Number(o.startMinute);
  const endM = Number(o.endMinute);
  if (!Number.isInteger(startH) || startH < 0 || startH > 23) throw new Error(`时间区间[${index}].startHour 必须为 0–23 的整数`);
  if (!Number.isInteger(endH) || endH < 0 || endH > 23) throw new Error(`时间区间[${index}].endHour 必须为 0–23 的整数`);
  if (!Number.isInteger(startM) || startM < 0 || startM > 59) throw new Error(`时间区间[${index}].startMinute 必须为 0–59 的整数`);
  if (!Number.isInteger(endM) || endM < 0 || endM > 59) throw new Error(`时间区间[${index}].endMinute 必须为 0–59 的整数`);
  if (typeof o.industryId !== "string" || !o.industryId.trim()) throw new Error(`时间区间[${index}].industryId 必须为非空字符串`);
}

/** 校验 Schedule 并保证时间区间引用的行业存在 */
export function validateSchedule(s: Schedule): void {
  if (s.timeSlots == null || !Array.isArray(s.timeSlots) || s.timeSlots.length === 0)
    throw new Error("timeSlots 至少包含一个时间区间");
  const industryIds = new Set((s.industries ?? []).map((i) => i.id));
  s.timeSlots.forEach((slot, i) => {
    validateTimeSlot(slot, i);
    if (!industryIds.has(slot.industryId))
      throw new Error(`时间区间[${i}] 引用的行业 "${slot.industryId}" 不存在`);
  });
  (s.industries ?? []).forEach((ind, i) => validateIndustry(ind, i));
  if (!Number.isFinite(s.intervalMinMs) || s.intervalMinMs < 1) throw new Error("intervalMinMs 必须为正数");
  if (!Number.isFinite(s.intervalMaxMs) || s.intervalMaxMs < 1) throw new Error("intervalMaxMs 必须为正数");
  if (s.intervalMinMs > s.intervalMaxMs) throw new Error("intervalMinMs 不能大于 intervalMaxMs");
  if (!Number.isFinite(s.loginWaitMs) || s.loginWaitMs < 0) throw new Error("loginWaitMs 必须为非负数");
  if (!Number.isFinite(s.maxRetries) || s.maxRetries < 1) throw new Error("maxRetries 必须为正整数");
  if (typeof s.storagePath !== "string" || s.storagePath.includes("..") || s.storagePath.startsWith("/"))
    throw new Error("storagePath 必须为当前目录下的相对路径");
  if (s.autoClickDuringOutputWait !== undefined) {
    if (!Array.isArray(s.autoClickDuringOutputWait))
      throw new Error("autoClickDuringOutputWait 必须为数组");
    s.autoClickDuringOutputWait.forEach((item, i) => {
      if (typeof item !== "string" || item.trim() === "")
        throw new Error(`autoClickDuringOutputWait[${i}] 必须为非空字符串`);
    });
  }
}

const SCHEDULE_FILENAME = "schedule.json";

/** 默认配置文件路径（项目目录下） */
export function getSchedulePath(): string {
  return join(process.cwd(), SCHEDULE_FILENAME);
}

/**
 * 从 JSON 文件加载 Schedule；不存在或解析失败则返回默认配置。
 * 返回前会校验；校验失败则抛错。
 */
export async function loadSchedule(filePath: string): Promise<Schedule> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    const s = mergeSchedule(data);
    validateSchedule(s);
    return s;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      const def = getDefaultSchedule();
      validateSchedule(def);
      return def;
    }
    throw e;
  }
}

const DEFAULT_BATCH_SIZE = 20;

/**
 * 从区间 [min, max] 规范化行业：若仅有旧单数字段则设 min=max=原值；支持 type=queue 及 Queue 字段。
 */
function normalizeIndustry(ind: unknown): ScheduleIndustry {
  const def = getDefaultSchedule().industries[0]!;
  if (ind == null || typeof ind !== "object") return def;
  const o = ind as Record<string, unknown>;
  const industryType = o.type === "queue" ? "queue" : "playwright";
  const nMin = o.newChatEveryRunsMin !== undefined ? Number(o.newChatEveryRunsMin) : Number(o.newChatEveryRuns);
  const nMax = o.newChatEveryRunsMax !== undefined ? Number(o.newChatEveryRunsMax) : Number(o.newChatEveryRuns);
  const mMin = o.modelSwitchIntervalMin !== undefined ? Number(o.modelSwitchIntervalMin) : Number(o.modelSwitchInterval);
  const mMax = o.modelSwitchIntervalMax !== undefined ? Number(o.modelSwitchIntervalMax) : Number(o.modelSwitchInterval);
  const chainRuns = o.chainRunsPerSlot !== undefined ? Number(o.chainRunsPerSlot) : def.chainRunsPerSlot;
  const batchSizeVal = o.batchSize !== undefined ? Number(o.batchSize) : DEFAULT_BATCH_SIZE;
  const base = {
    id: typeof o.id === "string" ? o.id : def.id,
    type: industryType,
    notionUrl: typeof o.notionUrl === "string" ? o.notionUrl : def.notionUrl,
    newChatEveryRunsMin: Number.isInteger(nMin) && nMin >= 0 ? nMin : def.newChatEveryRunsMin,
    newChatEveryRunsMax: Number.isInteger(nMax) && nMax >= 0 ? nMax : def.newChatEveryRunsMax,
    modelSwitchIntervalMin: Number.isInteger(mMin) && mMin >= 0 ? mMin : def.modelSwitchIntervalMin,
    modelSwitchIntervalMax: Number.isInteger(mMax) && mMax >= 0 ? mMax : def.modelSwitchIntervalMax,
    chainRunsPerSlot: Number.isInteger(chainRuns) && chainRuns >= 0 ? chainRuns : def.chainRunsPerSlot,
    tasks: Array.isArray(o.tasks) ? (o.tasks as ScheduleTask[]) : def.tasks,
  };
  if (industryType === "queue") {
    return {
      ...base,
      queueDatabaseUrl: typeof o.queueDatabaseUrl === "string" ? o.queueDatabaseUrl : "",
      senderAccountsDatabaseUrl: typeof o.senderAccountsDatabaseUrl === "string" ? o.senderAccountsDatabaseUrl : "",
      batchSize: Number.isInteger(batchSizeVal) && batchSizeVal >= 1 && batchSizeVal <= 100 ? batchSizeVal : DEFAULT_BATCH_SIZE,
    };
  }
  return base;
}

/**
 * 归一化单个时间区间：缺 startMinute/endMinute 补 0；旧配置 endHour=24 转为 endHour=23, endMinute=59。
 */
function normalizeTimeSlot(raw: unknown, index: number): TimeSlot {
  const def = getDefaultSchedule().timeSlots[0]!;
  if (raw == null || typeof raw !== "object") return { ...def };
  const o = raw as Record<string, unknown>;
  let startHour = Number(o.startHour);
  let endHour = Number(o.endHour);
  let startMinute = Number(o.startMinute);
  let endMinute = Number(o.endMinute);
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) startHour = def.startHour;
  if (!Number.isInteger(endHour) || endHour < 0 || endHour > 24) endHour = def.endHour;
  if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 59) startMinute = 0;
  if (!Number.isInteger(endMinute) || endMinute < 0 || endMinute > 59) endMinute = 0;
  if (endHour === 24) {
    endHour = 23;
    endMinute = 59;
  }
  const industryId = typeof o.industryId === "string" && o.industryId.trim() ? o.industryId.trim() : def.industryId;
  return { startHour, startMinute, endHour, endMinute, industryId };
}

/** 从对象合并默认值（不写盘），用于 API 传入的 partial；兼容旧单数字段 → min=max */
export function mergeSchedule(partial: unknown): Schedule {
  const def = getDefaultSchedule();
  if (partial == null || typeof partial !== "object") return def;
  const o = partial as Record<string, unknown>;
  const intervalMsLegacy = Number(o.intervalMs);
  const hasIntervalRange = o.intervalMinMs !== undefined || o.intervalMaxMs !== undefined;
  const intervalMin = hasIntervalRange ? Number(o.intervalMinMs) : intervalMsLegacy;
  const intervalMax = hasIntervalRange ? Number(o.intervalMaxMs) : intervalMsLegacy;
  const rawSlots = Array.isArray(o.timeSlots) ? o.timeSlots : def.timeSlots;
  const timeSlots = rawSlots.map((s: unknown, i: number) => normalizeTimeSlot(s, i));
  const out: Schedule = {
    intervalMinMs: (() => {
      const a = Number.isFinite(intervalMin) && intervalMin >= 1 ? intervalMin : def.intervalMinMs;
      const b = Number.isFinite(intervalMax) && intervalMax >= 1 ? intervalMax : def.intervalMaxMs;
      return Math.min(a, b);
    })(),
    intervalMaxMs: (() => {
      const a = Number.isFinite(intervalMin) && intervalMin >= 1 ? intervalMin : def.intervalMinMs;
      const b = Number.isFinite(intervalMax) && intervalMax >= 1 ? intervalMax : def.intervalMaxMs;
      return Math.max(a, b);
    })(),
    loginWaitMs: Number(o.loginWaitMs) ?? def.loginWaitMs,
    maxRetries: Number(o.maxRetries) || def.maxRetries,
    storagePath: typeof o.storagePath === "string" ? o.storagePath : def.storagePath,
    timeSlots,
    industries: Array.isArray(o.industries) ? (o.industries as unknown[]).map(normalizeIndustry) : def.industries,
    autoClickDuringOutputWait: Array.isArray(o.autoClickDuringOutputWait)
      ? (o.autoClickDuringOutputWait as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "")
      : undefined,
  };
  return out;
}

/** 写入 schedule 文件；写入前校验 */
export async function saveSchedule(filePath: string, s: Schedule): Promise<void> {
  validateSchedule(s);
  await writeFile(filePath, JSON.stringify(s, null, 2), "utf-8");
}

const MINUTES_PER_DAY = 24 * 60;

/**
 * 将 slot 的结束时刻转为「从 0 点起的独占上界分钟数」：止 23:59 视为 1440（即 24:00）。
 */
function slotEndMinutesExclusive(slot: TimeSlot): number {
  if (slot.endHour === 23 && slot.endMinute === 59) return MINUTES_PER_DAY;
  return slot.endHour * 60 + slot.endMinute;
}

/**
 * 将 slot 的起始时刻转为「从 0 点起的分钟数」。
 */
function slotStartMinutes(slot: TimeSlot): number {
  return slot.startHour * 60 + slot.startMinute;
}

/**
 * 根据当前时间（本地时区）解析所在时间区间，返回对应行业；未落入任何区间返回 null。
 * 左闭右开 [start, end)；比较用「从 0 点起的分钟数」，止 23:59 视为 24:00 独占上界；跨天即 endMinutes < startMinutes。
 */
export function getIndustryForNow(schedule: Schedule): ScheduleIndustry | null {
  const now = new Date();
  const currentM = now.getHours() * 60 + now.getMinutes();
  const industryMap = new Map(schedule.industries.map((i) => [i.id, i]));
  for (const slot of schedule.timeSlots) {
    const startM = slotStartMinutes(slot);
    const endM = slotEndMinutesExclusive(slot);
    const inSlot =
      startM < endM
        ? currentM >= startM && currentM < endM
        : currentM >= startM || currentM < endM;
    if (inSlot) {
      const ind = industryMap.get(slot.industryId);
      if (ind) return ind;
    }
  }
  return null;
}

/** 等待间隔：无区间时再次检查前的 sleep（毫秒） */
const WAIT_NO_SLOT_MS = 60_000;

/**
 * 等待直到当前时间落入某时间区间，返回该行业；若 timeSlots 为空则抛错。
 * 未落入区间时 sleep WAIT_NO_SLOT_MS 后重试。
 */
export async function waitUntilInSlot(schedule: Schedule): Promise<ScheduleIndustry> {
  if (schedule.timeSlots.length === 0) throw new Error("配置中时间区间列表为空，无法运行");
  for (;;) {
    const industry = getIndustryForNow(schedule);
    if (industry != null) return industry;
    await new Promise((r) => setTimeout(r, WAIT_NO_SLOT_MS));
  }
}
