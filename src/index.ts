/**
 * Notion AI 自动化主流程：
 * 打开浏览器 → 等 1 分钟登录 → 打开 Notion → 点击 AI 入口打开弹窗 → 点击 New AI chat 开启新会话 → 定时输入+发送，每 10 轮新建对话，跑满总轮数退出。
 *
 * 输入前使用鼠标坐标点击输入框中心；单轮失败不退出：先重试 3 次 → New AI chat 再试 3 次 → 重复「刷新页面 + 点 AI 头像 + New AI chat」再试（单轮最多 MAX_REOPEN_PER_ROUND 次），仍失败则跳过本轮继续。
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
  WAIT_SUBMIT_READY_MS,
  PERSONALIZE_DIALOG,
  PERSONALIZE_DIALOG_CHECK_MS,
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

    // 每次脚本启动后先点击 New AI chat 开启新会话，再进入主循环
    await clickNewAIChat(page, config);

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

      // 若使用 Prompt 网关则每轮均用网关文案，否则按全局轮数选 task1/2/3
      const runIndex = totalDone + 1;
      const prompt =
        config.promptGateway != null
          ? config.promptGateway
          : getPromptForRun(
              runIndex,
              config.promptTask1,
              config.promptTask2,
              config.promptTask3,
            );

      // 单轮「输入+发送」带恢复：先试 3 次 → 失败则 New AI chat 再试 3 次 → 仍失败则重复「刷新+AI 头像+New chat」再试（最多 MAX_REOPEN_PER_ROUND 次），全程不退出
      let ok = await tryTypeAndSend(page, prompt, config.maxRetries);
      if (!ok) {
        logger.warn("本轮流试 3 次失败，尝试 New AI chat 后重试…");
        try {
          await clickNewAIChat(page, config);
          ok = await tryTypeAndSend(page, prompt, config.maxRetries);
        } catch (e) {
          logger.warn("New AI chat 失败", e);
        }
      }
      if (!ok) {
        for (let r = 0; r < MAX_REOPEN_PER_ROUND && !ok; r++) {
          logger.warn(`重新打开 Notion 并重试（${r + 1}/${MAX_REOPEN_PER_ROUND}）…`);
          try {
            await reopenNotionAndNewChat(page, config);
            ok = await tryTypeAndSend(page, prompt, config.maxRetries);
          } catch (e) {
            logger.warn("reopenNotionAndNewChat 失败", e);
          }
        }
      }
      if (!ok) {
        logger.warn("本轮流试与恢复后仍失败，跳过本轮，继续下一轮");
      }

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

/**
 * 若出现「Personalize your Notion AI」弹窗，则定位并点击其中的 Done，关闭后再继续。
 * 短超时检测，未出现则直接返回。
 */
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

/** 导航到 Notion 并点击 Notion AI 头像的父 div，打开弹窗；弹窗出现后等 1s；若有「Personalize」弹窗则点 Done */
async function openNotionAI(page: import("playwright").Page, config: Config): Promise<void> {
  await runWithRetry(config.maxRetries, async () => {
    await page.goto(NOTION_URL, { waitUntil: "domcontentloaded" });
    const img = page.locator(AI_FACE_IMG).first();
    await img.waitFor({ state: "visible" });
    const parent = img.locator("xpath=..");
    await parent.click();
    await sleep(MODAL_WAIT_MS);
  });
  await dismissPersonalizeDialogIfPresent(page);
}

/** 输入框获得焦点后的短暂延迟（毫秒） */
const INPUT_CLICK_DELAY_MS = 150;

/**
 * 单次输入+发送：定位 contenteditable，用鼠标坐标点击输入框中心后全选并输入，点击发送。
 * 点击发送后按钮会变为「Stop AI message」，需等待再次变为「Submit AI message」后才返回，方可进行下一次输入+发送。
 */
async function typeAndSend(
  page: import("playwright").Page,
  text: string,
): Promise<void> {
  const input = page.locator(AI_INPUT).first();
  await input.waitFor({ state: "visible" });
  const box = await input.boundingBox();
  if (!box) throw new Error("无法获取输入框边界");
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.click(centerX, centerY);
  await sleep(INPUT_CLICK_DELAY_MS);
  // contenteditable：全选后输入以清空并替换（Mac 用 Meta，其它用 Control）
  const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAll);
  await page.keyboard.type(text, { delay: 30 });
  const send = page.locator(SEND_BUTTON).first();
  await send.waitFor({ state: "visible" });
  await send.click();

  // 发送后同一位置会变为 Stop，等 AI 回复完成、发送按钮再次出现后才可进行下一次发送（用 SEND_BUTTON 与 model-picker 的「可发送」判定一致）
  await page.locator(SEND_BUTTON).first().waitFor({ state: "visible", timeout: WAIT_SUBMIT_READY_MS });
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

/**
 * 重新打开 Notion：刷新页面 → 点击 AI 头像打开面板 → 点击 New AI chat 开新会话。
 * 供单轮失败恢复使用，失败时抛错供上层重试。
 */
async function reopenNotionAndNewChat(
  page: import("playwright").Page,
  config: Config,
): Promise<void> {
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

/** 单轮最多「重新打开 Notion」次数，避免死循环 */
const MAX_REOPEN_PER_ROUND = 3;

/**
 * 尝试执行 typeAndSend 最多 max 次，成功返回 true，全部失败返回 false（不抛错）。
 */
async function tryTypeAndSend(
  page: import("playwright").Page,
  prompt: string,
  max: number,
): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    try {
      await typeAndSend(page, prompt);
      return true;
    } catch (e) {
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
