/**
 * 三条文案默认值：按全局轮数选择（第 1～5 轮 Task 1，第 6～10 轮 Task 2，第 11 轮起随机）。
 * 实际使用由 getPromptForRun(runIndex, task1, task2, task3) 的入参决定，此处仅作默认/导出。
 */

export const TASK_1 = "@Task 1 — Add new DTC companies ";
export const TASK_2 = "@Task 2 — Find high-priority contacts ";
export const TASK_3 = "@Task 3 — Find people contact (LinkedIn / Email / X) ";

/**
 * 根据「即将执行的是第几轮」（runIndex = totalDone + 1）及三条文案返回本条文案。
 * - 第 1～5 轮：task1
 * - 第 6～10 轮：task2
 * - 第 11 轮起：在 task1、task2、task3 中随机选一条
 */
export function getPromptForRun(
  runIndex: number,
  task1: string,
  task2: string,
  task3: string,
): string {
  if (runIndex <= 1) return task1;
  if (runIndex <= 5) return task2;
  const pool = [task1, task2, task3];
  const i = Math.floor(Math.random() * pool.length);
  return pool[i];
}
