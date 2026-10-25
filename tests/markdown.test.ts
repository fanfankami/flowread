import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown, toPlainText } from '@/shared/markdown';

describe('escapeHtml', () => {
  it('转义所有 HTML 敏感字符', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });

  it('先转义 & 避免二次转义漏洞', () => {
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });
});

describe('renderMarkdown 安全性', () => {
  it('内联 script 被转义而不是执行', () => {
    const html = renderMarkdown('正常文字 <script>alert(1)</script> 结尾');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('img onerror 注入被转义', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&lt;img');
  });

  it('拒绝 javascript: 伪协议链接', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))');
    expect(html).not.toContain('href="javascript:');
  });

  it('放行正常 https 链接并加 noopener', () => {
    const html = renderMarkdown('[文档](https://example.com/a)');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe('renderMarkdown 语法', () => {
  it('渲染标题', () => {
    expect(renderMarkdown('## 二级标题')).toContain('<h2>二级标题</h2>');
  });

  it('渲染粗体与行内代码', () => {
    const html = renderMarkdown('这是 **重点** 和 `code` 混排');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<code>code</code>');
  });

  it('行内代码里的星号不被当作粗体', () => {
    const html = renderMarkdown('`a ** b`');
    expect(html).toContain('<code>a ** b</code>');
    expect(html).not.toContain('<strong>');
  });

  it('渲染无序与有序列表', () => {
    expect(renderMarkdown('- 一\n- 二')).toContain('<ul><li>一</li><li>二</li></ul>');
    expect(renderMarkdown('1. 一\n2. 二')).toContain('<ol><li>一</li><li>二</li></ol>');
  });

  it('渲染表格', () => {
    const html = renderMarkdown('| 维度 | 说明 |\n| --- | --- |\n| 时间 | O(1) |');
    expect(html).toContain('<th>维度</th>');
    expect(html).toContain('<td>O(1)</td>');
  });

  it('渲染引用块', () => {
    expect(renderMarkdown('> 引用内容')).toContain('<blockquote>引用内容</blockquote>');
  });

  it('段落内单换行保留为换行', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br />');
  });
});

describe('renderMarkdown 流式容错', () => {
  it('未闭合的代码块仍然渲染成代码块', () => {
    // 流式输出时代码块常年"只写了一半"，此时不能塌成正文
    const html = renderMarkdown('说明文字\n```java\nint a = 1;');
    expect(html).toContain('class="fr-code"');
    expect(html).toContain('int a = 1;');
    expect(html).toContain('生成中');
  });

  it('已闭合的代码块提供复制按钮', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('data-action="copy-code"');
    expect(html).not.toContain('生成中');
  });

  it('代码块内的标记符号不会被解析', () => {
    const html = renderMarkdown('```\n# 这不是标题\n**这不是粗体**\n```');
    expect(html).not.toContain('<h1>');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('# 这不是标题');
  });

  it('空字符串不产生内容', () => {
    expect(renderMarkdown('').trim()).toBe('');
  });

  it('只有空白字符不报错', () => {
    expect(() => renderMarkdown('\n\n   \n')).not.toThrow();
  });
});

describe('toPlainText', () => {
  it('剥离代码块与标记', () => {
    const text = toPlainText('## 标题\n**粗体**和`代码`\n```js\nlet a=1\n```');
    expect(text).not.toContain('```');
    expect(text).not.toContain('**');
    expect(text).toContain('标题');
    expect(text).toContain('粗体');
  });
});

describe('下划线斜体', () => {
  it('解析 _斜体_', () => {
    expect(renderMarkdown('你问的是：_为什么是 8_')).toContain('<em>为什么是 8</em>');
  });

  it('不把 snake_case 当作斜体', () => {
    const html = renderMarkdown('变量 treeify_bin_count 不该被解析');
    expect(html).not.toContain('<em>');
  });
});
