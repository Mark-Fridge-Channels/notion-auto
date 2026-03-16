/**
 * Mail Automation Agent（minimal-server）HTTP 客户端。
 * Warmup Executor 通过 POST /command 调用 Thunderbird 扩展的邮件自动化能力；
 * base URL 与超时由环境变量配置。
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:3939";
const DEFAULT_TIMEOUT_MS = 130_000;

/** 从环境变量读取 base URL，缺省为 http://127.0.0.1:3939 */
export function getMailAutomationAgentBaseUrl(): string {
  const v = process.env.MAIL_AUTOMATION_AGENT_BASE_URL?.trim();
  return v || DEFAULT_BASE_URL;
}

/** 从环境变量读取请求超时（毫秒），缺省 130000 */
export function getMailAutomationAgentTimeoutMs(): number {
  const v = process.env.MAIL_AUTOMATION_AGENT_TIMEOUT_MS?.trim();
  if (!v) return DEFAULT_TIMEOUT_MS;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

/** 扩展返回的错误结构 */
export interface CommandError {
  code: string;
  message: string;
  details?: unknown;
}

/** /command 响应体：成功带 result，失败带 error */
export interface CommandResponse<T = unknown> {
  request_id: string;
  success: boolean;
  result?: T;
  error?: CommandError;
}

export interface CommandOptions {
  requestId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
}

/**
 * 向 minimal-server 发送一条 command。
 * 超时或 HTTP 非 2xx 时抛出 Error；200 且 success:false 时也抛出，message 含 error.code 与 error.message。
 */
export async function command<T = unknown>(
  action: string,
  payload: Record<string, unknown>,
  options?: CommandOptions,
): Promise<CommandResponse<T>> {
  const baseUrl = getMailAutomationAgentBaseUrl();
  const timeoutMs = options?.timeoutMs ?? getMailAutomationAgentTimeoutMs();
  const requestId = options?.requestId ?? `cmd-${action}-${Date.now()}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const body: Record<string, unknown> = {
      request_id: requestId,
      action,
      payload,
    };
    if (options?.idempotencyKey) {
      body.idempotency_key = options.idempotencyKey;
    }

    const res = await fetch(`${baseUrl}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    let data: CommandResponse<T>;
    try {
      data = (await res.json()) as CommandResponse<T>;
    } catch {
      throw new Error(`Mail Automation Agent 响应非 JSON: ${res.status}`);
    }

    if (!res.ok) {
      const msg = data.error?.message ?? res.statusText;
      const code = data.error?.code ?? (res.status === 504 ? "TIMEOUT" : "API_ERROR");
      throw new Error(`Mail Automation Agent ${code}: ${msg}`);
    }

    if (!data.success && data.error) {
      throw new Error(`Mail Automation Agent ${data.error.code}: ${data.error.message}`);
    }

    return data;
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error) {
      if (e.name === "AbortError") {
        throw new Error(
          "Mail Automation Agent 请求超时，请确认 minimal-server 与 Thunderbird 扩展已就绪",
        );
      }
      throw e;
    }
    throw e;
  }
}

/**
 * 健康检查：发送一次轻量 command，确认 minimal-server 可达。
 * 连接被拒绝或超时则 throw；收到 HTTP 200（无论 success  true/false）视为服务可达。
 */
export async function healthCheck(): Promise<void> {
  const baseUrl = getMailAutomationAgentBaseUrl();
  const timeoutMs = 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request_id: "health-check",
        action: "switch_account_context",
        payload: {},
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) return;
    const text = await res.text();
    throw new Error(`Mail Automation Agent 不可用: HTTP ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    clearTimeout(timeout);
    if (e instanceof Error) {
      if (e.name === "AbortError") {
        throw new Error(
          "Mail Automation Agent 健康检查超时，请确认 minimal-server 已启动且 Thunderbird 扩展已加载",
        );
      }
      throw e;
    }
    throw e;
  }
}
