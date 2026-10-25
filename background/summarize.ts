/**
 * 历史对话的滚动摘要。
 *
 * 为什么必须压缩：模型上下文是有限的，而且每次请求都把全部历史塞进去，
 * token 费用会随着对话轮数线性上涨。用户问 50 轮，第 50 轮就要为前 49 轮付费。
 *
 * 策略是"摘要 + 窗口"两段式：
 * - 早期对话压成一段要点（本文件负责）
 * - 最近几轮保留完整原文（保证细节不失真）
 * - 锚点（选中的原文）永远在 system prompt 里，不参与压缩
 *
 * 压缩是**累进**的：新摘要 = 旧摘要 + 新被挤出的消息。
 * 如果每次都从零压，摘要会随轮数增加而不断丢失早期信息。
 */
import { CONTEXT_BUDGET } from '@/shared/constants';
import type { AppSettings, ChatMessage } from '@/types';
import { completeOpenAICompatible } from './providers/openai';

/**
 * 把一批消息并入摘要。
 *
 * @param previous 上一版摘要，没有就传 null
 * @returns 新摘要；失败返回 null，调用方应保持旧摘要不变
 */
export async function composeSummary(
  previous: string | null,
  messages: ChatMessage[],
  settings: AppSettings,
): Promise<string | null> {
  // 演示模式没有真实模型，压缩没有意义
  if (settings.provider === 'demo' || !settings.apiKey.trim()) return null;

  const usable = messages.filter((message) => message.content.trim() && message.status !== 'error');
  if (usable.length === 0) return null;

  const transcript = usable
    .map((message) => {
      const role = message.role === 'user' ? '用户' : '助手';
      return `${role}：${message.content.replace(/\s+/g, ' ').trim()}`;
    })
    .join('\n');

  const prompt = [
    previous ? `【已有摘要】\n${previous}` : '',
    `【新增对话】\n${transcript}`,
    '',
    '把上面内容合并压缩成一段不超过 200 字的中文要点。必须保留：',
    '1. 用户问过哪些具体问题（保留关键术语，不要泛化成「询问了相关问题」）',
    '2. 已经给出的结论、代码要点、数字',
    '3. 尚未解决的疑问',
    '可以删掉：寒暄、重复表述、已被推翻的内容。',
    '只输出摘要正文，不要标题、不要编号、不要「以下是摘要」。',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const text = await completeOpenAICompatible({
      messages: [
        {
          role: 'system',
          content:
            '你是一个对话压缩器。你的输出会被直接塞回上下文窗口，所以必须信息密度极高：不寒暄、不复述原文、不评价。',
        },
        { role: 'user', content: prompt },
      ],
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      maxTokens: 400,
      temperature: 0.2,
    });

    if (!text) return null;
    // 双保险：模型偶尔会超字数，硬截断一次
    return text.slice(0, CONTEXT_BUDGET.summary * 2);
  } catch {
    // 压缩失败绝不能阻塞主对话，保持旧摘要即可
    return null;
  }
}

/** 保留最近多少条消息不做压缩（1 轮 = 用户 + 助手 2 条） */
export function keepRecentCount(): number {
  return CONTEXT_BUDGET.maxRecentTurns * 2;
}
