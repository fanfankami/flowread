// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildArticleIndex,
  getArticleOutline,
  readSection,
  runArticleTool,
  searchArticle,
} from '@/utils/article-index';

const LONG = '这是一段用来把文章撑长的填充文字，目的是让 pickRoot 认为 article 才是正文，而不是整个 body。'.repeat(6);

function setup(html: string): void {
  document.body.innerHTML = html;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('buildArticleIndex', () => {
  it('每个块归属到它上方最近的标题', () => {
    setup(`<div>
      <p>导语</p>
      <h2>第一节</h2>
      <p>甲</p>
      <p>乙</p>
      <h2>第二节</h2>
      <p>丙</p>
    </div>`);

    const blocks = buildArticleIndex();
    const byText = (t: string) => blocks.find((b) => b.text.includes(t));

    expect(byText('导语')?.heading).toBeNull();
    expect(byText('甲')?.heading).toBe('第一节');
    expect(byText('乙')?.heading).toBe('第一节');
    expect(byText('丙')?.heading).toBe('第二节');
  });

  it('嵌套块只取最内层，避免同一段出现两次', () => {
    setup(`<div>
      <ul><li><p>列表里的段落</p></li></ul>
    </div>`);

    const blocks = buildArticleIndex();
    const hits = blocks.filter((b) => b.text.includes('列表里的段落'));
    expect(hits).toHaveLength(1);
  });

  it('空块被跳过', () => {
    setup(`<div><p>   </p><p>有内容</p></div>`);
    expect(buildArticleIndex()).toHaveLength(1);
  });
});

describe('searchArticle', () => {
  beforeEach(() => {
    setup(`<article>
      <h2>扩容机制</h2>
      <p>${LONG}</p>
      <p>链表长度超过 8 时会转换为红黑树</p>
      <h2>负载因子</h2>
      <p>${LONG}</p>
      <p>负载因子默认是 0.75</p>
    </article>`);
  });

  it('精确命中返回所在章节与摘录', () => {
    const hits = searchArticle('红黑树');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].heading).toBe('扩容机制');
    expect(hits[0].excerpt).toContain('红黑树');
  });

  it('命中次数多的排在前面', () => {
    setup(`<div>
      <p>负载因子 负载因子 负载因子</p>
      <p>负载因子只出现一次</p>
    </div>`);
    const hits = searchArticle('负载因子');
    expect(hits[0].excerpt.startsWith('负载因子 负载因子')).toBe(true);
  });

  it('完全没命中时用字符覆盖率兜底，但不乱给结果', () => {
    const hits = searchArticle('完全不相干的词汇xyz');
    expect(hits).toHaveLength(0);
  });

  it('空查询返回空数组', () => {
    expect(searchArticle('   ')).toEqual([]);
  });

  it('结果条数受 limit 限制', () => {
    setup(Array.from({ length: 20 }, (_, i) => `<p>关键词 ${i}</p>`).join(''));
    expect(searchArticle('关键词', 3)).toHaveLength(3);
  });
});

describe('getArticleOutline', () => {
  it('按 DOM 顺序返回所有标题及层级', () => {
    setup(`<article>
      <h1>大标题</h1>
      <h2>第一节</h2>
      <h3>小节</h3>
      <h2>第二节</h2>
    </article>`);

    expect(getArticleOutline()).toEqual([
      { level: 1, text: '大标题' },
      { level: 2, text: '第一节' },
      { level: 3, text: '小节' },
      { level: 2, text: '第二节' },
    ]);
  });
});

describe('readSection', () => {
  beforeEach(() => {
    setup(`<article>
      <h2>第一节</h2>
      <p>甲段</p>
      <p>乙段</p>
      <h2>第二节</h2>
      <p>丙段</p>
    </article>`);
  });

  it('读取标题到下一个标题之间的内容', () => {
    const section = readSection('第一节');
    expect(section).not.toBeNull();
    expect(section!.heading).toBe('第一节');
    expect(section!.content).toContain('甲段');
    expect(section!.content).toContain('乙段');
    expect(section!.content).not.toContain('丙段');
  });

  it('支持模糊匹配标题片段', () => {
    expect(readSection('第二')?.content).toContain('丙段');
  });

  it('找不到章节返回 null', () => {
    expect(readSection('不存在的章节')).toBeNull();
  });

  it('内容超长时截断，不返回整篇', () => {
    setup(`<article>
      <h2>长章节</h2>
      ${Array.from({ length: 50 }, () => `<p>${'内容'.repeat(60)}</p>`).join('')}
    </article>`);
    const section = readSection('长章节', 500);
    expect(section!.content.length).toBeLessThanOrEqual(500);
  });
});

describe('runArticleTool', () => {
  beforeEach(() => {
    setup(`<article>
      <h2>唯一约束</h2>
      <p>唯一索引是防重复的根本</p>
    </article>`);
  });

  it('把工具名分派到对应实现', () => {
    expect(runArticleTool('search_article', { query: '唯一索引' })).toHaveProperty('hits');
    expect(runArticleTool('get_article_outline', {})).toHaveProperty('outline');
    expect(runArticleTool('read_section', { heading: '唯一约束' })).toHaveProperty('section');
  });

  it('未知工具返回错误而不是抛异常', () => {
    const result = runArticleTool('rm_rf', {}) as { error?: string };
    expect(result.error).toContain('未知工具');
  });
});
