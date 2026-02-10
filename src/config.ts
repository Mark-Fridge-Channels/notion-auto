/**
 * 运行配置：总轮数、间隔、登录等待、模型切换间隔、起始 URL、每 N 轮新建对话、三条 Task 文案等
 */

import { TASK_1, TASK_2, TASK_3 } from "./prompts.js";
import { NOTION_URL } from "./selectors.js";

export interface Config {
  /** 总执行轮数（所有对话的 输入+发送 次数总和），跑满后退出 */
  totalRuns: number;
  /** 每轮间隔（毫秒），默认 2 分钟 */
  intervalMs: number;
  /** 每次运行时的登录等待时间（毫秒），默认 1 分钟 */
  loginWaitMs: number;
  /** 脚本打开后访问的地址 */
  notionUrl: string;
  /** 每 N 轮点击 New AI chat 新建对话，最小 1，默认 10 */
  newChatEveryRuns: number;
  /** 每 N 轮切换一次模型，0 表示不切换，默认 50 */
  modelSwitchInterval: number;
  /** 第 1～5 轮使用的文案（Task 1） */
  promptTask1: string;
  /** 第 6～10 轮使用的文案（Task 2） */
  promptTask2: string;
  /** 第 11 轮起随机使用的文案之一（Task 3） */
  promptTask3: string;
  /** 若设置，则每轮均使用此文案（Prompt 网关），忽略 promptTask1/2/3 与轮数规则；null 表示未使用 */
  promptGateway: string | null;
  /** 登录态保存路径，存在则加载、运行结束可保存 */
  storagePath: string;
  /** 单步失败时最大重试次数 */
  maxRetries: number;
}

const DEFAULT_CONFIG: Config = {
  totalRuns: 25,
  intervalMs: 2 * 60 * 1000,
  loginWaitMs: 60 * 1000,
  notionUrl: NOTION_URL,
  newChatEveryRuns: 10,
  modelSwitchInterval: 50,
  promptTask1: TASK_1,
  promptTask2: TASK_2,
  promptTask3: TASK_3,
  promptGateway: null,
  storagePath: ".notion-auth.json",
  maxRetries: 3,
};

/** 解析命令行参数，覆盖默认配置 */
export function parseArgs(): Config {
  const config = { ...DEFAULT_CONFIG };
  const args = process.argv.slice(2);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => {
      const val = args[++i];
      if (val === undefined || val.startsWith("-"))
        throw new Error(`选项 ${arg} 缺少参数值`);
      return val;
    };
    const nextNum = (min: number, msg: string) => {
      const val = next();
      const v = parseInt(val, 10);
      if (!Number.isFinite(v) || v < min) throw new Error(msg);
      return v;
    };
    if (arg === "--total" || arg === "-n") {
      config.totalRuns = nextNum(1, "--total 必须为正整数");
    } else if (arg === "--interval") {
      config.intervalMs = nextNum(1, "--interval 必须为正整数（秒）") * 1000;
    } else if (arg === "--login-wait") {
      config.loginWaitMs = nextNum(0, "--login-wait 必须为非负整数（秒）") * 1000;
    } else if (arg === "--notion-url") {
      config.notionUrl = next();
    } else if (arg === "--new-chat-every") {
      config.newChatEveryRuns = nextNum(1, "--new-chat-every 必须为正整数（最小 1）");
    } else if (arg === "--model-switch-interval") {
      const v = nextNum(0, "--model-switch-interval 必须为非负整数（0=不切换）");
      config.modelSwitchInterval = v;
    } else if (arg === "--task1") {
      config.promptTask1 = next();
    } else if (arg === "--task2") {
      config.promptTask2 = next();
    } else if (arg === "--task3") {
      config.promptTask3 = next();
    } else if (arg === "--prompt-gateway") {
      const val = next();
      if (val.trim() === "")
        throw new Error("--prompt-gateway 为必填项，不能为空");
      config.promptGateway = val;
    } else if (arg === "--storage") {
      const path = args[++i] ?? config.storagePath;
      if (path.includes("..") || path.startsWith("/"))
        throw new Error("--storage 仅支持当前目录下的相对路径");
      config.storagePath = path;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return config;
}

/** 帮助信息输出到 stdout，供管道/重定向使用 */
function printHelp(): void {
  process.stdout.write(`
notion-auto — Notion AI 定时输入与发送

用法: npm run run -- [选项]
      （通过 npm 传参时，必须在 run 后加 -- 再写选项，否则参数不会传给脚本）

选项:
  --total, -n <number>    总轮数（默认 25）
  --interval <seconds>   每轮间隔秒数（默认 120）
  --login-wait <seconds> 登录等待秒数（默认 60）
  --notion-url <url>     脚本打开后访问的地址（默认见 selectors）
  --new-chat-every <n>   每 n 轮点击 New AI chat 新建对话，最小 1（默认 10）
  --model-switch-interval <n>  每 n 轮切换一次模型，0=不切换（默认 50）
  --task1 <text>         第 1～5 轮文案（默认 "@Task 1 — Add new DTC companies"）
  --task2 <text>         第 6～10 轮文案（默认 "@Task 2 — Find high-priority contacts"）
  --task3 <text>         第 11 轮起随机文案之一（默认 "@Task 3 — Find people contact ..."）
  --prompt-gateway <text> 使用 Prompt 网关内容，每轮均使用该文案，忽略 --task1/2/3（必填，不能为空）
  --storage <path>       登录态保存路径（默认 .notion-auth.json，仅支持当前目录下相对路径）
  --help, -h             显示此帮助
`);
}
