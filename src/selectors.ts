/**
 * Notion 页面选择器：优先使用 data-testid、aria-label 等稳定属性
 */

export const NOTION_URL = "https://www.notion.so/Prompt-gateway-3029166fd9fd803cb5a4c41904fcf94c?t=new";

/** Notion AI 头像的父 div：通过 img alt 定位后取父级 */
export const AI_FACE_IMG = 'img[alt="Notion AI face"]';

/** 弹窗内输入框：contenteditable，placeholder 含 Do anything with AI */
export const AI_INPUT = '[data-content-editable-leaf="true"][placeholder="Do anything with AI…"]';

/** 发送按钮 */
export const SEND_BUTTON = '[data-testid="agent-send-message-button"]';

/** 等待 AI 回复完成后「Submit」按钮再次出现的超时（毫秒） */
export const WAIT_SUBMIT_READY_MS = 120_000;

/** 新建对话按钮 */
export const NEW_CHAT_BUTTON = '[aria-label="New AI chat"]';

/** 弹窗出现后额外等待（毫秒） */
export const MODAL_WAIT_MS = 1000;

/** 「Personalize your Notion AI」弹窗（点击 AI 头像后有时会先出现，需点 Done 关闭） */
export const PERSONALIZE_DIALOG = '[role="dialog"][aria-label="Personalize your Notion AI"]';

/** 检测个性化弹窗是否出现的短超时（毫秒） */
export const PERSONALIZE_DIALOG_CHECK_MS = 3000;
