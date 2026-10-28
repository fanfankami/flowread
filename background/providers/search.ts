/**
 * 联网搜索（Tavily）。
 *
 * 为什么选 Tavily 而不是通用搜索 API：
 * - 它返回的是给 LLM 读的摘要，不是 SEO 标题堆砌
 * - 一次调用就能拿到 answer + 若干条带正文摘录的结果
 * - 免费额度对个人使用足够
 *
 * 必须跑在 background：content script 受页面 CORS 限制，
 * 而且搜索 Key 和模型 Key 一样不该出现在页面上下文里。
 */
import { ProviderError } from './types';

export interface WebSearchHit {
  title: string;
  url: string;
  content: string;
}

export interface WebSearchResult {
  /** 服务商直接给的整合答案，可能为空 */
  answer: string | null;
  hits: WebSearchHit[];
}

const ENDPOINT = 'https://api.tavily.com/search';
const TIMEOUT_MS = 12000;

export async function webSearch(
  query: string,
  options: { apiKey: string; maxResults?: number; signal?: AbortSignal },
): Promise<WebSearchResult> {
  const key = options.apiKey.trim();
  if (!key) throw new ProviderError('尚未配置联网搜索的 API Key');

  const trimmed = query.trim();
  if (!trimmed) throw new ProviderError('搜索关键词为空');

  // 搜索是辅助信息，不能让它把整轮对话拖住
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query: trimmed,
        search_depth: 'basic',
        include_answer: true,
        max_results: Math.min(Math.max(options.maxResults ?? 5, 1), 8),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      if (response.status === 401 || response.status === 403) {
        throw new ProviderError('联网搜索的 API Key 无效，请到设置里重新填写');
      }
      if (response.status === 429) {
        throw new ProviderError('联网搜索额度已用完，请稍后再试或更换 Key');
      }
      throw new ProviderError(`联网搜索失败（HTTP ${response.status}）${body.slice(0, 120)}`);
    }

    const data = (await response.json()) as {
      answer?: string | null;
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return {
      answer: data.answer?.trim() || null,
      hits: (data.results ?? [])
        .filter((item) => item.url && (item.content || item.title))
        .map((item) => ({
          title: (item.title ?? '').slice(0, 160),
          url: item.url ?? '',
          // 单条摘要太长会挤占上下文，320 字够模型判断相关性了
          content: (item.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 320),
        })),
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ProviderError('联网搜索超时，已跳过');
    }
    throw new ProviderError('联网搜索请求失败，请检查网络');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
