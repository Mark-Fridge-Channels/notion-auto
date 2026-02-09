/**
 * Notion 页面选择器：优先使用 data-testid、aria-label 等稳定属性
 */

export const NOTION_URL = "https://www.notion.so/Fridge-Channel-DB-Portal-3029166fd9fd80c0a83cd35a4b56e7ea?t=3029166fd9fd80e7835a00a97657c124";

/** Notion AI 头像的父 div：通过 img alt 定位后取父级 */
export const AI_FACE_IMG = 'img[alt="Notion AI face"]';

/** 弹窗内输入框：contenteditable，placeholder 含 Do anything with AI */
export const AI_INPUT = '[data-content-editable-leaf="true"][placeholder="Do anything with AI…"]';

/** 发送按钮 */
export const SEND_BUTTON = '[data-testid="agent-send-message-button"]';

/** 新建对话按钮 */
export const NEW_CHAT_BUTTON = '[aria-label="New AI chat"]';

/** 弹窗出现后额外等待（毫秒） */
export const MODAL_WAIT_MS = 1000;
