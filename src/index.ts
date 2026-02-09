/**
 * Notion AI 自动化主流程：
 * 打开浏览器 → 等 1 分钟登录 → 打开 Notion → 点击 AI 入口 → 定时输入+发送，每 10 轮新建对话，跑满总轮数退出。
 */

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { parseArgs, type Config } from "./config.js";
import {
  NOTION_URL,
  AI_FACE_IMG,
  AI_INPUT,
  SEND_BUTTON,
  NEW_CHAT_BUTTON,
  MODAL_WAIT_MS,
} from "./selectors.js";
import { getPromptForRun } from "./prompts.js";
import { switchToNextModel } from "./model-picker.js";
import { logger } from "./logger.js";

async function main(): Promise<void> {
  const config = parseArgs();

  // Step 3: 启动浏览器（headed），加载或新建 context
  const browser = await chromium.launch({ headless: false });
  const storagePath = config.storagePath;
  const contextOptions =
    existsSync(storagePath) ?
      { storageState: storagePath }
    : {};

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  // 打开后默认访问 Notion，等待期间用户可直接在当前页登录
  logger.info("正在打开 Notion…");
  await page.goto(NOTION_URL, { waitUntil: "domcontentloaded" });

  const hasSavedAuth = Boolean(contextOptions.storageState);

  try {
    // 已加载登录态时只等 5 秒（便于取消或重登），否则等满 loginWaitMs 供首次登录
    if (hasSavedAuth) {
      logger.info("已加载已保存的登录态，5 秒后继续（如需重新登录请在此期间操作）");
      await sleep(5_000);
    } else {
      logger.info(`等待 ${config.loginWaitMs / 1000} 秒，请在此时间内完成登录（登录后会保存，下次可复用）…`);
      await sleep(config.loginWaitMs);
    }

    // Step 4: 导航到 Notion，点击 AI 入口打开弹窗
    await openNotionAI(page, config);

    let totalDone = 0;
    let conversationRuns = 0; // 当前对话内已执行轮数，到 10 则点 New AI chat 并置 0

    // Step 6: 主循环
    while (totalDone < config.totalRuns) {
      // 每 10 轮：点击 New AI chat，重置对话计数
      if (conversationRuns >= 10) {
        await clickNewAIChat(page, config);
        conversationRuns = 0;
      }

      // 每 N 轮切换模型（N=0 不切换）；失败不退出，由 switchToNextModel 内打日志
      if (
        config.modelSwitchInterval > 0 &&
        totalDone > 0 &&
        totalDone % config.modelSwitchInterval === 0
      ) {
        await switchToNextModel(page);
      }

      // 按全局轮数选文案：第 1～5 轮 task1，第 6～10 轮 task2，第 11 轮起随机
      const runIndex = totalDone + 1;
      const prompt = getPromptForRun(
        runIndex,
        config.promptTask1,
        config.promptTask2,
        config.promptTask3,
      );

      await runWithRetry(config.maxRetries, () =>
        typeAndSend(page, prompt),
      );

      totalDone++;
      conversationRuns++;
      logger.info(
        `已执行 ${totalDone}/${config.totalRuns} 轮（本对话 ${conversationRuns}/10）`,
      );

      if (totalDone >= config.totalRuns) break;

      await sleep(config.intervalMs);
    }

    logger.info("已完成全部轮数，退出。");
  } finally {
    // Step 7: 保存登录态并关闭；收尾失败只打日志，不掩盖主错误
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

/** 导航到 Notion 并点击 Notion AI 头像的父 div，打开弹窗；弹窗出现后等 1s */
async function openNotionAI(page: import("playwright").Page, config: Config): Promise<void> {
  await runWithRetry(config.maxRetries, async () => {
    await page.goto(NOTION_URL, { waitUntil: "domcontentloaded" });
    const img = page.locator(AI_FACE_IMG).first();
    await img.waitFor({ state: "visible" });
    const parent = img.locator("xpath=..");
    await parent.click();
    await sleep(MODAL_WAIT_MS);
  });
}

/** 单次输入+发送：定位 contenteditable，点击后全选并输入文案（先清空再输入），点击发送 */
async function typeAndSend(
  page: import("playwright").Page,
  text: string,
): Promise<void> {
  const input = page.locator(AI_INPUT).first();
  await input.waitFor({ state: "visible" });
  await input.click();
  // contenteditable：全选后输入以清空并替换（Mac 用 Meta，其它用 Control）
  const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAll);
  await page.keyboard.type(text, { delay: 30 });
  const send = page.locator(SEND_BUTTON).first();
  await send.waitFor({ state: "visible" });
  await send.click();
}

/** 点击 New AI chat */
async function clickNewAIChat(
  page: import("playwright").Page,
  config: Config,
): Promise<void> {
  await runWithRetry(config.maxRetries, async () => {
    const btn = page.locator(NEW_CHAT_BUTTON).first();
    await btn.waitFor({ state: "visible" });
    await btn.click();
    await sleep(MODAL_WAIT_MS);
  });
}

/** 最多重试 max 次，仍失败则抛出最后一次错误 */
async function runWithRetry<T>(
  max: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < max; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < max - 1) {
        logger.warn(`重试 ${i + 1}/${max}…`, e);
      }
    }
  }
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
