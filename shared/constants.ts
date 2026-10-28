/** 全局常量。所有"魔法字符串"集中在这里，避免 storage key 写错导致静默失效。 */
import type { AppSettings } from '@/types';

export const STORAGE_KEYS = {
  layout: 'flowread:layout',
  settings: 'flowread:settings',
  /** 站点偏好表：{ [origin]: { open, at } } */
  sites: 'flowread:sites',
} as const;

export const DB_NAME = 'flowread';
export const DB_VERSION = 1;

/** 会话创建时的锚点快照触发上限，防止整篇文章被当成一个锚点 */
export const MAX_ANCHOR_PARAGRAPH = 3000;

/** 单次请求携带的上下文预算（字符数，不是 token）。超出即压缩早期消息。 */
export const CONTEXT_BUDGET = {
  anchor: 2400,
  summary: 600,
  recentMessages: 3200,
  maxRecentTurns: 6,
} as const;

export const DEMO_MODEL = 'flowread-demo';

/** 点「解释」时发送的固定指令。用常量而不是各处手写，是为了让缓存键能稳定命中。 */
export const EXPLAIN_QUESTION = '请结合上下文解释这段内容。';

/** 整页总结的固定指令。显式提示它可以查全文，否则模型只敢总结眼前那段 */
export const SUMMARIZE_PAGE_QUESTION =
  '请总结整篇文章：先用一句话点明主题，再按章节列出核心要点。文章内容较长时可以调用检索工具获取全文，不要只依据当前段落猜测。';

/**
 * 划词后的快捷动作。
 *
 * 只给一个"解释"其实很浪费：选中术语想翻译、选中长段想总结，
 * 都得自己敲字。参考 ChatGPTBox 的做法，把高频意图直接做成按钮。
 */
export const SELECTION_ACTIONS = [
  {
    id: 'explain',
    label: '解释',
    prompt: EXPLAIN_QUESTION,
  },
  {
    id: 'translate',
    label: '翻译',
    prompt: '把这段内容翻译成中文；如果原文已经是中文，就翻译成英文。只输出译文，不要任何解释或前言。',
  },
  {
    id: 'summarize',
    label: '总结',
    prompt: '用两三句话总结这段内容的核心，不要展开细节，不要复述原文。',
  },
] as const;

export type SelectionActionId = (typeof SELECTION_ACTIONS)[number]['id'];

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'demo',
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.3,
  maxTokens: 1600,
  autoExplain: false,
  minSelectionLength: 4,
  followReadingPosition: true,
  blockedSites: ['mail.google.com', 'outlook.', 'bank', 'pay.'],
  // 联网搜索默认关闭：会把你问的内容发给第三方，得先有意识地打开
  webSearchEnabled: false,
  webSearchApiKey: '',
  webSearchResults: 5,
  customActions: [],

  // 默认：无彩色（Codex 的克制感）+ MiSans + 标准字号
  accent: 'mono',
  fontFamily: 'misans',
  fontSize: 'md',
};

/** 外观选项，设置页用它渲染选择器 */
export const ACCENT_OPTIONS = [
  { id: 'mono', label: '黑白', color: '#8E8E8E' },
  { id: 'blue', label: '蓝', color: '#3B82F6' },
  { id: 'green', label: '绿', color: '#22C55E' },
  { id: 'amber', label: '琥珀', color: '#F59E0B' },
  { id: 'violet', label: '紫', color: '#8B5CF6' },
] as const;

/** 气泡宽度有限，超过这个数量会挤成两行，所以卡死上限 */
export const MAX_CUSTOM_ACTIONS = 2;

export const FONT_SIZE_OPTIONS = [
  { id: 'sm', label: '小' },
  { id: 'md', label: '标准' },
  { id: 'lg', label: '大' },
  { id: 'xl', label: '特大' },
] as const;

export const FONT_OPTIONS = [
  { id: 'youyuan', label: '幼圆', hint: '圆角笔画，最圆润' },
  { id: 'misans', label: 'MiSans', hint: '圆角矩形字形，现代但不硬' },
  { id: 'noto', label: '思源黑体', hint: 'Noto Sans SC，标准阅读黑体' },
  { id: 'deng', label: '等线', hint: 'DengXian，比雅黑更细' },
  { id: 'yahei', label: '微软雅黑', hint: '兼容性最好' },
  { id: 'serif', label: '思源宋体', hint: 'Noto Serif SC，纸质书感' },
  { id: 'mono', label: '等宽', hint: '代码与技术阅读' },
] as const;

/** 内置服务商地址。自定义服务商走用户填的 baseUrl。演示放最前，让新用户第一眼就看到"可以先试试"。 */
export const PROVIDER_PRESETS: Record<string, { baseUrl: string; model: string; label: string }> = {
  demo: { baseUrl: '', model: DEMO_MODEL, label: '演示' },
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', label: 'DeepSeek' },
  custom: { baseUrl: '', model: '', label: '自定义' },
};
