/**
 * 极简 Markdown 渲染器。
 *
 * 为什么不用 marked / markdown-it：
 * 1. 它们默认允许内联 HTML，模型输出里一旦混进 <img onerror=...> 就是 XSS。
 *    Shadow DOM 不防 XSS —— 脚本照样能在页面上下文执行。
 * 2. 模型回复只需要很小一部分语法，为 90% 用不到的能力付 30KB+ 不划算。
 *
 * 硬性约束：**任何输入都不得产生未转义的 HTML**。
 * 所有文本先 escape，再做标记替换，顺序不能反过来。
 */

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BLOCK_START = [
  /^\s*```/,
  /^\s*#{1,6}\s+/,
  /^\s*>/,
  /^\s*[-*+]\s+/,
  /^\s*\d+[.)]\s+/,
  /^\s*\|/,
  /^\s*([-*_])\1{2,}\s*$/,
];

function isBlockStart(line: string): boolean {
  return BLOCK_START.some((pattern) => pattern.test(line));
}

/** 拆分表格行。首尾的竖线可有可无，单元格内容随后统一走 renderInline。 */
function splitTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function renderTable(header: string[], rows: string[][]): string {
  const head = header.map((cell) => `<th>${renderInline(cell)}</th>`).join('');
  const body = rows
    .map((row) => {
      // 列数不一致时补空，避免表格塌成错位
      const cells = header.map((_, i) => `<td>${renderInline(row[i] ?? '')}</td>`).join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `<div class="fr-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

/** 行内标记。行内代码先抽出占位，避免其中的 * _ [ 被当作标记解析。 */
function renderInline(raw: string): string {
  const codes: string[] = [];

  let text = escapeHtml(raw).replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    // 单个 * 才是斜体；用前后断言避免把 ** 的残留再次匹配
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    // 下划线斜体。前后加边界约束，避免把 snake_case_name 里的下划线当标记
    .replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, '$1<em>$2</em>')
    // 只放行 http/https，杜绝 javascript: 伪协议
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => `<code>${codes[Number(index)]}</code>`);
}

function renderCodeBlock(code: string, lang: string, closed: boolean): string {
  const label = lang ? escapeHtml(lang) : 'text';
  // 流式输出中代码块常常还没闭合，这里也按代码块渲染，
  // 否则整段代码会塌成正文，边生成边看时体验极差。
  const copyButton = closed
    ? '<button class="fr-code-copy" type="button" data-action="copy-code">复制</button>'
    : '<span class="fr-code-typing">生成中</span>';

  return `<div class="fr-code"><div class="fr-code-head"><span>${label}</span>${copyButton}</div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

export function renderMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码块
    if (/^\s*```/.test(line)) {
      const lang = line.match(/^\s*```\s*([\w+#.-]*)/)?.[1] ?? '';
      const body: string[] = [];
      index += 1;
      let closed = false;

      while (index < lines.length) {
        if (/^\s*```\s*$/.test(lines[index])) {
          closed = true;
          index += 1;
          break;
        }
        body.push(lines[index]);
        index += 1;
      }

      blocks.push(renderCodeBlock(body.join('\n'), lang, closed));
      continue;
    }

    if (line.trim() === '') {
      index += 1;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push('<hr />');
      index += 1;
      continue;
    }

    // 表格：当前行以 | 开头，且下一行是分隔行（| --- | --- |）
    if (line.trim().startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[index + 1] ?? '')) {
      const header = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      blocks.push(renderTable(header, rows));
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      blocks.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        body.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(`<blockquote>${renderInline(body.join(' '))}</blockquote>`);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(`<ul>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(`<ol>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</ol>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() !== '' && !isBlockStart(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    // 段落内换行保留成 <br>：模型经常用单换行分点，丢掉会全挤成一行
    blocks.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
  }

  return blocks.join('\n');
}

/** 从 Markdown 里提取纯文本，用于生成会话标题、复制到剪贴板等场景。 */
export function toPlainText(source: string): string {
  return source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/[*_~#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
