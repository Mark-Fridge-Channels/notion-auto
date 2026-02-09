/**
 * 测试脚本：定位发送按钮左侧相邻元素，点击打开模型弹窗，并循环切换一个周期
 * （依次切换到每个模型，最后从最后一个切回第一个），确认每个都能点到且末→首正常。
 *
 * 运行：npx tsx scripts/test-model-picker.ts
 * 需已登录 Notion（可先跑一次主流程保存 .notion-auth.json，或本脚本内手动登录）。
 */

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import {
  NOTION_URL,
  AI_FACE_IMG,
  SEND_BUTTON,
  MODAL_WAIT_MS,
} from "../src/selectors.js";

const STORAGE_PATH = ".notion-auth.json";
const LOGIN_WAIT_MS = existsSync(STORAGE_PATH) ? 5_000 : 60_000;

function log(msg: string): void {
  console.log(`[test-model-picker] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const contextOptions = existsSync(STORAGE_PATH)
    ? { storageState: STORAGE_PATH }
    : {};
  const context = await browser.newContext(contextOptions);
  const page = context.newPage();
  const p = await page;
  p.setDefaultTimeout(20_000);

  try {
    log("打开 Notion…");
    await p.goto(NOTION_URL, { waitUntil: "domcontentloaded" });
    log(`等待 ${LOGIN_WAIT_MS / 1000} 秒（登录或跳过）…`);
    await sleep(LOGIN_WAIT_MS);

    log("点击 Notion AI 入口…");
    const img = p.locator(AI_FACE_IMG).first();
    await img.waitFor({ state: "visible" });
    await img.locator("xpath=..").click();
    await sleep(MODAL_WAIT_MS);

    log("等待发送按钮出现…");
    const sendLoc = p.locator(SEND_BUTTON).first();
    await sendLoc.waitFor({ state: "visible" });

    // 发送按钮左侧相邻元素：先试同一父节点下的前一个兄弟，否则试父级的前一个兄弟
    const sendParent = sendLoc.locator("xpath=..");
    const leftSibling = sendParent.locator("xpath=preceding-sibling::*[1]");
    const leftCount = await leftSibling.count();
    const grandParent = sendParent.locator("xpath=..");
    const leftOfParent = grandParent.locator("xpath=preceding-sibling::*[1]");
    const leftOfParentCount = await leftOfParent.count();

    const buttonToOpenPicker =
      leftCount > 0 ? leftSibling.first() : leftOfParentCount > 0 ? leftOfParent.first() : null;
    if (!buttonToOpenPicker) {
      throw new Error("无法定位发送按钮左侧元素（已试 preceding-sibling 与父级 preceding-sibling），请检查 DOM");
    }
    if (leftCount === 0) log("使用父级的前一个兄弟作为「左侧」元素");

    log("点击发送按钮左侧元素，打开模型弹窗…");
    await buttonToOpenPicker.click();
    await sleep(500);

    const dialog = p.locator('div[role="dialog"][aria-modal="true"]');
    await dialog.waitFor({ state: "visible" });
    log("弹窗已出现");

    const menuItems = dialog.locator('[role="menuitem"]');
    const n = await menuItems.count();
    log(`共 ${n} 个模型选项`);

    if (n === 0) {
      throw new Error("弹窗内未找到 role=menuitem");
    }

    // 收集每项文案（便于日志）
    const labels: string[] = [];
    for (let i = 0; i < n; i++) {
      const text = await menuItems.nth(i).innerText().catch(() => "");
      labels.push(text.trim().split("\n")[0] ?? `item-${i}`);
    }
    log("模型列表: " + labels.join(" | "));

    // 切换一个完整周期：依次点击 1, 2, ..., n-1, 0（共 n 次），即每次打开弹窗后点「下一项」
    for (let step = 0; step < n; step++) {
      const nextIndex = (step + 1) % n;
      log(`--- 第 ${step + 1}/${n} 次切换：点击第 ${nextIndex + 1} 项 (${labels[nextIndex]}) ---`);

      const item = menuItems.nth(nextIndex);
      await item.waitFor({ state: "visible" });
      await item.click();
      await sleep(800);

      // 弹窗可能已关闭，下一轮需再次点击左侧按钮打开
      const stillVisible = await dialog.isVisible().catch(() => false);
      if (stillVisible) {
        log("弹窗仍在，等待关闭或点击外部…");
        await sleep(500);
      }

      if (step < n - 1) {
        log("再次点击左侧按钮打开弹窗…");
        await buttonToOpenPicker.click();
        await sleep(500);
        await dialog.waitFor({ state: "visible" });
      }
    }

    log("已切换回第一项，一个周期测试完成。");
    log("请目视确认：最后一步应已选回列表第一项。5 秒后关闭…");
    await sleep(5_000);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
