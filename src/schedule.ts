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

/** 行业：Notion URL + 任务链 + 行业级每 N 次新会话、每 M 次换模型 */
export interface ScheduleIndustry {
  /** 行业唯一标识，时间区间通过此 id 引用行业 */
  id: string;
  /** 该行业对应的 Notion 页面 URL */
  notionUrl: string;
  /** 每跑 N 次后点击 New AI chat 新建会话；0 表示不新建会话 */
  newChatEveryRuns: number;
  /** 每跑 M 次后切换模型；0 表示不切换 */
  modelSwitchInterval: number;
  /** 任务链，按顺序执行 */
  tasks: ScheduleTask[];
}

/** 时间区间：左闭右开 [startHour, endHour)；小时 0–23，endHour 可为 24 表示到次日 0 点前 */
export interface TimeSlot {
  /** 区间起始小时（含）0–23 */
  startHour: number;
  /** 区间结束小时（不含）0–24；24 表示 24:00 即次日 0:00 前；跨天如 22–6 用 startHour=22 endHour=6 */
  endHour: number;
  /** 该区间绑定的行业 id */
  industryId: string;
}

export interface Schedule {
  /** 每轮间隔（毫秒） */
  intervalMs: number;
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
}

const DEFAULT_STORAGE_PATH = ".notion-auth.json";

/** 默认/示例配置：一个区间 + 一个行业 + 一个任务 */
export function getDefaultSchedule(): Schedule {
  return {
    intervalMs: 2 * 60 * 1000,
    loginWaitMs: 60 * 1000,
    maxRetries: 3,
    storagePath: DEFAULT_STORAGE_PATH,
    timeSlots: [
      { startHour: 0, endHour: 24, industryId: "default" },
    ],
    industries: [
      {
        id: "default",
        notionUrl: "https://www.notion.so/",
        newChatEveryRuns: 1,
        modelSwitchInterval: 1,
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
  if (typeof o.notionUrl !== "string") throw new Error(`行业[${index}].notionUrl 必须为字符串`);
  const n = Number(o.newChatEveryRuns);
  if (!Number.isInteger(n) || n < 0) throw new Error(`行业[${index}].newChatEveryRuns 必须为非负整数`);
  const m = Number(o.modelSwitchInterval);
  if (!Number.isInteger(m) || m < 0) throw new Error(`行业[${index}].modelSwitchInterval 必须为非负整数`);
  if (!Array.isArray(o.tasks)) throw new Error(`行业[${index}].tasks 必须为数组`);
  if (o.tasks.length === 0) throw new Error(`行业[${index}].tasks 不能为空`);
  o.tasks.forEach((t, i) => validateTask(t, i));
}

function validateTimeSlot(slot: unknown, index: number): asserts slot is TimeSlot {
  if (slot == null || typeof slot !== "object") throw new Error(`时间区间[${index}] 必须为对象`);
  const o = slot as Record<string, unknown>;
  const start = Number(o.startHour);
  const end = Number(o.endHour);
  if (!Number.isInteger(start) || start < 0 || start > 23) throw new Error(`时间区间[${index}].startHour 必须为 0–23 的整数`);
  if (!Number.isInteger(end) || end < 0 || end > 24) throw new Error(`时间区间[${index}].endHour 必须为 0–24 的整数`);
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
  if (!Number.isFinite(s.intervalMs) || s.intervalMs < 1) throw new Error("intervalMs 必须为正数");
  if (!Number.isFinite(s.loginWaitMs) || s.loginWaitMs < 0) throw new Error("loginWaitMs 必须为非负数");
  if (!Number.isFinite(s.maxRetries) || s.maxRetries < 1) throw new Error("maxRetries 必须为正整数");
  if (typeof s.storagePath !== "string" || s.storagePath.includes("..") || s.storagePath.startsWith("/"))
    throw new Error("storagePath 必须为当前目录下的相对路径");
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

/** 从对象合并默认值（不写盘），用于 API 传入的 partial */
export function mergeSchedule(partial: unknown): Schedule {
  const def = getDefaultSchedule();
  if (partial == null || typeof partial !== "object") return def;
  const o = partial as Record<string, unknown>;
  const out: Schedule = {
    intervalMs: Number(o.intervalMs) || def.intervalMs,
    loginWaitMs: Number(o.loginWaitMs) ?? def.loginWaitMs,
    maxRetries: Number(o.maxRetries) || def.maxRetries,
    storagePath: typeof o.storagePath === "string" ? o.storagePath : def.storagePath,
    timeSlots: Array.isArray(o.timeSlots) ? (o.timeSlots as TimeSlot[]) : def.timeSlots,
    industries: Array.isArray(o.industries) ? (o.industries as ScheduleIndustry[]) : def.industries,
  };
  return out;
}

/** 写入 schedule 文件；写入前校验 */
export async function saveSchedule(filePath: string, s: Schedule): Promise<void> {
  validateSchedule(s);
  await writeFile(filePath, JSON.stringify(s, null, 2), "utf-8");
}

/**
 * 根据当前时间（本地时区）解析所在时间区间，返回对应行业；未落入任何区间返回 null。
 * 左闭右开：[startHour, endHour)。跨天区间如 22–6 表示 22:00 到次日 6:00（即 endHour < startHour 时视为跨天）。
 */
export function getIndustryForNow(schedule: Schedule): ScheduleIndustry | null {
  const now = new Date();
  const hour = now.getHours();
  const industryMap = new Map(schedule.industries.map((i) => [i.id, i]));
  for (const slot of schedule.timeSlots) {
    const inSlot =
      slot.startHour <= slot.endHour
        ? hour >= slot.startHour && hour < slot.endHour
        : hour >= slot.startHour || hour < slot.endHour;
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
