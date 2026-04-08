/**
 * 模型切换：优先点击 unified-chat-model-button 打开弹窗；候选项排除空、Auto、全局黑名单（normalize 后整行相等）；
 * 无指定名称时轮换下一项；有指定时在候选中子串匹配，失败则 fallback 为下一项。
 * 先等待 SEND_BUTTON 可见（可发送状态）再操作。
 */

import type { Page } from "playwright";
import { SEND_BUTTON, UNIFIED_CHAT_MODEL_BUTTON, WAIT_SUBMIT_READY_MS } from "./selectors.js";
import { logger } from "./logger.js";

const DIALOG_WAIT_MS = 500;
const POST_CLICK_WAIT_MS = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 与浏览器侧脚本一致：用于比较模型展示名与黑名单条目 */
export function normalizeModelLabel(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/beta/gi, "")
    .trim();
}

function firstDisplayLine(text: string): string {
  const line = text.trim().split("\n")[0];
  return line ?? "";
}

function isBlacklisted(label: string, blacklist: string[]): boolean {
  const n = normalizeModelLabel(label);
  for (const entry of blacklist) {
    if (normalizeModelLabel(entry) === n) return true;
  }
  return false;
}

export interface ModelSwitchOptions {
  /** 与菜单项 normalize 后整行相等则排除，不参与轮换与指定匹配 */
  blacklist: string[];
}

interface MenuRow {
  /** dialog 内 menuitem 的下标 */
  dialogIndex: number;
  label: string;
}

/**
 * 定位发送按钮左侧相邻元素（先 preceding-sibling，再父级 preceding-sibling），返回可点击的 Locator 或 null。
 */
async function getModelPickerButtonFallback(page: Page): Promise<ReturnType<Page["locator"]> | null> {
  const sendLoc = page.locator(SEND_BUTTON).first();
  const sendParent = sendLoc.locator("xpath=..");
  const leftSibling = sendParent.locator("xpath=preceding-sibling::*[1]");
  const grandParent = sendParent.locator("xpath=..");
  const leftOfParent = grandParent.locator("xpath=preceding-sibling::*[1]");

  const leftCount = await leftSibling.count();
  if (leftCount > 0) return leftSibling.first();
  const leftOfParentCount = await leftOfParent.count();
  if (leftOfParentCount > 0) return leftOfParent.first();
  return null;
}

/** 打开模型弹窗：优先 testid，失败则用发送钮左侧兄弟 */
async function clickOpenModelPicker(page: Page): Promise<void> {
  const unified = page.locator(UNIFIED_CHAT_MODEL_BUTTON).first();
  const unifiedVisible = await unified.isVisible().catch(() => false);
  if (unifiedVisible) {
    await unified.click();
    await sleep(DIALOG_WAIT_MS);
    return;
  }
  const fallback = await getModelPickerButtonFallback(page);
  if (!fallback) {
    throw new Error("无法定位模型按钮（unified-chat-model-button 不可见且无发送钮左侧元素）");
  }
  await fallback.click();
  await sleep(DIALOG_WAIT_MS);
}

/** 读取当前模型展示文案（打开弹窗之前，从按钮上读）；供主流程在发送前记录日志。 */
export async function readModelButtonLabel(page: Page): Promise<string> {
  const unified = page.locator(UNIFIED_CHAT_MODEL_BUTTON).first();
  if (await unified.isVisible().catch(() => false)) {
    return (await unified.innerText().catch(() => "")).trim();
  }
  const fallback = await getModelPickerButtonFallback(page);
  if (fallback) {
    return (await fallback.innerText().catch(() => "")).trim();
  }
  return "";
}

async function collectMenuRows(page: Page): Promise<MenuRow[]> {
  const dialog = page.locator('div[role="dialog"][aria-modal="true"]');
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const menuItems = dialog.locator('[role="menuitem"]');
  const n = await menuItems.count();
  const rows: MenuRow[] = [];
  for (let i = 0; i < n; i++) {
    const raw = await menuItems.nth(i).innerText().catch(() => "");
    const label = firstDisplayLine(raw);
    if (!label || label === "Auto") continue;
    rows.push({ dialogIndex: i, label });
  }
  return rows;
}

function buildEligible(rows: MenuRow[], blacklist: string[]): MenuRow[] {
  return rows.filter((r) => !isBlacklisted(r.label, blacklist));
}

/**
 * 切换模型：specifiedName 为空时轮换；非空时在候选中按 normalize 子串匹配，找不到则轮换下一项。
 * 异常时打日志并吞掉，不中断主流程。
 */
export async function switchModel(
  page: Page,
  specifiedName: string | undefined,
  options: ModelSwitchOptions,
  timeoutMs?: number,
): Promise<void> {
  try {
    const waitMs = timeoutMs ?? WAIT_SUBMIT_READY_MS;
    const blacklist = options.blacklist ?? [];

    const sendBtn = page.locator(SEND_BUTTON).first();
    await sendBtn.waitFor({ state: "visible", timeout: waitMs });

    const buttonLabel = await readModelButtonLabel(page);
    const currentFromButton = normalizeModelLabel(buttonLabel);

    await clickOpenModelPicker(page);

    const rows = await collectMenuRows(page);
    const eligible = buildEligible(rows, blacklist);
    if (eligible.length === 0) {
      logger.warn("模型切换跳过：过滤 Auto/空/黑名单后无可用选项");
      return;
    }

    const dialog = page.locator('div[role="dialog"][aria-modal="true"]');
    const menuItems = dialog.locator('[role="menuitem"]');

    // 优先用 checkmark 在「原始 rows」中定位当前项，再映射到 eligible
    let currentInEligible = -1;
    for (let i = 0; i < rows.length; i++) {
      const hasCheck = (await menuItems.nth(rows[i]!.dialogIndex).locator(".checkmarkSmall").count()) > 0;
      if (hasCheck) {
        const idx = eligible.findIndex((e) => e.dialogIndex === rows[i]!.dialogIndex);
        if (idx >= 0) currentInEligible = idx;
        break;
      }
    }
    if (currentInEligible < 0) {
      currentInEligible = eligible.findIndex((e) => normalizeModelLabel(e.label) === currentFromButton);
      if (currentInEligible < 0) {
        logger.warn("当前模型未在候选列表中匹配，轮换起点取第一项");
        currentInEligible = 0;
      }
    }

    const nWant = specifiedName?.trim() ? normalizeModelLabel(specifiedName.trim()) : "";
    let target: MenuRow;

    if (nWant) {
      const hit = eligible.find((e) => normalizeModelLabel(e.label).includes(nWant));
      if (hit) {
        target = hit;
      } else {
        logger.warn(`指定模型未找到: ${specifiedName.trim()}，fallback 为候选中下一项`);
        const nextIndex = (currentInEligible + 1) % eligible.length;
        target = eligible[nextIndex]!;
      }
    } else {
      const nextIndex = (currentInEligible + 1) % eligible.length;
      target = eligible[nextIndex]!;
    }

    await menuItems.nth(target.dialogIndex).click();
    await sleep(POST_CLICK_WAIT_MS);
    logger.info(`模型已切换为: ${target.label}`);
  } catch (e) {
    logger.warn("模型切换失败，跳过本次切换，继续运行", e);
  }
}

/** 轮换到下一可用模型（无指定名称） */
export async function switchToNextModel(
  page: Page,
  timeoutMs: number | undefined,
  options: ModelSwitchOptions,
): Promise<void> {
  await switchModel(page, undefined, options, timeoutMs);
}
