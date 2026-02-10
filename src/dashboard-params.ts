/**
 * Dashboard 可序列化参数：与 CLI 对应，不含 storage；供 params.json 与 spawn argv 使用。
 */

import { readFile, writeFile } from "node:fs/promises";
import { TASK_1, TASK_2, TASK_3 } from "./prompts.js";
import { NOTION_URL } from "./selectors.js";

/** 与 Config 对应、可 JSON 序列化的参数（无 storage）；间隔与登录等待用秒便于表单与 JSON */
export interface DashboardParams {
  totalRuns: number;
  intervalSeconds: number;
  loginWaitSeconds: number;
  notionUrl: string;
  newChatEveryRuns: number;
  modelSwitchInterval: number;
  promptTask1: string;
  promptTask2: string;
  promptTask3: string;
  /** 使用 Prompt 网关时必填；空字符串或 null 表示不使用 */
  promptGateway: string | null;
  maxRetries: number;
}

const DASHBOARD_DEFAULTS: DashboardParams = {
  totalRuns: 25,
  intervalSeconds: 120,
  loginWaitSeconds: 60,
  notionUrl: NOTION_URL,
  newChatEveryRuns: 10,
  modelSwitchInterval: 50,
  promptTask1: TASK_1,
  promptTask2: TASK_2,
  promptTask3: TASK_3,
  promptGateway: null,
  maxRetries: 3,
};

export function getDefaultParams(): DashboardParams {
  return { ...DASHBOARD_DEFAULTS };
}

function validate(p: unknown): asserts p is DashboardParams {
  if (p == null || typeof p !== "object") throw new Error("params 必须为对象");
  const o = p as Record<string, unknown>;
  if (!Number.isFinite(o.totalRuns) || (o.totalRuns as number) < 1)
    throw new Error("totalRuns 必须为正整数");
  if (!Number.isFinite(o.intervalSeconds) || (o.intervalSeconds as number) < 1)
    throw new Error("intervalSeconds 必须为正整数");
  if (!Number.isFinite(o.loginWaitSeconds) || (o.loginWaitSeconds as number) < 0)
    throw new Error("loginWaitSeconds 必须为非负整数");
  if (typeof o.notionUrl !== "string") throw new Error("notionUrl 必须为字符串");
  if (!Number.isFinite(o.newChatEveryRuns) || (o.newChatEveryRuns as number) < 1)
    throw new Error("newChatEveryRuns 必须为正整数（最小 1）");
  if (!Number.isFinite(o.modelSwitchInterval) || (o.modelSwitchInterval as number) < 0)
    throw new Error("modelSwitchInterval 必须为非负整数");
  if (typeof o.promptTask1 !== "string") throw new Error("promptTask1 必须为字符串");
  if (typeof o.promptTask2 !== "string") throw new Error("promptTask2 必须为字符串");
  if (typeof o.promptTask3 !== "string") throw new Error("promptTask3 必须为字符串");
  if (o.promptGateway !== null && typeof o.promptGateway !== "string")
    throw new Error("promptGateway 必须为字符串或 null");
  if (typeof o.promptGateway === "string" && o.promptGateway.trim() === "")
    throw new Error("--prompt-gateway 为必填项，不能为空");
  if (!Number.isFinite(o.maxRetries) || (o.maxRetries as number) < 1)
    throw new Error("maxRetries 必须为正整数");
}

/** 从 JSON 对象合并默认值并校验 */
export function mergeAndValidate(partial: unknown): DashboardParams {
  const out = { ...getDefaultParams() };
  if (partial != null && typeof partial === "object") {
    const o = partial as Record<string, unknown>;
    if (o.totalRuns !== undefined) out.totalRuns = Number(o.totalRuns);
    if (o.intervalSeconds !== undefined) out.intervalSeconds = Number(o.intervalSeconds);
    if (o.loginWaitSeconds !== undefined) out.loginWaitSeconds = Number(o.loginWaitSeconds);
    if (o.notionUrl !== undefined) out.notionUrl = String(o.notionUrl);
    if (o.newChatEveryRuns !== undefined) out.newChatEveryRuns = Number(o.newChatEveryRuns);
    if (o.modelSwitchInterval !== undefined) out.modelSwitchInterval = Number(o.modelSwitchInterval);
    if (o.promptTask1 !== undefined) out.promptTask1 = String(o.promptTask1);
    if (o.promptTask2 !== undefined) out.promptTask2 = String(o.promptTask2);
    if (o.promptTask3 !== undefined) out.promptTask3 = String(o.promptTask3);
    if (o.promptGateway !== undefined) {
      const v = o.promptGateway === null || o.promptGateway === "" ? null : String(o.promptGateway).trim();
      out.promptGateway = v === "" ? null : v;
    }
    if (o.maxRetries !== undefined) out.maxRetries = Number(o.maxRetries);
  }
  validate(out);
  return out;
}

/** 从项目目录下的 params.json 加载；不存在或无效则返回默认 */
export async function loadParams(filePath: string): Promise<DashboardParams> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as unknown;
    return mergeAndValidate(data);
  } catch {
    return getDefaultParams();
  }
}

/** 写入 params.json；写入前校验 */
export async function saveParams(filePath: string, p: DashboardParams): Promise<void> {
  validate(p);
  await writeFile(filePath, JSON.stringify(p, null, 2), "utf-8");
}

/** 将参数转为 spawn 子进程时的 argv（不含 --storage） */
export function paramsToArgv(p: DashboardParams): string[] {
  const args: string[] = [
    "--total",
    String(p.totalRuns),
    "--interval",
    String(p.intervalSeconds),
    "--login-wait",
    String(p.loginWaitSeconds),
    "--notion-url",
    p.notionUrl,
    "--new-chat-every",
    String(p.newChatEveryRuns),
    "--model-switch-interval",
    String(p.modelSwitchInterval),
    "--task1",
    p.promptTask1,
    "--task2",
    p.promptTask2,
    "--task3",
    p.promptTask3,
  ];
  if (p.promptGateway != null && p.promptGateway.trim() !== "") {
    args.push("--prompt-gateway", p.promptGateway);
  }
  // storage 不暴露给 UI，spawn 时固定传默认值
  args.push("--storage", ".notion-auth.json");
  return args;
}
