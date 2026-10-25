/**
 * 原文锚点的构建与定位。
 *
 * 为什么不用滚动像素定位：像素只在"同一窗口大小 + 同一字体 + 图片已加载"时成立。
 * 用户换台显示器、系统字体变了、图片慢加载，存下的 top 就完全错位。
 *
 * 所以锚点存的是**文本指纹**：段落全文 + 前后文 + 选中的那一小段。
 * 定位时先精确匹配段落，多个命中再靠前后文消歧，最后才用块序号兜底。
 */
import type { Anchor } from '@/types';

const BLOCK_SELECTOR = 'p, li, pre, blockquote, td, dd';

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function contentRoot(): Element {
  return document.querySelector('article') ?? document.querySelector('main') ?? document.body;
}

/** 段落是正文容器里的第几个块。仅作为最后兜底，不参与主判定。 */
export function blockIndexOf(block: Element): number {
  const list = Array.from(contentRoot().querySelectorAll(BLOCK_SELECTOR));
  return list.indexOf(block);
}

export function buildAnchor(input: {
  text: string;
  paragraph: string;
  heading: string | null;
  before: string;
  after: string;
  block: Element;
}): Anchor {
  return {
    text: input.text,
    paragraph: input.paragraph,
    heading: input.heading,
    before: input.before,
    after: input.after,
    blockIndex: blockIndexOf(input.block),
    url: location.href,
    pageTitle: document.title,
  };
}

export type LocateResult =
  | { ok: true; element: Element; exact: boolean }
  | { ok: false; reason: string };

/**
 * 在页面里重新找到锚点对应的元素。
 *
 * 分级匹配，越往后越宽松，也越可能定位到"差不多但不对"的地方，
 * 所以最后要如实返回 exact 标记，让 UI 决定要不要提示用户。
 */
export function locateAnchor(anchor: Anchor): LocateResult {
  const blocks = Array.from(contentRoot().querySelectorAll(BLOCK_SELECTOR));
  if (blocks.length === 0) {
    return { ok: false, reason: '当前页面没有可定位的正文' };
  }

  const target = normalize(anchor.paragraph);

  // 1. 段落全文精确匹配
  const exact = blocks.filter((el) => normalize(el.textContent ?? '') === target);
  if (exact.length === 1) {
    return { ok: true, element: exact[0], exact: true };
  }

  // 2. 多处相同段落：用前后文判断是哪一个
  if (exact.length > 1) {
    const beforeTail = normalize(anchor.before).slice(-30);
    const afterHead = normalize(anchor.after).slice(0, 30);

    let best = exact[0];
    let bestScore = -1;

    for (const element of exact) {
      let score = 0;
      const prev = normalize(element.previousElementSibling?.textContent ?? '');
      const next = normalize(element.nextElementSibling?.textContent ?? '');
      if (beforeTail && prev.includes(beforeTail)) score += 2;
      if (afterHead && next.includes(afterHead)) score += 2;
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    return { ok: true, element: best, exact: true };
  }

  // 3. 文章被小幅编辑：段落前缀仍然存在
  const head = target.slice(0, 60);
  if (head.length >= 20) {
    const partial = blocks.find((el) => normalize(el.textContent ?? '').includes(head));
    if (partial) return { ok: true, element: partial, exact: false };
  }

  // 4. 段落被整体改写，但选中的那句话还在
  const selected = normalize(anchor.text).slice(0, 40);
  if (selected.length >= 12) {
    const bySelection = blocks.find((el) => normalize(el.textContent ?? '').includes(selected));
    if (bySelection) return { ok: true, element: bySelection, exact: false };
  }

  // 5. 块序号兜底 —— 只在文章结构没大改时有效
  if (anchor.blockIndex >= 0 && anchor.blockIndex < blocks.length) {
    return { ok: true, element: blocks[anchor.blockIndex], exact: false };
  }

  return { ok: false, reason: '文章内容可能已经更新，找不到这段原文了' };
}

/** 滚到目标位置并做一次短暂高亮。样式用完即还原，不留痕迹。 */
export function scrollToAnchor(element: Element): void {
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const target = element as HTMLElement;
  const previousOutline = target.style.outline;
  const previousOffset = target.style.outlineOffset;
  const previousTransition = target.style.transition;

  target.style.transition = 'outline-color 240ms ease';
  target.style.outline = '2px solid #3b6ef5';
  target.style.outlineOffset = '3px';

  window.setTimeout(() => {
    target.style.outline = previousOutline;
    target.style.outlineOffset = previousOffset;
    // 等颜色过渡结束再还原 transition，否则会看到高亮"闪一下消失"
    window.setTimeout(() => {
      target.style.transition = previousTransition;
    }, 260);
  }, 1600);
}
