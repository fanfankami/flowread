/**
 * 暴露给模型的工具。
 *
 * 设计原则：三个工具覆盖"看全局 / 找细节 / 读整节"，
 * 再多模型就容易选错。描述里写清"什么时候用"，比写清"参数是什么"更重要。
 */
export const ARTICLE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_article_outline',
      description:
        '获取当前文章的整体结构（所有标题及层级）。当用户问「这篇文章讲什么」「有哪些章节」「整体怎么组织的」，或者你需要判断某个话题是否在别的章节出现过时使用。',
      parameters: {
        type: 'object',
        properties: {},
        required: [] as string[],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'search_article',
      description:
        '在整篇文章里搜索关键词，返回命中的段落摘录及其所在章节。当用户问到当前讨论段落以外的内容、需要确认某个概念在别处是否提过、或者要对比不同位置的论述时使用。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要搜索的关键词或短语。2-8 个字命中率最高，不要整句搜索。',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_section',
      description:
        '读取指定章节的完整内容。当需要详细引用、逐点对比，或者用户明确要求「把那一节讲清楚」时使用。search_article 只给摘录，需要全文时用这个。',
      parameters: {
        type: 'object',
        properties: {
          heading: {
            type: 'string',
            description: '章节标题，可以是标题的一部分（模糊匹配）',
          },
        },
        required: ['heading'],
      },
    },
  },
];

/** 给界面看的动作描述，让用户知道 Agent 正在干什么 */
export function describeToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case 'search_article':
      return `正在全文搜索「${String(args.query ?? '')}」`;
    case 'get_article_outline':
      return '正在读取文章大纲';
    case 'read_section':
      return `正在阅读章节「${String(args.heading ?? '')}」`;
    default:
      return '正在检索文章';
  }
}
