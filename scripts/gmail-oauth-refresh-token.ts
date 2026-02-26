/**
 * Gmail OAuth2 授权页：本地起 HTTP 服务，用户点击「用 Google 登录授权」完成授权后，
 * 页面展示 refresh_token 供复制到发件人库的 password 列。
 *
 * 使用方式：
 *   1. 在 Google Cloud 创建「Web 应用」类型 OAuth 客户端（桌面应用无法添加重定向 URI，会报「此应用的请求无效」），
 *      在「已授权的重定向 URI」中添加 http://127.0.0.1:9010/callback
 *   2. 配置 .env：GMAIL_CLIENT_ID、GMAIL_CLIENT_SECRET（使用该 Web 应用客户端的 ID/密钥）
 *   3. 运行：npx tsx scripts/gmail-oauth-refresh-token.ts
 *   4. 浏览器打开 http://127.0.0.1:9010，点击授权，授权完成后在页面复制 refresh_token
 *
 * 服务固定端口 9010，保持运行以便多次授权不同账号。
 */

import "dotenv/config";
import { createServer } from "node:http";
import { google } from "googleapis";

const PORT = 9010;
const HOST = "127.0.0.1";
const REDIRECT_URI = `http://${HOST}:${PORT}/callback`;
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

function getOAuth2Client(): ReturnType<typeof google.auth.OAuth2.prototype.constructor> {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!clientId || !clientSecret)
    throw new Error("请配置 .env 中的 GMAIL_CLIENT_ID 和 GMAIL_CLIENT_SECRET");
  return new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
}

/** 首页：展示「用 Google 账号登录授权」链接 */
function pageIndex(authUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>Gmail 授权</title></head>
<body>
  <h1>Gmail 授权获取 refresh_token</h1>
  <p>点击下方链接，使用 Google 账号登录并授权后，将跳回本页并显示 refresh_token。</p>
  <p><a href="${authUrl}">用 Google 账号登录授权</a></p>
  <p style="color:#666;font-size:14px;">可将得到的 refresh_token 复制到 Notion 发件人库对应行的 password 列。服务保持运行，可多次授权不同账号。</p>
  <p style="color:#b00;font-size:13px;">若点击授权后出现「此应用的请求无效」：请使用「Web 应用」类型 OAuth 客户端，并在控制台添加重定向 URI：<code>http://127.0.0.1:9010/callback</code>（桌面应用类型无法添加）。</p>
</body>
</html>`;
}

/** 成功页：展示 refresh_token，提示手动选中复制 */
function pageSuccess(refreshToken: string): string {
  const escaped = refreshToken
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>refresh_token</title></head>
<body>
  <h1>已获取 refresh_token</h1>
  <p>请手动选中下方文本并复制，粘贴到 Notion 发件人库对应行的 <strong>password</strong> 列。</p>
  <pre style="background:#f5f5f5;padding:12px;overflow:auto;max-width:100%;">${escaped}</pre>
  <p><a href="/">返回首页</a> 可再次授权其他账号。用完后可在终端按 Ctrl+C 停止脚本。</p>
</body>
</html>`;
}

/** 错误页：授权失败或换 token 失败时展示 */
function pageError(message: string): string {
  const escaped = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>授权失败</title></head>
<body>
  <h1>授权失败</h1>
  <p>${escaped}</p>
  <p><a href="/">返回首页重试</a></p>
</body>
</html>`;
}

function sendHtml(
  res: import("node:http").ServerResponse,
  status: number,
  html: string,
): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  if (req.method !== "GET") {
    res.writeHead(405);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "", `http://${req.headers.host ?? HOST}`);
  const pathname = url.pathname;

  if (pathname === "/") {
    const oauth2 = getOAuth2Client();
    const authUrl = oauth2.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: [GMAIL_SCOPE],
    });
    sendHtml(res, 200, pageIndex(authUrl));
    return;
  }

  if (pathname === "/callback") {
    const code = url.searchParams.get("code");
    const errorParam = url.searchParams.get("error");
    if (errorParam) {
      const desc = url.searchParams.get("error_description") ?? errorParam;
      sendHtml(res, 200, pageError(`Google 返回错误：${decodeURIComponent(desc)}`));
      return;
    }
    if (!code) {
      sendHtml(res, 200, pageError("未收到授权码，请从首页重新点击授权。"));
      return;
    }
    try {
      const oauth2 = getOAuth2Client();
      const { tokens } = await oauth2.getToken(code);
      const refreshToken = tokens.refresh_token;
      if (!refreshToken) {
        sendHtml(
          res,
          200,
          pageError(
            "未获取到 refresh_token（可能已授权过且未勾选「每次提示」）。请到 Google 账号中移除本应用授权后，从首页重新授权。",
          ),
        );
        return;
      }
      sendHtml(res, 200, pageSuccess(refreshToken));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendHtml(res, 200, pageError(`换 token 失败：${msg}`));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
}

function main(): void {
  const server = createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log(`请在浏览器打开: http://${HOST}:${PORT}`);
  });
}

main();
