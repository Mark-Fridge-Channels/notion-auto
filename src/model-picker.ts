/**
 * 模型切换：点击发送按钮左侧打开模型弹窗，识别当前选中项并点击下一项。
 * 先一直等待直到可发送状态（SEND_BUTTON 可见），再执行切换，不做「短超时 + 3 次重试」。
 */

import type { Page } from "playwright";
import { SEND_BUTTON, WAIT_SUBMIT_READY_MS } from "./selectors.js";
import { logger } from "./logger.js";

const DIALOG_WAIT_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 定位发送按钮左侧相邻元素（先 preceding-sibling，再父级 preceding-sibling），返回可点击的 Locator 或 null。
 */
function getModelPickerButton(page: Page): Promise<ReturnType<Page["locator"]> | null> {
  const sendLoc = page.locator(SEND_BUTTON).first();
  const sendParent = sendLoc.locator("xpath=..");
  const leftSibling = sendParent.locator("xpath=preceding-sibling::*[1]");
  const grandParent = sendParent.locator("xpath=..");
  const leftOfParent = grandParent.locator("xpath=preceding-sibling::*[1]");

  return (async () => {
    const leftCount = await leftSibling.count();
    if (leftCount > 0) return leftSibling.first();
    const leftOfParentCount = await leftOfParent.count();
    if (leftOfParentCount > 0) return leftOfParent.first();
    return null;
  })();
}

/**
 * 执行一次「打开弹窗 → 识别当前选中 → 点击下一项」。
 * 先等待 SEND_BUTTON 可见（可发送状态），与发送后等待时长一致，避免输出未结束就尝试切换；再定位其左侧元素并执行切换。
 */
async function doSwitchToNextModel(page: Page): Promise<void> {
  const sendBtn = page.locator(SEND_BUTTON).first();
  await sendBtn.waitFor({ state: "visible", timeout: WAIT_SUBMIT_READY_MS });

  const buttonToOpenPicker = await getModelPickerButton(page);
  if (!buttonToOpenPicker) {
    throw new Error("无法定位发送按钮左侧元素（当前已为可发送状态）");
  }

  await buttonToOpenPicker.click();
  await sleep(DIALOG_WAIT_MS);

  const dialog = page.locator('div[role="dialog"][aria-modal="true"]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });

  const menuItems = dialog.locator('[role="menuitem"]');
  const n = await menuItems.count();
  if (n === 0) throw new Error("模型弹窗内未找到 role=menuitem");

  // 识别当前选中项：含 .checkmarkSmall 的 menuitem，若无则视为 0
  let currentIndex = 0;
  for (let i = 0; i < n; i++) {
    const hasCheck = (await menuItems.nth(i).locator(".checkmarkSmall").count()) > 0;
    if (hasCheck) {
      currentIndex = i;
      break;
    }
  }

  const nextIndex = (currentIndex + 1) % n;
  await menuItems.nth(nextIndex).click();
  await sleep(400);
}

/**
 * 切换到下一个模型：先等待可发送状态（最多与 WAIT_SUBMIT_READY_MS 一致），再打开发送左侧弹窗、点击下一项。
 * 不做短超时 + 3 次重试，避免在输出未结束时报错；等待到能切换后再执行一次，失败则打日志并返回。
 */
export async function switchToNextModel(page: Page): Promise<void> {
  try {
    await doSwitchToNextModel(page);
    logger.info("已切换至下一模型");
  } catch (e) {
    logger.warn("模型切换失败，跳过本次切换，继续运行", e);
  }
}
