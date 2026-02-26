/**
 * Notion AI 自动化主流程（时间区间 + 行业任务链模式）：
 * 按当前时间落入的时间区间选择行业 → 打开该行业 Notion Portal URL → 按任务链顺序执行（行业级每 N 次新会话、每 M 次换模型），
 * 任务链跑完立刻循环；跨区间时切换行业。7×24 运行直到用户停止。
 *
 * 单轮失败不退出：重试 → New AI chat 再试 → 刷新+重开再试，仍失败则 EXIT_RECOVERY_RESTART 由 Dashboard 重启。
 */

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import {
  loadSchedule,
  getSchedulePath,
  getIndustryForNow,
  waitUntilInSlot,
} from "./schedule.js";
import {
  AI_FACE_IMG,
  AI_INPUT,
  SEND_BUTTON,
  NEW_CHAT_BUTTON,
  MODAL_WAIT_MS,
  WAIT_SUBMIT_READY_MS,
  PERSONALIZE_DIALOG,
  PERSONALIZE_DIALOG_CHECK_MS,
} from "./selectors.js";
import { switchToNextModel } from "./model-picker.js";
import { logger } from "./logger.js";
import { saveProgress } from "./progress.js";
import { EXIT_RECOVERY_RESTART } from "./exit-codes.js";
import type { ScheduleIndustry } from "./schedule.js";

/** 当前行业是否为 Playwright 任务链（非 Queue 出站发送） */
function isPlaywrightIndustry(ind: ScheduleIndustry): boolean {
  return ind.type !== "queue";
}

/** 闭区间 [min, max] 内随机整数（含两端），用于间隔与 N/M 区间 */
function randomIntInclusive(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor((hi - lo + 1) * Math.random());
}

/** 从行业区间随机得到本会话的 N、M */
function drawSessionN(industry: ScheduleIndustry): number {
  return randomIntInclusive(industry.newChatEveryRunsMin, industry.newChatEveryRunsMax);
}
function drawSessionM(industry: ScheduleIndustry): number {
  return randomIntInclusive(industry.modelSwitchIntervalMin, industry.modelSwitchIntervalMax);
}

/** 运行入口：解析 --config、--storage，加载 schedule、等待落入区间后启动浏览器并进入主循环 */
async function main(): Promise<void> {
  const { configPath, storagePath: overrideStorage } = getConfigPathFromArgs();
  const schedule = await loadSchedule(configPath);
  if (overrideStorage != null) schedule.storagePath = overrideStorage;

  if (schedule.timeSlots.length === 0) {
    throw new Error("配置中时间区间列表为空，无法运行");
  }

  // 等待直至当前时间落入某区间且为 Playwright 行业（Queue 时段由 Queue Sender 进程处理，本进程跳过）
  logger.info("正在根据当前时间解析运行区间…");
  let currentIndustry = getIndustryForNow(schedule);
  if (currentIndustry == null) {
    logger.info("当前时间未落入任何配置区间，等待中…");
    currentIndustry = await waitUntilInSlot(schedule);
  }
  while (!isPlaywrightIndustry(currentIndustry)) {
    logger.info("当前时段为 Queue 行业，Playwright 不执行，等待…");
    await sleep(60_000);
    currentIndustry = getIndustryForNow(schedule);
    if (currentIndustry == null) currentIndustry = await waitUntilInSlot(schedule);
  }
  logger.info(`当前行业: ${currentIndustry.id}, URL: ${currentIndustry.notionUrl}`);

  const browser = await chromium.launch({ headless: false });
  const storagePath = schedule.storagePath;
  const contextOptions = existsSync(storagePath) ? { storageState: storagePath } : {};
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  if (!currentIndustry.notionUrl?.trim()) {
    throw new Error(`行业 "${currentIndustry.id}" 的 Notion Portal URL 未配置，请在 Dashboard 中填写`);
  }
  logger.info("正在打开 Notion…");
  await page.goto(currentIndustry.notionUrl, { waitUntil: "domcontentloaded" });
  const hasSavedAuth = Boolean(contextOptions.storageState);

  try {
    if (hasSavedAuth) {
      logger.info("已加载已保存的登录态，5 秒后继续（如需重新登录请在此期间操作）");
      await sleep(5_000);
    } else {
      logger.info(`等待 ${schedule.loginWaitMs / 1000} 秒，请在此时间内完成登录…`);
      await sleep(schedule.loginWaitMs);
    }

    await openNotionAI(page, currentIndustry.notionUrl, schedule.maxRetries);
    try {
      await context.storageState({ path: storagePath });
      logger.info("登录成功，已保存登录态");
    } catch (e) {
      logger.warn("保存登录态失败", e);
    }
    await clickNewAIChat(page, schedule.maxRetries);

    /** 本行业累计执行次数（日志与 saveProgress） */
    let runCount = 0;
    /** 当前会话内执行次数（仅「开新会话」时重置：进入/切换行业、按 currentN 主动 new chat；失败重试的 new chat 不重置） */
    let sessionRuns = 0;
    /** 本会话的 N、M（开新会话时从行业区间随机） */
    let currentN = drawSessionN(currentIndustry);
    let currentM = drawSessionM(currentIndustry);
    /** 本时段内已跑完的完整任务链轮数（仅完整一轮结束后 +1；跑满 chainRunsPerSlot 后等待离开时段，不持久化） */
    let chainRunsInSlot = 0;
    /** 是否刚因「跑满 N 轮」而离开当前时段；再次落入同一行业时重置 chainRunsInSlot */
    let leftCurrentSlot = false;

    for (;;) {
      // 每轮任务链开始前：检查是否跨时间区间需切换行业
      const industryNow = getIndustryForNow(schedule);
      if (industryNow == null) {
        logger.info("当前时间未落入任何区间，等待中…");
        await sleep(60_000);
        continue;
      }
      if (industryNow.id !== currentIndustry.id) {
        logger.info(`时间区间切换: ${currentIndustry.id} → ${industryNow.id}`);
        currentIndustry = industryNow;
        if (!isPlaywrightIndustry(currentIndustry)) {
          logger.info("当前时段为 Queue 行业，Playwright 不执行，等待…");
          await sleep(60_000);
          continue;
        }
        if (!currentIndustry.notionUrl?.trim()) {
          throw new Error(`行业 "${currentIndustry.id}" 的 Notion Portal URL 未配置，请在 Dashboard 中填写`);
        }
        runCount = 0;
        chainRunsInSlot = 0;
        leftCurrentSlot = false;
        await page.goto(currentIndustry.notionUrl, { waitUntil: "domcontentloaded" });
        await sleep(500);
        const img = page.locator(AI_FACE_IMG).first();
        await img.waitFor({ state: "visible" });
        await img.locator("xpath=..").click();
        await sleep(MODAL_WAIT_MS);
        await dismissPersonalizeDialogIfPresent(page);
        await clickNewAIChat(page, schedule.maxRetries);
        sessionRuns = 0;
        currentN = drawSessionN(currentIndustry);
        currentM = drawSessionM(currentIndustry);
      } else if (leftCurrentSlot) {
        // 再次落入同一行业（如次日同一时段），视为新区段，重置本时段已跑轮数
        chainRunsInSlot = 0;
        leftCurrentSlot = false;
      }

      // 执行一轮任务链
      for (const task of currentIndustry.tasks) {
        for (let k = 0; k < task.runCount; k++) {
          if (currentN > 0 && sessionRuns > 0 && sessionRuns % currentN === 0) {
            await clickNewAIChat(page, schedule.maxRetries);
            sessionRuns = 0;
            currentN = drawSessionN(currentIndustry);
            currentM = drawSessionM(currentIndustry);
          }
          if (currentM > 0 && sessionRuns > 0 && sessionRuns % currentM === 0) {
            await switchToNextModel(page);
          }

          let ok = await tryTypeAndSend(page, task.content, schedule.maxRetries, schedule.autoClickDuringOutputWait ?? []);
          if (!ok) {
            logger.warn("本轮流试失败，尝试 New AI chat 后重试…");
            try {
              await clickNewAIChat(page, schedule.maxRetries);
              ok = await tryTypeAndSend(page, task.content, schedule.maxRetries, schedule.autoClickDuringOutputWait ?? []);
            } catch (e) {
              logger.warn("New AI chat 失败", e);
            }
          }
          if (!ok) {
            for (let r = 0; r < MAX_REOPEN_PER_ROUND && !ok; r++) {
              logger.warn(`重新打开 Notion 并重试（${r + 1}/${MAX_REOPEN_PER_ROUND}）…`);
              try {
                await reopenNotionAndNewChat(page, currentIndustry.notionUrl, schedule.maxRetries);
                ok = await tryTypeAndSend(page, task.content, schedule.maxRetries, schedule.autoClickDuringOutputWait ?? []);
              } catch (e) {
                logger.warn("reopenNotionAndNewChat 失败", e);
              }
            }
          }
          if (!ok) {
            logger.warn("本轮流试与恢复后仍失败，请求恢复重启");
            await saveProgress({ totalDone: 0, conversationRuns: 0, completed: false });
            process.exit(EXIT_RECOVERY_RESTART);
          }

          runCount++;
          sessionRuns++;
          await saveProgress({ totalDone: runCount, conversationRuns: 0, completed: false });
          logger.info(`行业 ${currentIndustry.id} 已执行 ${runCount} 次（任务 "${task.content.slice(0, 30)}…"）`);

          const intervalMs = randomIntInclusive(schedule.intervalMinMs, schedule.intervalMaxMs);
          logger.info(`等待 ${intervalMs / 1000} 秒后继续...`);
          await sleep(intervalMs);
        }
      }
      // 任务链完整跑完一轮后才计数；若本时段已跑满 chainRunsPerSlot 则等待离开当前时段
      chainRunsInSlot++;
      const limit = currentIndustry.chainRunsPerSlot ?? 0;
      if (limit > 0 && chainRunsInSlot >= limit) {
        logger.info(`本时段已跑满 ${chainRunsInSlot} 轮任务链（上限 ${limit}），等待离开当前时段…`);
        let waitMinutes = 0;
        for (;;) {
          await sleep(60_000);
          waitMinutes++;
          const next = getIndustryForNow(schedule);
          if (next == null || next.id !== currentIndustry.id) {
            leftCurrentSlot = true;
            break;
          }
          if (waitMinutes > 0 && waitMinutes % 5 === 0) {
            logger.info(`仍在当前时段，已等待 ${waitMinutes} 分钟，稍后继续检查…`);
          }
        }
        continue;
      }
      // 未设上限或未跑满：立刻从头再跑下一轮任务链（不 break）
    }
  } finally {
    try {
      await context.storageState({ path: storagePath });
    } catch (e) {
      logger.warn("保存登录态失败", e);
    }
    try {
      await browser.close();
    } catch (e) {
      logger.warn("关闭浏览器失败", e);
    }
  }
}

/** 从 argv 解析 --config、--storage；--config 默认 getSchedulePath() */
function getConfigPathFromArgs(): { configPath: string; storagePath?: string } {
  const args = process.argv.slice(2);
  let configPath = getSchedulePath();
  let storagePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1] != null) {
      configPath = args[++i];
    } else if (args[i] === "--storage" && args[i + 1] != null) {
      storagePath = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  return { configPath, storagePath };
}

function printHelp(): void {
  process.stdout.write(`
notion-auto — 时间区间 + 行业任务链（7×24 运行）

用法: npm run run -- [--config <path>] [--storage <path>]
  --config <path>  配置文件路径（默认 schedule.json）
  --storage <path> 登录态保存路径（默认见 schedule 内 storagePath）

环境变量:
  NOTION_AUTO_RESUME=1  由 Dashboard 恢复重启时设置，从当前时间对应行业任务 1 开始
`);
}

async function dismissPersonalizeDialogIfPresent(page: import("playwright").Page): Promise<void> {
  const dialog = page.locator(PERSONALIZE_DIALOG).first();
  try {
    await dialog.waitFor({ state: "visible", timeout: PERSONALIZE_DIALOG_CHECK_MS });
  } catch {
    return;
  }
  const doneBtn = dialog.getByRole("button", { name: "Done" });
  await doneBtn.first().click();
  await sleep(300);
}

/** 打开 Notion 并点击 AI 入口；使用指定 notionUrl */
async function openNotionAI(
  page: import("playwright").Page,
  notionUrl: string,
  maxRetries: number,
): Promise<void> {
  await runWithRetry(maxRetries, async () => {
    await page.goto(notionUrl, { waitUntil: "domcontentloaded" });
    const img = page.locator(AI_FACE_IMG).first();
    await img.waitFor({ state: "visible" });
    const parent = img.locator("xpath=..");
    await parent.click();
    await sleep(MODAL_WAIT_MS);
  });
  await dismissPersonalizeDialogIfPresent(page);
}

const INPUT_CLICK_DELAY_MS = 150;

/** 等待输出结束时的轮询间隔（毫秒） */
const AUTO_CLICK_POLL_MS = 1500;

/** 转义字符串中的正则特殊字符，用于 getByRole(role, { name: /^...$/ }) 的精确匹配 */
function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * 在总超时内轮询：先查发送按钮可见则结束；否则按配置顺序查「role=button、name 精确匹配」的按钮，可见则点击后继续轮询。
 * 不重置总超时；点击失败仅打日志。
 */
async function waitForSendButtonWithAutoClick(
  page: import("playwright").Page,
  buttonNames: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sendBtn = page.locator(SEND_BUTTON).first();
    if (await sendBtn.isVisible().catch(() => false)) return;
    for (const name of buttonNames) {
      const loc = page.getByRole("button", { name: new RegExp("^" + escapeRegex(name) + "$") }).first();
      if (await loc.isVisible().catch(() => false)) {
        try {
          await loc.click();
        } catch (e) {
          logger.warn(`等待输出期间自动点击按钮失败 name=${name}`, e);
        }
        break;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(AUTO_CLICK_POLL_MS, remaining));
  }
  throw new WaitAfterSendTimeoutError(new Error("timeout"));
}

/** 事后清扫时长（毫秒）：等待结束后再扫这段时间，覆盖「对话已结束、按钮稍后才弹出」的情况 */
const SWEEP_DURATION_MS = 5000;
/** 事后清扫轮询间隔（毫秒） */
const SWEEP_INTERVAL_MS = 1000;

/**
 * 事后清扫：在固定时长内轮询，只检测并点击配置的按钮，不查发送按钮、不抛错。
 * 用于在「等待输出结束」已返回后，捕获稍后才弹出的按钮（如 Delete pages）。
 */
async function sweepAutoClickButtons(
  page: import("playwright").Page,
  buttonNames: string[],
): Promise<void> {
  const deadline = Date.now() + SWEEP_DURATION_MS;
  while (Date.now() < deadline) {
    for (const name of buttonNames) {
      const loc = page.getByRole("button", { name: new RegExp("^" + escapeRegex(name) + "$") }).first();
      if (await loc.isVisible().catch(() => false)) {
        try {
          await loc.click();
        } catch (e) {
          logger.warn(`事后清扫自动点击按钮失败 name=${name}`, e);
        }
        break;
      }
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(SWEEP_INTERVAL_MS, remaining));
  }
}

async function typeAndSend(page: import("playwright").Page, text: string, buttonNames: string[] = []): Promise<void> {
  if (process.env.NOTION_AUTO_SIMULATE_STUCK === "1") {
    throw new Error("模拟卡住（NOTION_AUTO_SIMULATE_STUCK=1）");
  }
  const input = page.locator(AI_INPUT).first();
  await input.waitFor({ state: "visible" });
  const box = await input.boundingBox();
  if (!box) throw new Error("无法获取输入框边界");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.click(centerX, centerY);
  await sleep(INPUT_CLICK_DELAY_MS);
  const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAll);
  await page.keyboard.type(text, { delay: 30 });
  const send = page.locator(SEND_BUTTON).first();
  await send.waitFor({ state: "visible" });
  await send.click();
  try {
    await waitForSendButtonWithAutoClick(page, buttonNames, WAIT_SUBMIT_READY_MS);
  } catch (e) {
    throw new WaitAfterSendTimeoutError(e);
  }
  if (buttonNames.length > 0) {
    await sweepAutoClickButtons(page, buttonNames);
  }
}

async function clickNewAIChat(page: import("playwright").Page, maxRetries: number): Promise<void> {
  await runWithRetry(maxRetries, async () => {
    const btn = page.locator(NEW_CHAT_BUTTON).first();
    await btn.waitFor({ state: "visible" });
    await btn.click();
    await sleep(MODAL_WAIT_MS);
  });
}

async function reopenNotionAndNewChat(
  page: import("playwright").Page,
  notionUrl: string,
  maxRetries: number,
): Promise<void> {
  if (process.env.NOTION_AUTO_SIMULATE_STUCK === "1") {
    throw new Error("模拟浏览器卡住（NOTION_AUTO_SIMULATE_STUCK=1）");
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(500);
  const img = page.locator(AI_FACE_IMG).first();
  await img.waitFor({ state: "visible" });
  await img.locator("xpath=..").click();
  await sleep(MODAL_WAIT_MS);
  await dismissPersonalizeDialogIfPresent(page);
  const btn = page.locator(NEW_CHAT_BUTTON).first();
  await btn.waitFor({ state: "visible" });
  await btn.click();
  await sleep(MODAL_WAIT_MS);
}

async function runWithRetry<T>(max: number, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < max - 1) logger.warn(`重试 ${i + 1}/${max}…`, e);
    }
  }
  throw lastError;
}

const MAX_REOPEN_PER_ROUND = 3;

class WaitAfterSendTimeoutError extends Error {
  constructor(public readonly cause: unknown) {
    super("发送后等待可发送状态超时（AI 可能仍在输出）");
    this.name = "WaitAfterSendTimeoutError";
  }
}

async function tryTypeAndSend(
  page: import("playwright").Page,
  prompt: string,
  max: number,
  buttonNames: string[],
): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    try {
      await typeAndSend(page, prompt, buttonNames);
      return true;
    } catch (e) {
      if (e instanceof WaitAfterSendTimeoutError) {
        logger.warn("发送后等待超时，仅再等一次发送按钮出现，不再重发");
        try {
          await page.locator(SEND_BUTTON).first().waitFor({ state: "visible", timeout: WAIT_SUBMIT_READY_MS });
          return true;
        } catch {
          return false;
        }
      }
      if (i < max - 1) logger.warn(`输入+发送 重试 ${i + 1}/${max}…`, e);
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
