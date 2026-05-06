/**
 * Notion AI 自动化主流程（时间区间 + 行业任务链模式）：
 * 按当前时间落入的时间区间选择行业 → 打开该行业 Notion Portal URL → 按任务链顺序执行（行业级每 N 次新会话、每 M 次换模型），
 * 任务链跑完立刻循环；跨区间时切换行业。7×24 运行直到用户停止。
 *
 * 单轮失败不退出：重试 → New AI chat 再试 → 刷新+重开再试，仍失败则 EXIT_RECOVERY_RESTART 由 Dashboard 重启。
 */

import { chromium } from "playwright";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { BrowserContext } from "playwright";
import {
  loadSchedule,
  getSchedulePath,
  getIndustryForNow,
  waitUntilInSlot,
} from "./schedule.js";
import {
  AI_FACE_IMG,
  ASSISTANT_CORNER_CLOSE_CHECK_MS,
  ASSISTANT_CORNER_ORIGIN_CONTAINER,
  AI_INPUT,
  SEND_BUTTON,
  STOP_INFERENCE_BUTTON,
  NEW_CHAT_BUTTON,
  MODAL_WAIT_MS,
  PERSONALIZE_DIALOG,
  PERSONALIZE_DIALOG_CHECK_MS,
  SURVEY_LISTBOX,
  SURVEY_OTHER_INPUT,
  SURVEY_CHECK_MS,
} from "./selectors.js";
import { readModelButtonLabel, switchModel } from "./model-picker.js";
import type { ModelSwitchOptions } from "./model-picker.js";
import { logger } from "./logger.js";
import { saveProgress } from "./progress.js";
import { EXIT_RECOVERY_RESTART } from "./exit-codes.js";
import {
  fetchOneQueuedTask,
  markTaskDone,
  markTaskFailed,
  isQueueAvailable,
} from "./notion-queue.js";
import type { ScheduleIndustry, Schedule } from "./schedule.js";
import type { Browser, Page } from "playwright";
import { extractConversationPlainText } from "./conversation-extract.js";
import {
  appendRunLogEntry,
  isRunLogEnabled,
  type RunLogSendCapture,
} from "./notion-run-log.js";
import {
  deriveAccountIdFromConfigPath,
  takeAssignedAdhocJob,
  hasPendingAssignedAdhoc,
  claimAdhocJobForOneShot,
  markAdhocJobDone,
  markAdhocJobFailed,
} from "./adhoc-queue.js";
import { generateTaskContent } from "./task-content-generator.js";

/** 当前已启动的浏览器实例，供退出前关闭及 SIGTERM 处理使用；launch 后赋值，close 后置空 */
let currentBrowser: Browser | null = null;
/** 当前活动页面引用，供停机前「最佳努力点击停止生成」使用。 */
let currentPage: Page | null = null;
/** 停机流程防重入：避免并发关闭导致“先关后判定 stop”的时序错乱。 */
let shutdownInProgress = false;
/**
 * 主任务循环是否已进入：在 for(;;) 前置为 true。
 * 启动失败捕获逻辑据此判断：false = 仍在准备/登录阶段（需保存 serviceFailed 截图）。
 */
let taskExecutionStarted = false;

const BROWSER_CLOSE_TIMEOUT_MS = 10_000;

/**
 * 降内存 Chromium 启动参数：
 *  - `--disable-dev-shm-usage`：EC2/容器上 /dev/shm 通常很小，退回内存映射会诱发额外 RSS；
 *  - `--disable-gpu` / `--disable-software-rasterizer`：headless 下完全用不到 GPU 栈；
 *  - `--disable-extensions`：禁用扩展减少 renderer 启动基线；
 *  - `--disable-features=…`：关掉几个默认开启但对本场景无用的特性，降低 renderer 常驻内存；
 *  - `--js-flags=--max-old-space-size=2048`：给 V8 老生代上限加盖，避免单个 renderer 的 JS 堆无限膨胀。
 * schedule.chromiumExtraArgs 可在此之后追加，用于极少数场景微调。
 */
const CHROMIUM_LOW_MEM_ARGS: readonly string[] = [
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--disable-extensions",
  "--disable-features=Translate,MediaRouter,OptimizationHints",
  "--js-flags=--max-old-space-size=2048",
];

/** 组合最终 launch args；extra 追加在内置之后，同键取后者的行为由 Chromium 自身处理 */
function buildChromiumArgs(extra?: string[]): string[] {
  if (!extra || extra.length === 0) return [...CHROMIUM_LOW_MEM_ARGS];
  return [...CHROMIUM_LOW_MEM_ARGS, ...extra];
}

/** 与 `newContext({ storageState })` 完全兼容的对象结构（Playwright 可变数组） */
type CookiesOnlyState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/**
 * cookies-only 读：Playwright 的 `storageState` 若保留 `origins[].localStorage`，
 * Notion 前端会在启动瞬间 rehydrate 大量 block / queryCache / block cache 到 JS 堆，
 * 导致每个 renderer 启动即 1~2GB。cookies 已足够维持 Notion 登录态，localStorage
 * 丢弃后 Notion 会按需重建（不会退登）。
 *
 * 读取落盘 JSON，仅返回 cookies 部分；文件不存在 / JSON 损坏时返回 undefined，
 * 由调用方按「无登录态」处理（走 60s 手动登录路径）。
 */
async function loadStorageStateCookiesOnly(path: string): Promise<CookiesOnlyState | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const raw = await readFile(path, "utf-8");
    const data = JSON.parse(raw) as { cookies?: unknown };
    const cookies = Array.isArray(data.cookies) ? (data.cookies as CookiesOnlyState["cookies"]) : [];
    return { cookies, origins: [] };
  } catch (e) {
    logger.warn(`读取登录态失败（将按无登录态启动）：${path}`, e);
    return undefined;
  }
}

/**
 * cookies-only 写：先从 context 取完整 state 再**裁掉** origins，
 * 确保文件不会在每次退出时被 Playwright 自动重新写胖。
 * 写入走 tmp + rename 原子替换，避免写到一半被进程信号打断留下半截 JSON。
 */
async function saveStorageStateCookiesOnly(
  context: BrowserContext,
  path: string,
): Promise<void> {
  const state = await context.storageState();
  const trimmed: CookiesOnlyState = { cookies: state.cookies ?? [], origins: [] };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(trimmed), "utf-8");
  await rename(tmp, path);
}

/** 等待 Notion AI 头像可见的超时（毫秒）；打开页面/切换行业/队列任务后等 AI 入口出现 */
const AI_FACE_VISIBLE_TIMEOUT_MS = 60_000;

/** Conductor 执行后固定等待时间（毫秒），等待Conductor生成新任务 */
const CONDUCTOR_POST_WAIT_MS = 5 * 60 * 1000;
/** 停机前尝试点击「停止生成」的最大预算（毫秒）；超时立即继续，不阻塞停机/重启。 */
const STOP_BEFORE_SHUTDOWN_BUDGET_MS = 1500;
/** 停机前点击 stop 成功后的软等待（毫秒）；给页面留出收敛时间，但不设硬门槛。 */
const STOP_AFTER_CLICK_SOFT_WAIT_MS = 2000;

type PreShutdownStopResult =
  | "clicked"
  | "non_generating"
  | "page_unavailable"
  | "not_found"
  | "button_disabled"
  | "error";

/**
 * 停机前最佳努力停止当前生成：若页面可用则尝试点 stop，但总预算受限，超时或异常都直接忽略。
 * 目的：人工停止/拉取重启时尽量优雅收尾，同时不阻塞关浏览器。
 */
async function bestEffortStopBeforeShutdown(): Promise<PreShutdownStopResult> {
  const page = currentPage;
  if (!page) {
    logger.info("停机前页面不可用/已关闭，无法点击 stop，继续停机");
    return "page_unavailable";
  }
  if (page.isClosed()) {
    logger.info("停机前页面不可用/已关闭，无法点击 stop，继续停机");
    return "page_unavailable";
  }
  const stop = page.locator(STOP_INFERENCE_BUTTON).first();
  const send = page.locator(SEND_BUTTON).first();
  const deadline = Date.now() + STOP_BEFORE_SHUTDOWN_BUDGET_MS;
  logger.info(`停机前尝试点击停止生成按钮（预算 ${STOP_BEFORE_SHUTDOWN_BUDGET_MS}ms）`);
  try {
    // 停机路径在预算内做短轮询，减少“瞬时不可见”导致漏点 stop。
    while (true) {
      if (page.isClosed() || currentBrowser == null) {
        logger.info("停机前页面不可用/已关闭，无法点击 stop，继续停机");
        return "page_unavailable";
      }
      const stopVisible = await stop.isVisible().catch(() => false);
      if (stopVisible) break;
      // 已回到 Send，说明并非生成态，无需继续等 stop。
      if (await send.isVisible().catch(() => false)) {
        logger.info("停机前 send 可见，无需点击 stop（非生成态）");
        return "non_generating";
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        logger.info("停机前未检测到停止生成按钮，继续停机");
        return "not_found";
      }
      await sleep(Math.min(120, left));
    }
    if ((await stop.getAttribute("aria-disabled").catch(() => null)) === "true") {
      logger.info("停机前 stop 按钮不可用（aria-disabled），继续停机");
      return "button_disabled";
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      logger.info("停机前预算耗尽，继续停机");
      return "not_found";
    }
    await stop.click({ timeout: Math.min(300, left) });
    logger.info("停机前已点击 stop，继续停机");
    return "clicked";
  } catch (e) {
    // 停机前清理失败不应影响退出流程
    logger.warn("停机前点击停止生成按钮失败（忽略并继续停机）", e);
    return "error";
  }
}

async function softWaitAfterPreShutdownStop(result: PreShutdownStopResult): Promise<void> {
  if (result !== "clicked") return;
  const deadline = Date.now() + STOP_AFTER_CLICK_SOFT_WAIT_MS;
  logger.info(`停机前 stop 点击后软等待 ${STOP_AFTER_CLICK_SOFT_WAIT_MS}ms（非硬门槛）`);
  while (Date.now() < deadline) {
    const page = currentPage;
    if (!page || page.isClosed() || currentBrowser == null) {
      return;
    }
    if (await page.locator(SEND_BUTTON).first().isVisible().catch(() => false)) {
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(120, left));
  }
}

/**
 * 浏览器 recycle 默认触发条件（schedule 未配置时使用）。
 * 从 100 调到 50：多账号并发 + swap 命中的机器上，单 renderer 越「胖」越容易拖慢 page.goto，
 * 较激进的回收能有效把每个 Chromium 的 RSS 压在一个合理区间。
 */
const BROWSER_RECYCLE_DEFAULT_RUNS = 50;
const BROWSER_RECYCLE_DEFAULT_HOURS = 6;

/** Step 4 使用：recycle 后返回的新 context/page，主循环据此替换本地引用 */
interface RecycledBrowser {
  context: BrowserContext;
  page: Page;
}

/**
 * 仅在任务边界调用：关闭当前 Chromium，按相同 launch args / storageState 重新起一份。
 * 目的：释放长时间运行累积的 renderer 堆碎片、已关闭的 page 残留、Blink 内部 cache。
 * 调度层计数（chainRunsInSlot / sessionRuns / currentN / currentM）**不在此函数内改动**，
 * 由调用方自行保留，确保 recycle 对任务链语义透明。
 */
async function relaunchBrowser(
  schedule: Schedule,
  industry: ScheduleIndustry,
  storagePath: string,
  headless: boolean,
): Promise<RecycledBrowser> {
  logger.info("定时 recycle 浏览器：开始关闭旧 Chromium…");
  if (currentBrowser) {
    try {
      await Promise.race([
        currentBrowser.close(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("browser.close 超时")), BROWSER_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      logger.warn("recycle 关闭旧浏览器失败（忽略，继续 relaunch）", e);
    }
    currentBrowser = null;
    currentPage = null;
  }
  currentBrowser = await chromium.launch({
    headless,
    args: buildChromiumArgs(schedule.chromiumExtraArgs),
  });
  const storageState = await loadStorageStateCookiesOnly(storagePath);
  const context = await currentBrowser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(30_000);
  if (industry.notionUrl?.trim()) {
    // 带宽/CPU 争用 + swap 场景下 30s 默认超时偏紧，放 90s 兜底。
    await page.goto(industry.notionUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  }
  // recycle 后 cookies 足以维持登录态；留一点点时间给 Notion SPA 初始化后再进入下一步操作。
  await sleep(1000);
  await openNotionAI(page, industry.notionUrl, schedule.maxRetries);
  await clickNewAIChat(page, schedule.maxRetries);
  logger.info("定时 recycle 浏览器：已重启并回到行业 Portal 的 New Chat");
  return { context, page };
}

/**
 * 关闭当前浏览器后退出进程；用于 process.exit 会跳过 finally 的路径（恢复重启、SIGTERM）。
 * 带超时避免 close 卡死导致进程无法退出。
 */
async function closeBrowserAndExit(code: number): Promise<never> {
  shutdownInProgress = true;
  const stopResult = await bestEffortStopBeforeShutdown();
  await softWaitAfterPreShutdownStop(stopResult);
  if (currentBrowser) {
    try {
      await Promise.race([
        currentBrowser.close(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("browser.close 超时")), BROWSER_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      logger.warn("关闭浏览器失败或超时", e);
    }
    currentBrowser = null;
    currentPage = null;
  }
  process.exit(code);
}

/** 关闭浏览器后退出，供 SIGTERM/SIGINT 共用；exitCode: 143=SIGTERM, 130=SIGINT */
function handleStopSignal(exitCode: number): void {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  void (async () => {
    const stopResult = await bestEffortStopBeforeShutdown();
    await softWaitAfterPreShutdownStop(stopResult);
    if (currentBrowser) {
      currentBrowser
        .close()
        .then(() => {
          currentBrowser = null;
          currentPage = null;
          process.exit(exitCode);
        })
        .catch((e) => {
          logger.warn("关闭浏览器失败", e);
          process.exit(exitCode);
        });
    } else {
      process.exit(exitCode);
    }
  })();
}

/** Dashboard 点击停止时发送 SIGTERM（Unix）或 SIGINT（Windows）；关闭浏览器后再退出 */
process.on("SIGTERM", () => handleStopSignal(143));
process.on("SIGINT", () => handleStopSignal(130));

/** Windows 上 Dashboard 通过 stdin 发 "stop" 让子进程先关浏览器再退出（方案 2） */
if (process.stdin && !process.stdin.isTTY && typeof process.stdin.on === "function") {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string | Buffer) => {
    const lines = String(data).split(/\r?\n/);
    for (const line of lines) {
      if (line.trim().toLowerCase() === "stop") {
        handleStopSignal(130);
        return;
      }
    }
  });
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

/**
 * 主循环间隔 sleep：可被「已分配给本账号的插队任务」提前结束，以便尽快回到循环顶消费队列。
 */
/** 睡眠切片（毫秒）；插队队列检查间隔更大以降低锁竞争 */
const INTERRUPTIBLE_SLEEP_SLICE_MS = 500;
const ADHOC_QUEUE_CHECK_INTERVAL_MS = 2500;

async function interruptibleSleep(totalMs: number, accountId: string | null): Promise<void> {
  let elapsed = 0;
  /** 置满间隔使进入循环后立刻检查一次，短于 CHECK 间隔的 sleep 也能发现插队 */
  let sinceQueueCheck = ADHOC_QUEUE_CHECK_INTERVAL_MS;
  while (elapsed < totalMs) {
    if (accountId && sinceQueueCheck >= ADHOC_QUEUE_CHECK_INTERVAL_MS) {
      sinceQueueCheck = 0;
      try {
        if (await hasPendingAssignedAdhoc(accountId)) return;
      } catch (e) {
        logger.warn("检查插队队列失败（忽略）", e);
      }
    }
    const step = Math.min(INTERRUPTIBLE_SLEEP_SLICE_MS, totalMs - elapsed);
    await sleep(step);
    elapsed += step;
    sinceQueueCheck += step;
  }
}

/**
 * 消费**一条**分配给当前账号的插队任务（running 子进程内）。
 * 为避免连续消费多条导致 renderer 内存飙升，每次主循环最多处理 1 条，下轮循环再进入。
 * 返回成功发送条数（0 或 1），供主循环累加到 recycle 计数。
 */
async function drainAdhocForRunningAccount(
  page: Page,
  schedule: Schedule,
  currentIndustry: ScheduleIndustry,
  accountId: string,
): Promise<number> {
  const modelSwitchOpts = { blacklist: schedule.modelBlacklist ?? [] };
  const job = await takeAssignedAdhocJob(accountId);
  if (!job) return 0;
  let sent = 0;
  logger.info(`插队任务 ${job.id}：执行中…`);
  try {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: job.timeoutGotoMs });
    await sleep(500);
    await waitForNotionAIEntryAndClick(page);
    await dismissPersonalizeDialogIfPresent(page);
    const model = job.model?.trim();
    if (model) {
      await switchModel(page, model, modelSwitchOpts, job.timeoutSendMs);
    }
    const llmModel = await readLlmModelLabel(page);
    const capture: RunLogSendCapture = { startedAtMs: null, notionUrlAtSend: null };
    const ok = await tryTypeAndSend(
      page,
      job.prompt,
      schedule.maxRetries,
      schedule.autoClickDuringOutputWait ?? [],
      job.timeoutSendMs,
      modelSwitchOpts,
      capture,
    );
    if (!ok) await clickStopInferenceIfVisible(page);
    await flushRunLogToNotion(
      page,
      capture,
      job.prompt,
      ok,
      llmModel,
      schedule.runLogScreenshotOnSuccess === true,
    );
    if (ok) {
      await markAdhocJobDone(job.id);
      sent = 1;
    } else {
      await markAdhocJobFailed(job.id, "tryTypeAndSend 失败");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`插队任务 ${job.id} 执行异常`, e);
    await markAdhocJobFailed(job.id, msg);
  }
  try {
    if (currentIndustry.notionUrl?.trim()) {
      await page.goto(currentIndustry.notionUrl, { waitUntil: "domcontentloaded" });
      await sleep(500);
      await waitForNotionAIEntryAndClick(page);
      await dismissPersonalizeDialogIfPresent(page);
      await clickNewAIChat(page, schedule.maxRetries);
    }
  } catch (e) {
    logger.warn("插队完成后恢复行业首页失败", e);
  }
  return sent;
}

/** Webhook 触发的「一次性」子进程：只执行一条插队任务后退出（不进入主循环）。 */
async function runAdhocSingleJobMode(params: {
  configPath: string;
  storagePath?: string;
  adhocJobId: string;
  adhocAccountId?: string;
}): Promise<void> {
  const schedule = await loadSchedule(params.configPath);
  if (params.storagePath != null) schedule.storagePath = params.storagePath;
  if (schedule.timeSlots.length === 0) {
    throw new Error("配置中时间区间列表为空，无法运行");
  }
  const accountId =
    (params.adhocAccountId && params.adhocAccountId.trim()) ||
    deriveAccountIdFromConfigPath(params.configPath) ||
    null;
  if (!accountId) {
    throw new Error("adhoc 需要账号 id：请使用 --adhoc-account-id 或 accounts/<id>/schedule.json");
  }
  const job = await claimAdhocJobForOneShot(params.adhocJobId, accountId);
  if (!job) {
    throw new Error("插队任务不存在、已执行或分配给其他账号");
  }
  const storagePath = schedule.storagePath;
  const finalHeadless = process.env.NOTION_AUTO_HEADLESS === "1" || (schedule.headless ?? false);
  taskExecutionStarted = false;
  currentBrowser = await chromium.launch({
    headless: finalHeadless,
    args: buildChromiumArgs(schedule.chromiumExtraArgs),
  });
  const storageState = await loadStorageStateCookiesOnly(storagePath);
  const context = await currentBrowser.newContext(storageState ? { storageState } : {});
  const page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(30_000);
  taskExecutionStarted = true;
  const modelSwitchOpts = { blacklist: schedule.modelBlacklist ?? [] };
  try {
    await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: job.timeoutGotoMs });
    await sleep(500);
    await waitForNotionAIEntryAndClick(page);
    await dismissPersonalizeDialogIfPresent(page);
    const model = job.model?.trim();
    if (model) {
      await switchModel(page, model, modelSwitchOpts, job.timeoutSendMs);
    }
    const llmModel = await readLlmModelLabel(page);
    const capture: RunLogSendCapture = { startedAtMs: null, notionUrlAtSend: null };
    const ok = await tryTypeAndSend(
      page,
      job.prompt,
      schedule.maxRetries,
      schedule.autoClickDuringOutputWait ?? [],
      job.timeoutSendMs,
      modelSwitchOpts,
      capture,
    );
    if (!ok) await clickStopInferenceIfVisible(page);
    await flushRunLogToNotion(
      page,
      capture,
      job.prompt,
      ok,
      llmModel,
      schedule.runLogScreenshotOnSuccess === true,
    );
    if (ok) await markAdhocJobDone(job.id);
    else await markAdhocJobFailed(job.id, "tryTypeAndSend 失败");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("adhoc 一次性任务失败", e);
    await markAdhocJobFailed(job.id, msg);
  } finally {
    try {
      await saveStorageStateCookiesOnly(context, storagePath);
    } catch (e) {
      logger.warn("保存登录态失败", e);
    }
    if (currentBrowser) {
      try {
        await currentBrowser.close();
      } catch (e) {
        logger.warn("关闭浏览器失败", e);
      }
      currentBrowser = null;
      currentPage = null;
    }
  }
}

/** 运行入口：解析 --config、--storage，加载 schedule、等待落入区间后启动浏览器并进入主循环 */
async function main(): Promise<void> {
  const { configPath, storagePath: overrideStorage, adhocJobId, adhocAccountId } = getConfigPathFromArgs();
  if (adhocJobId) {
    await runAdhocSingleJobMode({
      configPath,
      storagePath: overrideStorage,
      adhocJobId,
      adhocAccountId: adhocAccountId ?? process.env.NOTION_AUTO_ACCOUNT_ID?.trim(),
    });
    process.exit(0);
  }

  taskExecutionStarted = false;
  const mainStartTime = Date.now();
  const schedule = await loadSchedule(configPath);
  if (overrideStorage != null) schedule.storagePath = overrideStorage;

  if (schedule.timeSlots.length === 0) {
    throw new Error("配置中时间区间列表为空，无法运行");
  }

  // 等待直至当前时间落入某区间（不先开浏览器）
  logger.info("正在根据当前时间解析运行区间…");
  let currentIndustry = getIndustryForNow(schedule);
  if (currentIndustry == null) {
    logger.info("当前时间未落入任何配置区间，等待中…");
    currentIndustry = await waitUntilInSlot(schedule);
  }
  logger.info(`当前行业: ${currentIndustry.id}, URL: ${currentIndustry.notionUrl}`);

  const isGlobalHeadless = process.env.NOTION_AUTO_HEADLESS === "1";
  const finalHeadless = isGlobalHeadless || (schedule.headless ?? false);
  currentBrowser = await chromium.launch({
    headless: finalHeadless,
    args: buildChromiumArgs(schedule.chromiumExtraArgs),
  });
  const storagePath = schedule.storagePath;
  // cookies-only 读：避免 Notion 启动瞬间 rehydrate localStorage cache 把 renderer 撑到 1~2GB
  const storageState = await loadStorageStateCookiesOnly(storagePath);
  // Step 4 的 recycle 需要能够重新赋值 context/page，这里用 let。
  let context = await currentBrowser.newContext(storageState ? { storageState } : {});
  let page = await context.newPage();
  currentPage = page;
  page.setDefaultTimeout(30_000);

  if (!currentIndustry.notionUrl?.trim()) {
    throw new Error(`行业 "${currentIndustry.id}" 的 Notion Portal URL 未配置，请在 Dashboard 中填写`);
  }
  logger.info("正在打开 Notion…");
  // 6 个账号并发启动时，出口带宽 + renderer CPU 都有争用，30s 默认超时会偶发命中；放 90s 兜底。
  await page.goto(currentIndustry.notionUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  const hasSavedAuth = Boolean(storageState);

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
      await saveStorageStateCookiesOnly(context, storagePath);
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
    /** 发送后等待可发送状态的超时（毫秒），来自 schedule，默认 30 分钟；换模型前等待也使用此时长 */
    const waitSubmitReadyMs = schedule.waitSubmitReadyMs ?? 1_800_000;
    const modelSwitchOpts = { blacklist: schedule.modelBlacklist ?? [] };
    const accountIdForAdhoc = deriveAccountIdFromConfigPath(configPath);

    // ── 定时 recycle 浏览器（只在任务边界触发，不中断进行中任务）──────────────────
    /** 自上次 recycle（或启动）以来的成功发送数；任务链 / 队列 / adhoc 成功都计入 */
    let sendSinceRecycle = 0;
    /** 上次 recycle（或启动）的时间戳 */
    let recycleSince = Date.now();
    const recycleEveryRuns = schedule.browserRecycle?.everyRunsMax ?? BROWSER_RECYCLE_DEFAULT_RUNS;
    const recycleEveryMs =
      (schedule.browserRecycle?.everyHours ?? BROWSER_RECYCLE_DEFAULT_HOURS) * 3_600_000;

    /**
     * 在任务边界检查并 recycle；必须只在 3 处循环顶调用：
     * 主 for(;;)、Notion 队列内层 for(;;)、`for (task of tasks)`。
     * recycle 会重新赋值本地 `context` / `page`，并**不改动**调度层计数。
     */
    const maybeRecycle = async (): Promise<void> => {
      const runsTriggered = recycleEveryRuns > 0 && sendSinceRecycle >= recycleEveryRuns;
      const timeTriggered = recycleEveryMs > 0 && Date.now() - recycleSince >= recycleEveryMs;
      if (!runsTriggered && !timeTriggered) return;
      // 窗口空档：若当前未处在任何行业（已离开时段且未进入新时段），延迟 recycle 到下一次进入行业时再触发。
      if (!currentIndustry) return;
      logger.info(
        `触发浏览器 recycle：sendSinceRecycle=${sendSinceRecycle}, 距上次已 ${Math.round((Date.now() - recycleSince) / 60_000)} 分钟`,
      );
      const fresh = await relaunchBrowser(schedule, currentIndustry, storagePath, finalHeadless);
      context = fresh.context;
      page = fresh.page;
      sendSinceRecycle = 0;
      recycleSince = Date.now();
    };

    // 标记主任务循环即将进入；此后的失败属于运行时故障，不再触发 serviceFailed 截图
    taskExecutionStarted = true;

    for (;;) {
      // 任务边界 recycle 检查点①：主外层循环顶（不会中断任何进行中任务）
      await maybeRecycle();
      if (accountIdForAdhoc) {
        sendSinceRecycle += await drainAdhocForRunningAccount(
          page,
          schedule,
          currentIndustry,
          accountIdForAdhoc,
        );
      }
      // 每轮任务链开始前：检查是否跨时间区间需切换行业
      const industryNow = getIndustryForNow(schedule);
      if (industryNow == null) {
        logger.info("当前时间未落入任何区间，等待中…");
        await interruptibleSleep(60_000, accountIdForAdhoc);
        continue;
      }
      if (industryNow.id !== currentIndustry.id) {
        logger.info(`时间区间切换: ${currentIndustry.id} → ${industryNow.id}`);
        currentIndustry = industryNow;
        if (!currentIndustry.notionUrl?.trim()) {
          throw new Error(`行业 "${currentIndustry.id}" 的 Notion Portal URL 未配置，请在 Dashboard 中填写`);
        }
        runCount = 0;
        chainRunsInSlot = 0;
        leftCurrentSlot = false;
        await page.goto(currentIndustry.notionUrl, { waitUntil: "domcontentloaded" });
        await sleep(500);
        await waitForNotionAIEntryAndClick(page);
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

      // Notion 队列模式：到点只跑完当前任务即停，不再取新任务
      if (
        currentIndustry.taskSource === "notionQueue" &&
        isQueueAvailable(schedule.notionQueue)
      ) {
        const queueConfig = schedule.notionQueue!;
        /** 空队列起始时间戳（毫秒）；取到任务时清空，用于判断是否达到 Conductor 触发阈值 */
        let emptyQueueSince: number | null = null;
        for (;;) {
          // 任务边界 recycle 检查点②：Notion 队列内层循环顶
          await maybeRecycle();
          if (accountIdForAdhoc) {
            sendSinceRecycle += await drainAdhocForRunningAccount(
              page,
              schedule,
              currentIndustry,
              accountIdForAdhoc,
            );
          }
          const industryNow = getIndustryForNow(schedule);
          if (industryNow == null || industryNow.id !== currentIndustry.id) {
            logger.info("队列模式：已到点/已离开当前时段或行业已切换，停止拉取新任务");
            break;
          }
          const queueFetch = await fetchOneQueuedTask(queueConfig);
          const task = queueFetch.task;
          if (!queueFetch.listQueryOk) {
            logger.warn(
              `队列模式：未成功拿到任务列表 — ${queueFetch.errorMessage ?? "未知错误"}（请检查 NOTION_API_KEY、数据库 URL、列名及 Integration 权限）`,
            );
          } else {
            const moreHint = queueFetch.hasMoreQueued ? "；本页之后也未拉取，数据库可能还有更多匹配页" : "";
            if (task) {
              logger.info(
                `队列模式：任务列表拉取成功，Status「${queueConfig.statusQueued}」本批共 ${queueFetch.matchedCount} 条${moreHint}，已选取 1 条执行`,
              );
            } else {
              const explain =
                queueFetch.noTaskReason === "empty_queue"
                  ? `当前待执行 0 条（空队列）`
                  : queueFetch.noTaskReason === "no_valid_candidate"
                    ? `本批 ${queueFetch.matchedCount} 条均无有效 File URL，无法选取`
                    : queueFetch.noTaskReason === "missing_file_url"
                      ? `本批有 ${queueFetch.matchedCount} 条，但选中记录的 File URL 为空`
                      : "未选取到可执行任务";
              logger.info(`队列模式：任务列表拉取成功，${explain}${moreHint}`);
            }
          }
          if (!task) {
            const now = Date.now();
            if (emptyQueueSince == null) emptyQueueSince = now;
            const thresholdMs = (queueConfig.conductorEmptyQueueMinutes ?? 30) * 60 * 1000;
            const conductorUrl = queueConfig.conductorPageUrl?.trim();
            const conductorPrompt = queueConfig.conductorPrompt?.trim();
            if (conductorUrl && conductorPrompt && now - emptyQueueSince >= thresholdMs) {
              logger.info(`队列已空满 ${queueConfig.conductorEmptyQueueMinutes ?? 30} 分钟，执行 Conductor`);
              try {
                await page.goto(conductorUrl, { waitUntil: "domcontentloaded" });
                await sleep(500);
                await waitForNotionAIEntryAndClick(page);
                await dismissPersonalizeDialogIfPresent(page);
                if (currentM > 0 && sessionRuns > 0 && sessionRuns % currentM === 0) {
                  await switchModel(page, undefined, modelSwitchOpts, waitSubmitReadyMs);
                }
                const llmModel = await readLlmModelLabel(page);
                const conductorCapture: RunLogSendCapture = { startedAtMs: null, notionUrlAtSend: null };
                const ok = await tryTypeAndSend(
                  page,
                  conductorPrompt,
                  schedule.maxRetries,
                  schedule.autoClickDuringOutputWait ?? [],
                  waitSubmitReadyMs,
                  modelSwitchOpts,
                  conductorCapture,
                );
                if (ok) {
                  logger.info("Conductor 执行完成");
                  sessionRuns++;
                } else logger.warn("Conductor 发送失败");
                await flushRunLogToNotion(
                  page,
                  conductorCapture,
                  conductorPrompt,
                  ok,
                  llmModel,
                  schedule.runLogScreenshotOnSuccess === true,
                );
              } catch (e) {
                logger.warn("Conductor 执行失败", e);
              }
              emptyQueueSince = null;
              logger.info("等待 5 分钟后继续抓取队列…");
              await interruptibleSleep(CONDUCTOR_POST_WAIT_MS, accountIdForAdhoc);
              continue;
            }
            logger.info("队列暂无待执行任务，60 秒后重试…");
            await interruptibleSleep(60_000, accountIdForAdhoc);
            continue;
          }
          emptyQueueSince = null;
          logger.info(`队列任务: ${task.actionName.slice(0, 40)}… → ${task.fileUrl.slice(0, 50)}…`);
          try {
            await page.goto(task.fileUrl, { waitUntil: "domcontentloaded" });
            await sleep(500);
            await waitForNotionAIEntryAndClick(page);
            await dismissPersonalizeDialogIfPresent(page);
          } catch (e) {
            logger.warn("打开队列任务页面失败", e);
            try {
              await markTaskFailed(queueConfig, task.pageId);
            } catch (err) {
              logger.warn("标记任务失败状态时出错", err);
            }
            const intervalMs = randomIntInclusive(schedule.intervalMinMs, schedule.intervalMaxMs);
            await interruptibleSleep(intervalMs, accountIdForAdhoc);
            if (accountIdForAdhoc) {
              sendSinceRecycle += await drainAdhocForRunningAccount(
                page,
                schedule,
                currentIndustry,
                accountIdForAdhoc,
              );
            }
            continue;
          }
          const queueModel = task.model?.trim();
          if (queueModel) {
            await switchModel(page, queueModel, modelSwitchOpts, waitSubmitReadyMs);
          } else if (currentM > 0 && sessionRuns > 0 && sessionRuns % currentM === 0) {
            await switchModel(page, undefined, modelSwitchOpts, waitSubmitReadyMs);
          }
          const llmModel = await readLlmModelLabel(page);
          const prompt = "help me run @" + (task.actionName || "").trim();
          const queueCapture: RunLogSendCapture = { startedAtMs: null, notionUrlAtSend: null };
          const ok = await tryTypeAndSend(
            page,
            prompt,
            schedule.maxRetries,
            schedule.autoClickDuringOutputWait ?? [],
            waitSubmitReadyMs,
            modelSwitchOpts,
            queueCapture,
          );
          try {
            if (ok) {
              await markTaskDone(queueConfig, task.pageId);
              sessionRuns++;
              sendSinceRecycle++;
            } else {
              await clickStopInferenceIfVisible(page);
              await markTaskFailed(queueConfig, task.pageId);
            }
          } catch (err) {
            logger.warn("更新队列任务状态时出错", err);
          }
          await flushRunLogToNotion(
            page,
            queueCapture,
            prompt,
            ok,
            llmModel,
            schedule.runLogScreenshotOnSuccess === true,
          );
          const intervalMs = randomIntInclusive(schedule.intervalMinMs, schedule.intervalMaxMs);
          logger.info(`等待 ${intervalMs / 1000} 秒后取下一条…`);
          await interruptibleSleep(intervalMs, accountIdForAdhoc);
          if (accountIdForAdhoc) {
            sendSinceRecycle += await drainAdhocForRunningAccount(
              page,
              schedule,
              currentIndustry,
              accountIdForAdhoc,
            );
          }
          const afterNow = getIndustryForNow(schedule);
          if (afterNow == null || afterNow.id !== currentIndustry.id) {
            logger.info("队列模式：本任务完成后已离开当前时段，停止取新任务");
            break;
          }
        }
        continue;
      }

      // 执行一轮任务链
      for (const task of currentIndustry.tasks) {
        // 任务边界 recycle 检查点③：任务链内层循环顶
        await maybeRecycle();
        if (accountIdForAdhoc) {
          sendSinceRecycle += await drainAdhocForRunningAccount(
            page,
            schedule,
            currentIndustry,
            accountIdForAdhoc,
          );
        }
        for (let k = 0; k < task.runCount; k++) {
          // 任务链每次执行都实时生成新文案，避免重复使用配置中的固定 task.content。
          const generatedTaskContent = generateTaskContent();
          if (currentN > 0 && sessionRuns > 0 && sessionRuns % currentN === 0) {
            await clickNewAIChat(page, schedule.maxRetries);
            sessionRuns = 0;
            currentN = drawSessionN(currentIndustry);
            currentM = drawSessionM(currentIndustry);
          }
          const taskModel = task.model?.trim();
          if (taskModel) {
            await switchModel(page, taskModel, modelSwitchOpts, waitSubmitReadyMs);
          } else if (currentM > 0 && sessionRuns > 0 && sessionRuns % currentM === 0) {
            await switchModel(page, undefined, modelSwitchOpts, waitSubmitReadyMs);
          }

          let llmModel = await readLlmModelLabel(page);
          const chainCapture: RunLogSendCapture = { startedAtMs: null, notionUrlAtSend: null };
          let ok = await tryTypeAndSend(
            page,
            generatedTaskContent,
            schedule.maxRetries,
            schedule.autoClickDuringOutputWait ?? [],
            waitSubmitReadyMs,
            modelSwitchOpts,
            chainCapture,
          );
          if (!ok) {
            logger.warn("本轮流试失败，尝试 New AI chat 后重试…");
            try {
              await clickNewAIChat(page, schedule.maxRetries);
              llmModel = await readLlmModelLabel(page);
              ok = await tryTypeAndSend(
                page,
                generatedTaskContent,
                schedule.maxRetries,
                schedule.autoClickDuringOutputWait ?? [],
                waitSubmitReadyMs,
                modelSwitchOpts,
                chainCapture,
              );
            } catch (e) {
              logger.warn("New AI chat 失败", e);
            }
          }
          if (!ok) {
            for (let r = 0; r < MAX_REOPEN_PER_ROUND && !ok; r++) {
              logger.warn(`重新打开 Notion 并重试（${r + 1}/${MAX_REOPEN_PER_ROUND}）…`);
              try {
                await reopenNotionAndNewChat(page, currentIndustry.notionUrl, schedule.maxRetries);
                llmModel = await readLlmModelLabel(page);
                ok = await tryTypeAndSend(
                  page,
                  generatedTaskContent,
                  schedule.maxRetries,
                  schedule.autoClickDuringOutputWait ?? [],
                  waitSubmitReadyMs,
                  modelSwitchOpts,
                  chainCapture,
                );
              } catch (e) {
                logger.warn("reopenNotionAndNewChat 失败", e);
              }
            }
          }
          if (!ok) {
            logger.warn("本轮流试与恢复后仍失败，请求恢复重启");
            await flushRunLogToNotion(
              page,
              chainCapture,
              generatedTaskContent,
              false,
              llmModel,
              schedule.runLogScreenshotOnSuccess === true,
            );
            await saveProgress({ totalDone: 0, conversationRuns: 0, completed: false });
            await clickStopInferenceIfVisible(page);
            await closeBrowserAndExit(EXIT_RECOVERY_RESTART);
          }

          runCount++;
          sessionRuns++;
          sendSinceRecycle++;
          await saveProgress({ totalDone: runCount, conversationRuns: 0, completed: false });
          await flushRunLogToNotion(
            page,
            chainCapture,
            generatedTaskContent,
            true,
            llmModel,
            schedule.runLogScreenshotOnSuccess === true,
          );
          logger.info(`行业 ${currentIndustry.id} 已执行 ${runCount} 次（任务 "${generatedTaskContent.slice(0, 30)}…"）`);

          const intervalMs = randomIntInclusive(schedule.intervalMinMs, schedule.intervalMaxMs);
          logger.info(`等待 ${intervalMs / 1000} 秒后继续...`);
          await interruptibleSleep(intervalMs, accountIdForAdhoc);
          if (accountIdForAdhoc) {
            sendSinceRecycle += await drainAdhocForRunningAccount(
              page,
              schedule,
              currentIndustry,
              accountIdForAdhoc,
            );
          }
        }
      }
      // 任务链完整跑完一轮后才计数；若本时段已跑满 chainRunsPerSlot 则等待离开当前时段
      chainRunsInSlot++;
      const limit = currentIndustry.chainRunsPerSlot ?? 0;
      if (limit > 0 && chainRunsInSlot >= limit) {
        logger.info(`本时段已跑满 ${chainRunsInSlot} 轮任务链（上限 ${limit}），等待离开当前时段…`);
        let waitMinutes = 0;
        for (;;) {
          await interruptibleSleep(60_000, accountIdForAdhoc);
          if (accountIdForAdhoc) {
            sendSinceRecycle += await drainAdhocForRunningAccount(
              page,
              schedule,
              currentIndustry,
              accountIdForAdhoc,
            );
          }
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
  } catch (startupErr) {
    // 仅在主任务循环尚未进入（即启动/登录阶段）时才保存 serviceFailed 截图
    if (!taskExecutionStarted && currentPage && !currentPage.isClosed()) {
      await captureServiceFailure(currentPage, mainStartTime);
    }
    throw startupErr;
  } finally {
    try {
      await saveStorageStateCookiesOnly(context, storagePath);
    } catch (e) {
      logger.warn("保存登录态失败", e);
    }
    if (currentBrowser) {
      try {
        await currentBrowser.close();
      } catch (e) {
        logger.warn("关闭浏览器失败", e);
      }
      currentBrowser = null;
    }
  }
}

/** 从 argv 解析 --config、--storage、--adhoc-job；--config 默认 getSchedulePath() */
function getConfigPathFromArgs(): {
  configPath: string;
  storagePath?: string;
  adhocJobId?: string;
  adhocAccountId?: string;
} {
  const args = process.argv.slice(2);
  let configPath = getSchedulePath();
  let storagePath: string | undefined;
  let adhocJobId: string | undefined;
  let adhocAccountId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1] != null) {
      configPath = args[++i];
    } else if (args[i] === "--storage" && args[i + 1] != null) {
      storagePath = args[++i];
    } else if (args[i] === "--adhoc-job" && args[i + 1] != null) {
      adhocJobId = args[++i];
    } else if (args[i] === "--adhoc-account-id" && args[i + 1] != null) {
      adhocAccountId = args[++i];
    } else if (args[i] === "--help" || args[i] === "-h") {
      printHelp();
      process.exit(0);
    }
  }
  if (!adhocJobId && process.env.NOTION_AUTO_ADHOC_JOB?.trim()) {
    adhocJobId = process.env.NOTION_AUTO_ADHOC_JOB.trim();
  }
  if (!adhocAccountId && process.env.NOTION_AUTO_ACCOUNT_ID?.trim()) {
    adhocAccountId = process.env.NOTION_AUTO_ACCOUNT_ID.trim();
  }
  return { configPath, storagePath, adhocJobId, adhocAccountId };
}

function printHelp(): void {
  process.stdout.write(`
notion-auto — 时间区间 + 行业任务链（7×24 运行）

用法: npm run run -- [--config <path>] [--storage <path>] [--adhoc-job <uuid>] [--adhoc-account-id <id>]
  --config <path>  配置文件路径（默认 schedule.json）
  --storage <path> 登录态保存路径（默认见 schedule 内 storagePath）
  --adhoc-job <id>  仅执行一条 Webhook 插队任务后退出（由 Dashboard 启动，勿与主循环同账号并发）
  --adhoc-account-id <id>  插队所属账号（也可用环境变量）

环境变量:
  NOTION_AUTO_RESUME=1  由 Dashboard 恢复重启时设置，从当前时间对应行业任务 1 开始
  NOTION_AUTO_ADHOC_JOB / NOTION_AUTO_ACCOUNT_ID  与 --adhoc-job / --adhoc-account-id 等价
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

/**
 * 新版 UI 在 AI 入口前可能在助手角先出现一层可关闭预览；仅在 `.notion-assistant-corner-origin-container` 内查找 Close，
 * 避免误点页面其它「Close」。
 */
async function dismissAssistantCornerCloseIfPresent(page: import("playwright").Page): Promise<void> {
  const closeInCorner = page
    .locator(ASSISTANT_CORNER_ORIGIN_CONTAINER)
    .first()
    .locator('div[role="button"][aria-label="Close"]')
    .first();
  try {
    await closeInCorner.waitFor({ state: "visible", timeout: ASSISTANT_CORNER_CLOSE_CHECK_MS });
  } catch {
    return;
  }
  try {
    await closeInCorner.click();
    await sleep(300);
  } catch (e) {
    logger.warn("点击助手角内 Close 失败", e);
  }
}

/** 等待助手角挂载、按需关闭预览层，再等待 AI 入口并点击（与既有逻辑一致：点入口的父级容器） */
async function waitForNotionAIEntryAndClick(page: import("playwright").Page): Promise<void> {
  const container = page.locator(ASSISTANT_CORNER_ORIGIN_CONTAINER).first();
  await container.waitFor({ state: "attached", timeout: AI_FACE_VISIBLE_TIMEOUT_MS });
  await dismissAssistantCornerCloseIfPresent(page);
  const entry = page.locator(AI_FACE_IMG).first();
  await entry.waitFor({ state: "visible", timeout: AI_FACE_VISIBLE_TIMEOUT_MS });
  const parent = entry.locator("xpath=..");
  await parent.click();
  await sleep(MODAL_WAIT_MS);
}

/** 比较两个 URL 是否指向「同一张 Notion 页」：只看 origin+pathname，忽略 query/hash。解析失败原样返回。 */
function samePageUrl(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin + ua.pathname === ub.origin + ub.pathname;
  } catch {
    return a === b;
  }
}

/**
 * 打开 Notion 并点击 AI 入口；使用指定 notionUrl。
 *
 * 关键细节（踩过坑）：
 * - 调用方（main / relaunchBrowser）在进入本函数前通常**已经**做过一次 `page.goto(notionUrl)`，
 *   本函数若无条件再 goto 一次，等于「同 URL 双导航」：第 2 次 goto 要 Chromium 把旧页 unload 再
 *   commit 新页，而 Notion SPA 首刷阶段 renderer 主线程还在忙（bundle 解析 + React bootstrap +
 *   workspace/user/block API），**多账号并发 + swap 偶有命中**时 30s timeout 很常见。
 * - 这里先比较 origin+pathname：**已在目标页则不再 goto**，直接走 waitForNotionAIEntryAndClick；
 *   页面真的跑偏再 goto，且把 timeout 放到 90s 兜底带宽 / CPU 争用。
 */
async function openNotionAI(
  page: import("playwright").Page,
  notionUrl: string,
  maxRetries: number,
): Promise<void> {
  await runWithRetry(maxRetries, async () => {
    if (!samePageUrl(page.url(), notionUrl)) {
      await page.goto(notionUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
    }
    await waitForNotionAIEntryAndClick(page);
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
 * 在总超时内轮询：发送按钮可见「且」停止按钮不可见时才判定完成；
 * 否则按配置顺序查「role=button、name 精确匹配」的按钮，可见则点击后继续轮询。
 * 不重置总超时；点击失败仅打日志。
 *
 * 仅凭「send 可见」判完成会误杀：Notion AI 在推理分段、工具调用、交互弹窗等过渡期会瞬间把按钮切回 send 状态，
 * 造成任务仍在生成但被判完成、随后被下一轮 typeAndSend / clickStopInferenceIfVisible 打断。
 * 增加「stop 不可见」硬条件，即可过滤掉 stop↔send 瞬态切换，避免误判。
 */
async function waitForSendButtonWithAutoClick(
  page: import("playwright").Page,
  buttonNames: string[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const sendBtn = page.locator(SEND_BUTTON).first();
    const stopBtn = page.locator(STOP_INFERENCE_BUTTON).first();
    const sendVisible = await sendBtn.isVisible().catch(() => false);
    const stopVisible = sendVisible
      ? await stopBtn.isVisible().catch(() => false)
      : true;
    if (sendVisible && !stopVisible) return;
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

/**
 * 检测并处理 Notion AI 弹出的「What do you want to do next?」调查选项：
 * 找到 Other 输入框 → 点击 → 输入 "Run Now" → 点击发送/Next 按钮。
 * 若调查不可见则立即返回 false；已处理返回 true。
 */
async function handleSurveyIfPresent(page: import("playwright").Page): Promise<boolean> {
  const listbox = page.locator(SURVEY_LISTBOX).first();
  try {
    await listbox.waitFor({ state: "visible", timeout: SURVEY_CHECK_MS });
  } catch {
    return false;
  }
  logger.info("检测到调查选项弹窗，自动选择 Other 并输入 Run Now");
  const otherInput = page.locator(SURVEY_OTHER_INPUT).first();
  try {
    await otherInput.waitFor({ state: "visible", timeout: 5_000 });
    await otherInput.click();
    await sleep(200);
    await page.keyboard.type("Run Now", { delay: 30 });
    await sleep(500);
    // 点击发送/Next 按钮（从 DOM 看，可能不带特殊 testid，而是叫 Send 或 Next 的按钮）
    const surveyBtn = page.getByRole("button", { name: /^(Send|Next)$/i }).last();
    if (await surveyBtn.isVisible().catch(() => false)) {
      await surveyBtn.click();
    } else {
      // 备用方案：按下回车提交
      await page.keyboard.press("Enter");
    }
    logger.info("调查已回答并发送");
    return true;
  } catch (e) {
    logger.warn("处理调查弹窗失败", e);
    return false;
  }
}

async function typeAndSend(
  page: import("playwright").Page,
  text: string,
  buttonNames: string[] = [],
  timeoutMs: number,
  sendCapture?: RunLogSendCapture,
): Promise<void> {
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
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 30 });
  // Notion AI 输入框对候选/文件选择有内部机制：先按一次 Enter 触发选中，再点击发送。
  await sleep(1000);
  await page.keyboard.press("Enter");
  await sleep(50);
  const send = page.locator(SEND_BUTTON).first();
  const stop = page.locator(STOP_INFERENCE_BUTTON).first();
  // Enter 后：Stop 可见表示已提交并在生成；Send 可见表示仍需点击发送（与 page 默认超时一致）
  // 同时检测是否弹出「What do you want to do next?」调查，出现则自动处理后继续轮询。
  const enterUiDeadline = Date.now() + 30_000;
  let submitUi: "stop" | "send" | null = null;
  let surveyHandled = false;
  while (Date.now() < enterUiDeadline) {
    if (await stop.isVisible().catch(() => false)) {
      submitUi = "stop";
      break;
    }
    if (await send.isVisible().catch(() => false)) {
      submitUi = "send";
      break;
    }
    // 检测调查弹窗（每轮都检测，防止发送后才弹出）
    if (!surveyHandled) {
      const surveySeen = await page.locator(SURVEY_LISTBOX).isVisible().catch(() => false);
      if (surveySeen) {
        surveyHandled = await handleSurveyIfPresent(page);
        // 处理后继续轮询 stop/send（下一轮内容会正常生成）
        await sleep(500);
        continue;
      }
    }
    await sleep(50);
  }
  if (submitUi === null) {
    if (await stop.isVisible().catch(() => false)) submitUi = "stop";
    else if (await send.isVisible().catch(() => false)) submitUi = "send";
    else throw new Error("Enter 后在超时内未出现发送或停止按钮");
  }
  if (submitUi === "send") {
    if ((await send.getAttribute("aria-disabled").catch(() => null)) === "true") {
      const errText = await findUnavailableErrorText(page);
      throw new SendButtonUnavailableError(errText ?? "发送按钮可见但不可用（aria-disabled=true）");
    }
    await send.click();
  }
  if (sendCapture && sendCapture.startedAtMs === null) {
    sendCapture.startedAtMs = Date.now();
    sendCapture.notionUrlAtSend = page.url();
  }
  // 发送已确认（send 按钮点击 或 stop 可见），记录任务开始执行
  const shortText = text.length > 80 ? text.slice(0, 80) + "…" : text;
  logger.info(`[任务执行中] 消息已发送，等待 AI 生成结果… 输入: "${shortText}"`);
  try {
    await waitForSendButtonWithAutoClick(page, buttonNames, timeoutMs);
  } catch (e) {
    throw new WaitAfterSendTimeoutError(e);
  }
  if (buttonNames.length > 0) {
    await sweepAutoClickButtons(page, buttonNames);
  }
}

/**
 * 若 AI 面板主按钮为「停止生成」，则点击以结束当前输出（与发送按钮同属主操作区，需先停再新对话/刷新/重试）。
 * 不可见或点击失败时静默或打日志后继续，由调用方决定后续恢复逻辑。
 */
async function clickStopInferenceIfVisible(page: Page): Promise<void> {
  const stop = page.locator(STOP_INFERENCE_BUTTON).first();
  try {
    await stop.waitFor({ state: "visible", timeout: 2_000 });
  } catch {
    return;
  }
  if ((await stop.getAttribute("aria-disabled").catch(() => null)) === "true") {
    logger.warn("停止生成按钮可见但不可用（aria-disabled），跳过点击");
    return;
  }
  try {
    await stop.click();
    await sleep(400);
  } catch (e) {
    logger.warn("点击停止生成按钮失败（将继续后续流程）", e);
  }
}

async function clickNewAIChat(page: import("playwright").Page, maxRetries: number): Promise<void> {
  await clickStopInferenceIfVisible(page);
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
  await clickStopInferenceIfVisible(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(500);
  await waitForNotionAIEntryAndClick(page);
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

class SendButtonUnavailableError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "SendButtonUnavailableError";
  }
}

async function findUnavailableErrorText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const icon = document.querySelector("svg.exclamationMarkTriangleFill");
    if (!icon) return null;
    let box: Element | null = icon;
    for (let i = 0; i < 8 && box; i++) {
      box = box.parentElement;
      if (!box) break;
      const textDiv = Array.from(box.querySelectorAll("div")).find((el) =>
        (el as HTMLElement).innerText?.toLowerCase().includes("temporarily unavailable"),
      );
      if (textDiv) return (textDiv as HTMLElement).innerText.trim();
    }
    return null;
  });
}

/**
 * 任务判定结束后：展开 Thought、抽取对话，将元数据与正文写入任务日志库（需 NOTION_API_KEY + NOTION_RUN_LOG_DATABASE_URL）。
 */
async function flushRunLogToNotion(
  page: Page,
  capture: RunLogSendCapture,
  input: string,
  success: boolean,
  llmModel: string,
  screenshotOnSuccess: boolean,
): Promise<void> {
  if (!isRunLogEnabled()) return;
  let extractedBody = "";
  let failureScreenshotPath: string | undefined;
  try {
    extractedBody = await extractConversationPlainText(page);
  } catch (e) {
    logger.warn("运行日志：抽取对话正文失败", e);
  }
  if (!success || screenshotOnSuccess) {
    failureScreenshotPath = await captureFailureScreenshot(page);
  }
  const finishedAtMs = Date.now();
  try {
    await appendRunLogEntry({
      startedAtMs: capture.startedAtMs,
      finishedAtMs,
      input,
      notionUrlAtSend: capture.notionUrlAtSend,
      success,
      extractedBody,
      llmModel,
      failureScreenshotPath,
    });
  } catch (e) {
    logger.warn("运行日志：写入 Notion 失败", e);
  } finally {
    if (failureScreenshotPath) {
      try {
        await unlink(failureScreenshotPath);
      } catch {
        // 忽略临时文件清理失败，避免影响主流程
      }
    }
  }
}

async function captureFailureScreenshot(page: Page): Promise<string | undefined> {
  try {
    const dir = join(tmpdir(), "notion-auto-fail-shots");
    await mkdir(dir, { recursive: true });
    const path = join(dir, `failed-${Date.now()}.png`);
    await page.screenshot({ path, fullPage: true });
    return path;
  } catch (e) {
    logger.warn("运行日志：失败截图保存失败", e);
    return undefined;
  }
}

/**
 * 服务启动失败时截图 + 保存页面全部 document HTML，存入项目根目录 serviceFailed/ 子目录。
 * 文件名格式：{账号}_{YYYY-MM-DD_HH-mm-ss}，截图 .png 与页面 .html 共用同一基名。
 * 账号来自环境变量 NOTION_AUTO_EXECUTOR（由 dashboard-runner 启动子进程时注入）。
 */
async function captureServiceFailure(page: Page, startTimeMs: number): Promise<void> {
  try {
    const dir = join(process.cwd(), "serviceFailed");
    await mkdir(dir, { recursive: true });

    const accountLabel = (process.env.NOTION_AUTO_EXECUTOR ?? "unknown").replace(/[/\\:*?"<>|]/g, "_");
    const date = new Date(startTimeMs);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const timeStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
    const basename = `${accountLabel}_${timeStr}`;

    const screenshotPath = join(dir, `${basename}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    logger.info(`服务启动失败截图已保存: ${screenshotPath}`);

    const htmlPath = join(dir, `${basename}.html`);
    const html = await page.content();
    await writeFile(htmlPath, html, "utf-8");
    logger.info(`服务启动失败页面 HTML 已保存: ${htmlPath}`);
  } catch (e) {
    logger.warn("保存服务启动失败截图/HTML 时出错", e);
  }
}

/** 发送前读取模型按钮展示名，失败时返回空串 */
async function readLlmModelLabel(page: Page): Promise<string> {
  try {
    return (await readModelButtonLabel(page)).trim();
  } catch {
    return "";
  }
}

async function tryTypeAndSend(
  page: import("playwright").Page,
  prompt: string,
  max: number,
  buttonNames: string[],
  timeoutMs: number,
  modelSwitchOpts: ModelSwitchOptions,
  sendCapture?: RunLogSendCapture | null,
): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    try {
      await typeAndSend(page, prompt, buttonNames, timeoutMs, sendCapture ?? undefined);
      return true;
    } catch (e) {
      if (e instanceof SendButtonUnavailableError) {
        logger.warn(`发送按钮不可用，准备切换下一个可用模型并重试：${e.detail}`);
        await switchModel(page, undefined, modelSwitchOpts, timeoutMs);
        continue;
      }
      if (e instanceof WaitAfterSendTimeoutError) {
        logger.warn("发送后等待超时，尝试停止当前生成并判定本次失败");
        await clickStopInferenceIfVisible(page);
        return false;
      }
      if (i < max - 1) {
        await clickStopInferenceIfVisible(page);
        logger.warn(`输入+发送 重试 ${i + 1}/${max}…`, e);
      }
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
