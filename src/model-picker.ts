/**
 * 模型切换：点击发送按钮左侧打开模型弹窗，识别当前选中项并点击下一项。
 * 失败时重试最多 3 次，仍失败则打日志并 return，不抛错。
 */

import type { Page } from "playwright";
import { SEND_BUTTON } from "./selectors.js";
import { logger } from "./logger.js";

const MODEL_PICKER_RETRIES = 3;
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
 * 执行一次「打开弹窗 → 识别当前选中 → 点击下一项」；失败则 throw，由调用方重试。
 */
async function doSwitchToNextModel(page: Page): Promise<void> {
  const buttonToOpenPicker = await getModelPickerButton(page);
  if (!buttonToOpenPicker) {
    throw new Error("无法定位发送按钮左侧元素");
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
 * 切换到下一个模型：打开发送左侧弹窗，点击下一项。最多重试 3 次，仍失败则打日志并返回，不抛错。
 */
export async function switchToNextModel(page: Page): Promise<void> {
  for (let i = 0; i < MODEL_PICKER_RETRIES; i++) {
    try {
      await doSwitchToNextModel(page);
      logger.info("已切换至下一模型");
      return;
    } catch (e) {
      if (i < MODEL_PICKER_RETRIES - 1) {
        logger.warn(`模型切换重试 ${i + 1}/${MODEL_PICKER_RETRIES}…`, e);
      } else {
        logger.warn("模型切换失败，跳过本次切换，继续运行", e);
      }
    }
  }
}
