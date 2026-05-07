/**
 * Notion 页面选择器：优先使用 data-testid、aria-label 等稳定属性
 */

export const NOTION_URL = "https://www.notion.so/Prompt-gateway-3029166fd9fd803cb5a4c41904fcf94c?t=new";

/** 右下角 Notion 助手角（AI 入口与偶发「预览关闭」均在此容器内；勿对全页匹配 Close） */
export const ASSISTANT_CORNER_ORIGIN_CONTAINER = ".notion-assistant-corner-origin-container";

/** Notion AI 头像的父 div：通过 img alt 定位后取父级 */
export const AI_FACE_IMG = `${ASSISTANT_CORNER_ORIGIN_CONTAINER} div.notion-ai-button[role="button"][aria-label="ai"]`;

/** 检测助手角内「Close」是否出现的短超时（毫秒）；与个性化弹窗检测量级一致 */
export const ASSISTANT_CORNER_CLOSE_CHECK_MS = 3000;

/** 弹窗内输入框：contenteditable，placeholder 含 Do anything with AI */
export const AI_INPUT = '[data-content-editable-leaf="true"][placeholder="Do anything with AI…"]';

/** 发送按钮 */
export const SEND_BUTTON = '[data-testid="agent-send-message-button"]';

/** 生成中时的停止按钮（与发送按钮同一位，互斥可见） */
export const STOP_INFERENCE_BUTTON = '[data-testid="agent-stop-inference-button"]';

/** 统一聊天模型选择器按钮（生产环境优先使用） */
export const UNIFIED_CHAT_MODEL_BUTTON = 'div[data-testid="unified-chat-model-button"]';

/** 等待 AI 回复完成后「Submit」按钮再次出现的超时（毫秒）；与 schedule.waitSubmitReadyMs 默认 30 分钟一致，供未传参时 fallback */
export const WAIT_SUBMIT_READY_MS = 1_800_000;

/** 新建对话按钮 */
export const NEW_CHAT_BUTTON = '[aria-label="Start new chat"]';

/** 弹窗出现后额外等待（毫秒） */
export const MODAL_WAIT_MS = 1000;

/** 「Personalize your Notion AI」弹窗（点击 AI 头像后有时会先出现，需点 Done 关闭） */
export const PERSONALIZE_DIALOG = '[role="dialog"][aria-label="Personalize your Notion AI"]';

/** 检测个性化弹窗是否出现的短超时（毫秒） */
export const PERSONALIZE_DIALOG_CHECK_MS = 3000;

/**
 * 发送后 Notion AI 有时弹出调查选项列表，已知两种类目：
 *   - 「What do you want to do next?」→ survey-option-intent-*
 *   - 「下一步执行哪个工作流？」     → survey-option-next_path-*
 * 用通用前缀匹配，避免每出新类目都要改选择器。
 */
export const SURVEY_LISTBOX = '[role="listbox"][aria-activedescendant^="survey-option-"]';

/** 调查中「Other（自定义输入）」选项的可编辑输入框（id 形如 survey-option-<category>-__other__） */
export const SURVEY_OTHER_INPUT =
  '[id^="survey-option-"][id$="-__other__"] [contenteditable="true"]';

/** 检测调查弹窗是否出现的短超时（毫秒） */
export const SURVEY_CHECK_MS = 3000;
