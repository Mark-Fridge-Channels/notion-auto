/**
 * 在 Notion AI 对话页内执行：智能展开 Thought（3s MutationObserver）后抽取可读文本。
 * 逻辑与用户提供的浏览器脚本一致，供 Playwright page.evaluate 调用。
 *
 * 注意：回调会序列化到浏览器。具名 function、外层 async 等在 tsx/esbuild 下可能注入 `__name`，
 * 浏览器无此全局会报 ReferenceError。此处用「同步回调 + 内部 new Promise」且仅使用箭头函数。
 */

import type { Page } from "playwright";

const EXPAND_MS = 3000;

/**
 * 在页面上下文中展开 Thought 并返回拼接后的正文（含 [THOUGHT] / [CONTENT] 分段）。
 */
export async function extractConversationPlainText(page: Page): Promise<string> {
  const script = `
    (() => new Promise((resolve, reject) => {
      try {
        const root = document.querySelector('div.chat_sidebar');
        const seen = new WeakSet();
        const clickIfNeeded = (btn) => {
          if (seen.has(btn)) return;
          const label = btn.innerText || '';
          if (!label.includes('Thought')) return;
          if (btn.querySelector('a, [data-token-index]')) return;
          seen.add(btn);
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        };

        root.querySelectorAll('[role="button"][aria-expanded="false"]').forEach(clickIfNeeded);

        const observer = new MutationObserver(() => {
          root.querySelectorAll('[role="button"][aria-expanded="false"]').forEach(clickIfNeeded);
        });
        observer.observe(root, { childList: true, subtree: true });

        setTimeout(() => {
          try {
            observer.disconnect();
            const result = [];
            const seenList = [];
            const isDuplicate = (text) => seenList.some((s) => s.includes(text) || text.includes(s));
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
            let node;
            while ((node = walker.nextNode())) {
              if (!(node instanceof HTMLElement)) continue;
              if (node.getAttribute('role') === 'button' && node.getAttribute('aria-controls')) {
                const id = node.getAttribute('aria-controls');
                if (!id) continue;
                let content = null;
                try {
                  content = root.querySelector('#' + CSS.escape(id));
                } catch {
                  continue;
                }
                if (content) {
                  const text = content.innerText.trim();
                  if (text && !isDuplicate(text)) {
                    result.push('\\n===== [THOUGHT] =====');
                    result.push(text);
                    seenList.push(text);
                  }
                }
                continue;
              }
              if (node.closest('[aria-controls]')) continue;
              if (node.matches('[data-content-editable-leaf="true"]')) {
                if (node.closest('[contenteditable="true"]')) continue;
                const text = node.innerText.trim();
                if (text && !isDuplicate(text)) {
                  result.push('\\n----- [CONTENT] -----');
                  result.push(text);
                  seenList.push(text);
                }
              }
            }
            resolve(result.join('\\n'));
          } catch (err) {
            reject(err);
          }
        }, ${EXPAND_MS});
      } catch (e) {
        reject(e);
      }
    }))()
  `;
  return page.evaluate(script) as Promise<string>;
}
