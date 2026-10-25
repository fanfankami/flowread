/**
 * 从网页 DOM 里提取"选区所处的阅读上下文"。
 *
 * 设计原则：
 * 1. 只做粗粒度的结构识别（段落 + 最近标题 + 相邻文本），不做正文抽取。
 *    正文抽取（Readability 那类）属于阶段三，这里一旦引入就会拖慢划词响应。
 * 2. 所有函数都必须能容忍奇怪的 DOM（空节点、SVG、自定义元素），
 *    因为它们会在任意网站上运行，抛错就等于划词功能静默失效。
 */

/** 判定为"段落级容器"的标签。刻意不含 span / a / code 这类行内元素。 */
const BLOCK_TAGS = new Set([
  'P', 'LI', 'PRE', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'DIV', 'SECTION', 'ARTICLE', 'FIGCAPTION',
]);

const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';

/** 段落文本保留上限。超过这个长度说明抓到了容器而不是段落，需要截断。 */
const MAX_PARAGRAPH_LENGTH = 3000;

/** 相邻文本保留上限，用于给 AI 提供前后文。 */
const MAX_NEIGHBOR_LENGTH = 300;

/** 把任意 Node 归一到 Element，文本节点取其父元素。 */
function toElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/**
 * 从选区节点向上找到最近的段落级容器。
 *
 * 为什么要有 `el !== document.body` 这道闸：如果选中的文字外面包的全是 div
 * 而页面又没有语义化标签，一路向上会拿到整个 body，那样"当前段落"就退化成"整篇正文"，
 * 上下文会被撑爆。这种情况下宁可返回 null，让调用方降级。
 */
export function closestBlock(node: Node | null): HTMLElement | null {
  let el = toElement(node);

  while (el && el !== document.body && el !== document.documentElement) {
    if (BLOCK_TAGS.has(el.tagName)) {
      const text = el.textContent?.trim() ?? '';
      // 空容器（比如纯图标的 div）跳过，继续向上找
      if (text.length > 0) return el as HTMLElement;
    }
    el = el.parentElement;
  }

  return null;
}

/**
 * 找到选区之前最近的章节标题。
 *
 * 实现选择"遍历所有标题 + compareDocumentPosition"而不是"沿 DOM 向上逐级找"：
 * 标题在语义上往往不是选区的祖先（比如 `<section><h2>..</h2><p>选区</p></section>`
 * 里 h2 是兄弟而非祖先），向上找会漏。
 */
export function findHeading(node: Node | null): string | null {
  if (!node) return null;

  const headings = Array.from(document.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
  let nearest: HTMLElement | null = null;

  for (const heading of headings) {
    // querySelectorAll 按文档顺序返回，所以最后一个"在 node 之前"的就是最近的
    if (node.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_PRECEDING) {
      nearest = heading;
    }
  }

  const text = nearest?.textContent?.trim();
  if (!text) return null;
  // 标题本身可能很长（有些站把整句塞进 h2），截断避免污染 prompt
  return text.slice(0, 120);
}

/**
 * 取段落前后的相邻文本，供 AI 理解"这段话在讲什么"。
 *
 * 只取同级兄弟节点，不做全文扫描：兄弟节点通常就是上下文段落，
 * 而全文扫描在长文上会有明显的卡顿。
 */
export function getSurroundingText(block: HTMLElement, maxLength = MAX_NEIGHBOR_LENGTH): { before: string; after: string } {
  const before = block.previousElementSibling?.textContent?.trim() ?? '';
  const after = block.nextElementSibling?.textContent?.trim() ?? '';

  return {
    // before 取尾部：越靠近选区的文字越相关
    before: before.slice(-maxLength),
    after: after.slice(0, maxLength),
  };
}

/**
 * 判断节点是否处于"不该触发划词"的可编辑区域。
 *
 * 覆盖范围：input / textarea / select / contenteditable。
 * 注意刻意 **不排除** `<pre><code>` —— 静态代码块是正常的阅读内容，
 * 用户就是要对它划词。只有真正可编辑的编辑器（Monaco 的 textarea、
 * CodeMirror 的 contenteditable）才该被排除。
 */
export function isEditableContext(node: Node | null): boolean {
  const el = toElement(node);
  if (!el) return false;

  if (el.closest('input, textarea, select')) return true;

  const editable = el.closest('[contenteditable]');
  if (editable) {
    // contenteditable="false" 是只读区域，仍然允许划词
    return editable.getAttribute('contenteditable') !== 'false';
  }

  return false;
}

/** 把段落文本压到上限内，避免整篇正文被当成"当前段落"发给模型。 */
export function normalizeParagraph(block: HTMLElement): string {
  const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > MAX_PARAGRAPH_LENGTH ? text.slice(0, MAX_PARAGRAPH_LENGTH) : text;
}
