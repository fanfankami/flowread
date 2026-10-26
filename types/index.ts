/**
 * 全局共享类型。
 *
 * 只放"需要跨进程传递"的数据结构。content script 与 service worker
 * 之间所有消息都必须是可结构化克隆的普通对象，因此这里不允许出现
 * 类实例、DOM 引用或函数。
 */

/** 浮窗的几何矩形，坐标单位为 CSS 像素，原点为视口左上角。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浮窗允许的最小尺寸。 */
export interface SizeLimit {
  minWidth: number;
  minHeight: number;
}

/** 视口尺寸。抽成对象是为了让几何函数保持纯函数、可在 Node 环境单测。 */
export interface Viewport {
  width: number;
  height: number;
}

/** 浮窗的持久化布局。刻意不包含 hidden —— 是否显示由"站点偏好"决定，不跟着窗口一起存。 */
export interface LayoutState {
  rect: Rect;
  minimized: boolean;
}

/**
 * 站点偏好：记住用户在每个站点上的意愿。
 *
 * 默认值是"不显示"。阅读工具的第一原则是不打扰，
 * 自动往每个页面塞一个浮窗是最容易招人烦的做法。
 */
export interface SitePreference {
  /** 用户是否在这个站点主动打开过浮窗 */
  open: boolean;
  /** 最后一次操作时间，用于超出上限时淘汰 */
  at: number;
}

/* ------------------------------------------------------------------ */
/* 阅读上下文                                                          */
/* ------------------------------------------------------------------ */

/**
 * 原文锚点：把"某段文字"变成可以重新定位的东西。
 *
 * 刻意不存滚动像素：像素会随窗口大小、字体、图片加载而失效。
 * 用 前缀 + 正文 + 后缀 三段文本匹配，块序号只在文本匹配失败时兜底。
 */
export interface Anchor {
  /** 用户选中的原文 */
  text: string;
  /** 选区所在段落全文 */
  paragraph: string;
  /** 段落所属章节标题 */
  heading: string | null;
  /** 段落之前的文字 */
  before: string;
  /** 段落之后的文字 */
  after: string;
  /** 段落是正文容器里的第几个块级元素，仅作辅助 */
  blockIndex: number;
  /** 页面 URL（不含 hash，用于判断是否同一篇文章） */
  url: string;
  /** 页面标题 */
  pageTitle: string;
}

/** 阅读位置快照：随滚动变化，随时会被覆盖。 */
export interface ReadingContext {
  /** 当前阅读线附近的段落文本 */
  paragraph: string;
  /** 该段落所属章节 */
  heading: string | null;
  /** 章节序号，用于比较"是否换章" */
  sectionIndex: number;
  /** 阅读进度 0~1 */
  progress: number;
  /** 页面 URL */
  url: string;
}

/* ------------------------------------------------------------------ */
/* 对话                                                                */
/* ------------------------------------------------------------------ */

export type Role = 'system' | 'user' | 'assistant';

export type MessageStatus = 'streaming' | 'done' | 'stopped' | 'error';

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  status: MessageStatus;
  createdAt: number;
  /** 出错时的可读原因 */
  error?: string;
  /** 该条回答用了哪个模型，便于排查 */
  model?: string;
}

export interface Conversation {
  id: string;
  /** 会话标题，取自章节或选区开头 */
  title: string;
  url: string;
  pageTitle: string;
  anchor: Anchor;
  createdAt: number;
  updatedAt: number;
  /** 早期对话的滚动摘要，null 表示还没压缩过 */
  summary: string | null;
  /**
   * 前多少条消息已经并入 summary。
   * 没有这个游标，每次请求都会把同一批消息重复压缩一遍，摘要会越压越糊。
   */
  compressedCount: number;
  messageCount: number;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export type ProviderId = 'demo' | 'deepseek' | 'custom';

/** 配色风格。mono 是 Codex 那种"只有黑白灰"的克制风格，默认选它。 */
export type AccentId = 'mono' | 'blue' | 'green' | 'amber' | 'violet';

/**
 * 界面字体。
 * 全部使用本机已安装字体，不打包字体文件 ——
 * 中文字体动辄几 MB，塞进扩展不现实。
 */
export type FontFamilyId = 'misans' | 'youyuan' | 'noto' | 'deng' | 'yahei' | 'serif' | 'mono';

/** 字号档位。小 / 标准 / 大 / 特大 */
export type FontSizeId = 'sm' | 'md' | 'lg' | 'xl';

export interface AppSettings {
  provider: ProviderId;
  /** 仅 custom 使用；deepseek 走内置默认地址 */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 划词后是否立即调模型；false 时只显示 pill，等用户点 */
  autoExplain: boolean;
  /** 触发捕获的最短字符数 */
  minSelectionLength: number;
  /** 阅读位置自动跟随 */
  followReadingPosition: boolean;
  /** 排除的站点（子串匹配，命中则不自动解释） */
  blockedSites: string[];

  /* ---- 外观 ---- */
  accent: AccentId;
  fontFamily: FontFamilyId;
  fontSize: FontSizeId;
}

/** 发给前端的设置视图：绝不包含 apiKey 原文。 */
export interface PublicSettings extends Omit<AppSettings, 'apiKey'> {
  hasApiKey: boolean;
}

/* ------------------------------------------------------------------ */
/* 消息协议                                                            */
/* ------------------------------------------------------------------ */

export interface ChatRequest {
  conversationId: string;
  /** 本轮用户输入 */
  question: string;
  /** 会话绑定的锚点 */
  anchor: Anchor;
  /** 是否新建会话 */
  isNew: boolean;
  /** 重新生成：删掉最后一条回答后重跑，不重复插入用户消息 */
  regenerate?: boolean;
  /** 当前阅读位置（仅用于 system prompt 里的"读者正在看"提示） */
  readingParagraph?: string;
}

export type StreamEvent =
  | { type: 'start'; messageId: string; conversationId: string; conversation: Conversation }
  | { type: 'delta'; messageId: string; text: string }
  /** Agent 正在执行工具，仅用于界面状态提示，不写进消息内容 */
  | { type: 'tool-status'; messageId: string; label: string }
  | { type: 'done'; messageId: string; content: string }
  | { type: 'stopped'; messageId: string }
  | { type: 'error'; messageId: string; message: string };

/** content → background 的请求 */
export type ClientMessage = { requestId?: string } & (
  | { type: 'settings:get' }
  | { type: 'settings:save'; patch: Partial<AppSettings> }
  | { type: 'settings:test' }
  | { type: 'chat:start'; payload: ChatRequest }
  | { type: 'chat:stop'; conversationId: string }
  /** content script 回传工具执行结果 */
  | { type: 'tool:result'; callId: string; result: unknown }
  | { type: 'conversation:list'; limit?: number }
  | { type: 'conversation:get'; id: string }
  | { type: 'conversation:delete'; id: string }
  | { type: 'conversation:clearAll' }
);

/** background → content 的推送 */
export type ServerMessage =
  | { type: 'stream'; event: StreamEvent }
  /** background 要求 content script 执行一个工具 */
  | { type: 'tool'; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'reply'; requestId: string; ok: true; data?: unknown }
  | { type: 'reply'; requestId: string; ok: false; error: string };
