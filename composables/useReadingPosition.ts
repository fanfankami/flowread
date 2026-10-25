/**
 * 阅读位置追踪。
 *
 * 核心思路：不去猜用户眼睛看哪（做不到），而是估算"阅读带"落在哪个块上。
 * 做法是在视口上部 12%~22% 之间开一条窄带，看哪些块与这条带相交 ——
 * 那基本就是人眼正在读的位置。
 *
 * 为什么不用 scroll 事件自己算 top：滚动时每一帧都要遍历所有块调
 * getBoundingClientRect，长文章上会强制同步布局，直接卡成幻灯片。
 * IntersectionObserver 由浏览器在合成线程算，代价低得多。
 */
import { onUnmounted, ref, type Ref } from 'vue';
import type { ReadingContext } from '@/types';

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const BLOCK_SELECTOR = 'p, li, pre, blockquote, td, h1, h2, h3, h4, h5, h6';
/** 低于这个长度的块不参与定位：它们多半是列表项碎片或图片说明，跳来跳去很吵 */
const MIN_BLOCK_TEXT = 30;
/** 更新节流。快速滚动时如果每帧都提交，会看到上下文疯狂跳动 */
const UPDATE_INTERVAL = 180;

export interface UseReadingPositionReturn {
  current: Ref<ReadingContext | null>;
  sections: Ref<string[]>;
  /** 是否成功识别到正文容器。false 表示退了 body，跟随结果可能不准 */
  supported: Ref<boolean>;
  /** 当前阅读带命中的真实元素，用于"切到当前段落"时构建锚点 */
  element: Ref<Element | null>;
  refresh: () => void;
}

function isHeading(el: Element): boolean {
  return HEADING_TAGS.has(el.tagName);
}

function textOf(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function findContentRoot(): { root: Element; supported: boolean } {
  const candidates: Array<[string, boolean]> = [
    ['article', true],
    ['main', true],
    ['[role="main"]', true],
    ['.post-content, .article-content, .markdown-body, .entry-content, #content', true],
  ];

  for (const [selector, supported] of candidates) {
    const element = document.querySelector(selector);
    // 正文太短说明命中的是列表页卡片或侧栏，继续往下找
    if (element && (element.textContent?.length ?? 0) > 800) {
      return { root: element, supported };
    }
  }

  return { root: document.body, supported: false };
}

export function useReadingPosition(): UseReadingPositionReturn {
  const current = ref<ReadingContext | null>(null);
  const sections = ref<string[]>([]);
  const supported = ref(false);
  const element = ref<Element | null>(null);

  let observer: IntersectionObserver | null = null;
  let blocks: Element[] = [];
  let meta = new WeakMap<Element, { heading: string | null; sectionIndex: number }>();
  const visible = new Set<Element>();
  let timer = 0;
  let lastKey = '';

  function computeProgress(): number {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    if (max <= 0) return 0;
    return Math.min(1, Math.max(0, window.scrollY / max));
  }

  function update(): void {
    timer = 0;
    if (blocks.length === 0) return;

    // 取"与阅读带相交且文档顺序最靠前"的块
    let target: Element | null = null;
    for (const block of blocks) {
      if (visible.has(block)) {
        target = block;
        break;
      }
    }
    // 带子落在空白处时保留上一次结果，避免上下文闪成空
    if (!target) return;

    const info = meta.get(target);
    const paragraph = textOf(target);
    const progress = computeProgress();

    // 只有"章节 + 段落开头"真的变了才提交，过滤掉同一段内的抖动
    const key = `${info?.sectionIndex ?? -1}|${paragraph.slice(0, 40)}`;
    if (key === lastKey) return;
    lastKey = key;

    current.value = {
      paragraph: paragraph.slice(0, 1000),
      heading: info?.heading ?? null,
      sectionIndex: info?.sectionIndex ?? -1,
      progress,
      url: location.href,
    };
    element.value = target;
  }

  function schedule(): void {
    if (timer) return;
    timer = window.setTimeout(update, UPDATE_INTERVAL);
  }

  function build(): void {
    observer?.disconnect();
    visible.clear();
    blocks = [];
    meta = new WeakMap();
    lastKey = '';

    const { root, supported: ok } = findContentRoot();
    supported.value = ok;

    const candidates = Array.from(root.querySelectorAll(BLOCK_SELECTOR));
    const list = candidates.filter((el) => {
      const text = textOf(el);
      if (isHeading(el)) return text.length > 0 && text.length < 200;
      return text.length >= MIN_BLOCK_TEXT;
    });

    // 先跑一遍文档序，给每个块标上"它属于哪一章"
    const firstHeading = document.querySelector('h1');
    let heading: string | null = firstHeading ? textOf(firstHeading) : null;
    let sectionIndex = heading ? 0 : -1;
    const sectionList: string[] = heading ? [heading] : [];

    for (const el of list) {
      if (isHeading(el)) {
        heading = textOf(el);
        sectionIndex += 1;
        if (!sectionList.includes(heading)) sectionList.push(heading);
      }
      meta.set(el, { heading, sectionIndex });
    }

    blocks = list;
    sections.value = sectionList;

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target);
          else visible.delete(entry.target);
        }
        schedule();
      },
      // 负的上边距把观察区压成视口 12%~22% 的一条带；
      // 上 12% 避开"刚滚过去的上一段"，下 78% 去掉"还没读到的下面"
      { rootMargin: '-12% 0px -78% 0px', threshold: 0 },
    );

    for (const el of list) observer.observe(el);
    schedule();
  }

  function onScroll(): void {
    schedule();
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });

  // 等首屏图片/字体稳定后再建索引：早建的话块高度还没定型，位置会算错
  const initTimer = window.setTimeout(build, 600);

  onUnmounted(() => {
    window.clearTimeout(initTimer);
    if (timer) window.clearTimeout(timer);
    observer?.disconnect();
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  });

  return { current, sections, supported, element, refresh: build };
}
