/**
 * 文章索引与检索。
 *
 * Agent 要回答"这段以外的内容"，就必须能读整篇文章。
 * 但把全文无脑塞进上下文会撑爆窗口、也会让模型抓不住重点，
 * 所以做成"按需检索"：模型自己决定搜什么、读哪节。
 *
 * 索引是每次调用时现建的 —— 页面可能被展开/折叠、动态加载，
 * 缓存反而容易过期。一篇文章通常几十到几百个块，遍历成本可以忽略。
 */
import { normalizeParagraph } from './dom-context';

export interface ArticleBlock {
  index: number;
  /** 所属章节标题，null 表示在第一个标题之前 */
  heading: string | null;
  /** 块类型，h1~h6 表示标题 */
  tag: string;
  text: string;
}

/** 参与检索的块。表格和列表也算，它们经常包含关键信息 */
const BLOCK_SELECTOR = 'p, li, pre, blockquote, dd, td, h1, h2, h3, h4, h5, h6';

function pickRoot(): HTMLElement {
  const article = document.querySelector<HTMLElement>('article, main, [role="main"]');
  if (article && normalizeParagraph(article).length > 300) return article;
  return document.body;
}

function isHeadingTag(tag: string): boolean {
  return /^h[1-6]$/.test(tag);
}

export function buildArticleIndex(): ArticleBlock[] {
  const root = pickRoot();
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  const blocks: ArticleBlock[] = [];
  let heading: string | null = null;

  nodes.forEach((node, position) => {
    // 嵌套块（li > p、td > p）只取最内层，否则同一段会出现两次
    if (node.querySelector(BLOCK_SELECTOR)) return;

    const text = normalizeParagraph(node);
    if (!text) return;

    const tag = node.tagName.toLowerCase();
    if (isHeadingTag(tag)) heading = text.slice(0, 120);

    blocks.push({ index: position, heading, tag, text });
  });

  return blocks;
}

export function getArticleOutline(): Array<{ level: number; text: string }> {
  const root = pickRoot();
  return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    .map((element) => ({
      level: Number(element.tagName[1]),
      text: normalizeParagraph(element).slice(0, 100),
    }))
    .filter((item) => item.text.length > 0);
}

/**
 * 命中打分。
 *
 * 中文没有词边界，indexOf 计数比任何分词都稳。
 * 完全命中优先；完全不中就退化成"字符覆盖率"，避免一个错字就零结果。
 */
function score(text: string, query: string): number {
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();

  let count = 0;
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    count += 1;
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  if (count > 0) return count;

  const chars = [...new Set(needle.replace(/\s/g, ''))];
  if (chars.length === 0) return 0;
  const hit = chars.filter((char) => haystack.includes(char)).length;
  return hit / chars.length >= 0.75 ? 0.5 : 0;
}

export interface SearchHit {
  heading: string | null;
  excerpt: string;
}

export function searchArticle(query: string, limit = 6): SearchHit[] {
  const needle = query.trim();
  if (!needle) return [];

  return buildArticleIndex()
    .map((block) => ({ block, weight: score(block.text, needle) }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit)
    .map(({ block }) => ({
      heading: block.heading,
      excerpt: block.text.slice(0, 320),
    }));
}

export interface SectionContent {
  heading: string;
  content: string;
}

/** 读取某个标题下的完整内容，直到下一个同级或更高级标题 */
export function readSection(headingQuery: string, maxLength = 2600): SectionContent | null {
  const needle = headingQuery.trim().toLowerCase();
  const blocks = buildArticleIndex();

  const startAt = blocks.findIndex(
    (block) => isHeadingTag(block.tag) && block.text.toLowerCase().includes(needle),
  );
  if (startAt === -1) return null;

  const heading = blocks[startAt];
  const parts: string[] = [];
  let length = 0;

  for (let i = startAt + 1; i < blocks.length; i += 1) {
    if (isHeadingTag(blocks[i].tag)) break;
    if (length + blocks[i].text.length > maxLength) break;
    parts.push(blocks[i].text);
    length += blocks[i].text.length;
  }

  return { heading: heading.text, content: parts.join('\n\n') };
}

/** 供 tool call 直接调用的统一入口 */
export function runArticleTool(name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'search_article':
      return { hits: searchArticle(String(args.query ?? '')) };
    case 'get_article_outline':
      return { outline: getArticleOutline() };
    case 'read_section':
      return { section: readSection(String(args.heading ?? '')) };
    default:
      return { error: `未知工具：${name}` };
  }
}
