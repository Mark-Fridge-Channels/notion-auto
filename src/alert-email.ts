/**
 * 告警邮件：从 env 读 SMTP 配置，连续自动重启超过 5 次时发一封；失败只打日志。
 */

import { createTransport } from "nodemailer";
import { logger } from "./logger.js";

const ENV = {
  host: process.env.NOTION_SMTP_HOST,
  port: process.env.NOTION_SMTP_PORT,
  user: process.env.NOTION_SMTP_USER,
  pass: process.env.NOTION_SMTP_PASS,
  to: process.env.NOTION_ALERT_TO,
};

/**
 * 发送「notion-auto 连续自动重启超过 5 次」告警；env 未配齐则跳过并打日志，失败只打日志。
 */
export async function sendRestartAlertEmail(): Promise<void> {
  if (!ENV.host || !ENV.to) {
    logger.warn("未配置 NOTION_SMTP_HOST 或 NOTION_ALERT_TO，跳过告警邮件");
    return;
  }
  const port = ENV.port ? parseInt(ENV.port, 10) : 465;
  try {
    const transport = createTransport({
      host: ENV.host,
      port: Number.isFinite(port) ? port : 465,
      secure: port === 465,
      auth: ENV.user && ENV.pass ? { user: ENV.user, pass: ENV.pass } : undefined,
    });
    await transport.sendMail({
      from: ENV.user ?? "notion-auto@local",
      to: ENV.to,
      subject: "[notion-auto] 连续自动重启超过 5 次告警",
      text: "notion-auto Dashboard 因脚本异常退出已连续自动重启超过 5 次，请检查运行环境与日志。",
    });
    logger.info("告警邮件已发送");
  } catch (e) {
    logger.warn("告警邮件发送失败", e);
  }
}
