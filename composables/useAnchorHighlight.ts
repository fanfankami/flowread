/**
 * 锚点高亮。
 *
 * 解决的问题：用户点"解释"的瞬间，浏览器会清掉页面 Selection，
 * 于是那段被选中的文字立刻变回普通样式 —— 用户失去"我在问什么"的视觉参照，
 * 浮窗里又只有 AI 的回答，整个上下文就断了。
 *
 * 解法是用 CSS Custom Highlight API（Chrome 105+）：
 * 它把高亮挂在 Range 上，和 Selection 是两套独立机制，
 * 所以 Selection 被清掉之后，高亮仍然留在页面上。
 */
import { onUnmounted, ref } from 'vue';

const HIGHLIGHT_NAME = 'flowread-anchor';
const STYLE_ID = 'flowread-highlight-style';

/**
 * 高亮样式必须注入 document，不能放在 shadow root 里 —— 它作用的是页面正文。
 * 颜色由外部传入（跟随用户的强调色设置），因为页面上拿不到 shadow 内的 CSS 变量。
 */
function ensureStyle(color: string): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;

  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.documentElement.appendChild(style);
  }

  style.textContent = `::highlight(${HIGHLIGHT_NAME}) { background-color: ${color}; color: inherit; }`;
}

/** 强调色 × 深浅 → 高亮色。透明度都压得比较低，避免盖住正文本身。 */
export const HIGHLIGHT_COLORS: Record<string, { light: string; dark: string }> = {
  mono: { light: 'rgba(10, 10, 10, 0.10)', dark: 'rgba(237, 237, 237, 0.16)' },
  blue: { light: 'rgba(37, 99, 235, 0.18)', dark: 'rgba(110, 168, 255, 0.24)' },
  green: { light: 'rgba(21, 128, 61, 0.18)', dark: 'rgba(74, 222, 128, 0.22)' },
  amber: { light: 'rgba(180, 83, 9, 0.18)', dark: 'rgba(251, 191, 36, 0.22)' },
  violet: { light: 'rgba(109, 40, 217, 0.16)', dark: 'rgba(167, 139, 250, 0.22)' },
};

export interface UseAnchorHighlightReturn {
  /** 当前是否支持 Highlight API，不支持时组件不要承诺"高亮保留" */
  supported: boolean;
  /** 是否有活跃高亮 */
  active: ReturnType<typeof ref<boolean>>;
  apply: (range: Range | null) => void;
  clear: () => void;
  /** 切换高亮颜色（跟随强调色/深浅变化） */
  setColor: (color: string) => void;
  /** 高亮闪烁一次，用于"回到原文"时的视觉引导 */
  flash: () => void;
}

export function useAnchorHighlight(): UseAnchorHighlightReturn {
  const supported = typeof CSS !== 'undefined' && 'highlights' in CSS;
  const active = ref(false);
  let lastRange: Range | null = null;

  if (supported) ensureStyle(HIGHLIGHT_COLORS.mono.light);

  function apply(range: Range | null): void {
    if (!supported) return;
    if (!range) {
      clear();
      return;
    }
    try {
      // Range 可能因为页面 DOM 变动而失效，set 之前必须确认它还有效
      if (range.collapsed) {
        clear();
        return;
      }
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(range));
      lastRange = range;
      active.value = true;
    } catch {
      // 失效的 Range 直接忽略，不能让高亮功能把主流程带崩
      clear();
    }
  }

  function clear(): void {
    if (!supported) return;
    CSS.highlights.delete(HIGHLIGHT_NAME);
    lastRange = null;
    active.value = false;
  }

  function flash(): void {
    if (!supported || !lastRange) return;
    // 先清再设，触发一次重绘，看起来就像"闪了一下"
    const range = lastRange;
    CSS.highlights.delete(HIGHLIGHT_NAME);
    window.setTimeout(() => apply(range), 120);
  }

  function setColor(color: string): void {
    if (!supported) return;
    ensureStyle(color);
  }

  onUnmounted(clear);

  return { supported, active, apply, clear, flash, setColor };
}
