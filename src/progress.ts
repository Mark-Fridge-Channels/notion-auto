/**
 * 进度持久化：progress.json（项目目录），供恢复与 Dashboard 判定是否自动重启。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "./logger.js";

export interface Progress {
  totalDone: number;
  conversationRuns: number;
  completed?: boolean;
}

const FILENAME = "progress.json";

export function getProgressPath(): string {
  return join(process.cwd(), FILENAME);
}

/**
 * 读取 progress.json；不存在或无效则返回 null。
 */
export async function loadProgress(): Promise<Progress | null> {
  const path = getProgressPath();
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as unknown;
    if (data == null || typeof data !== "object") return null;
    const o = data as Record<string, unknown>;
    const totalDone = Number(o.totalDone);
    const conversationRuns = Number(o.conversationRuns);
    if (!Number.isInteger(totalDone) || totalDone < 0 || !Number.isInteger(conversationRuns) || conversationRuns < 0)
      return null;
    return {
      totalDone,
      conversationRuns,
      completed: o.completed === true,
    };
  } catch (e) {
    logger.warn("加载进度失败，将视为无进度", e);
    return null;
  }
}

/**
 * 写入 progress.json；失败只打日志不抛错，避免单轮保存失败中断主流程。
 */
export async function saveProgress(p: Progress): Promise<void> {
  const path = getProgressPath();
  try {
    await writeFile(path, JSON.stringify(p, null, 2), "utf-8");
  } catch (e) {
    logger.warn("保存进度失败", e);
  }
}
