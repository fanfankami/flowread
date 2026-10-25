/**
 * OpenAI 兼容的 Chat Completions 流式客户端。
 *
 * DeepSeek、Moonshot、SiliconFlow、各类自建网关都遵循同一套协议，
 * 所以这里只有一份实现，"默认 DeepSeek"和"自定义接口"的差别仅仅是 baseUrl。
 *
 * 必须运行在 service worker 里：
 * - 密钥不出这一侧
 * - 不受页面 CORS 限制
 * - 页面刷新不会打断已经开始的流
 */
import { ProviderError, type PromptMessage, type StreamParams } from './types';

/** 把服务端返回的错误码翻译成用户能看懂的话，而不是丢一个 401 出来。 */
function explainStatus(status: number, body: string): string {
  const snippet = body.slice(0, 200).replace(/\s+/g, ' ').trim();
  const suffix = snippet ? `（${snippet}）` : '';

  switch (status) {
    case 401:
      return 'API Key 无效或已过期，请到设置里重新填写';
    case 402:
      return '账户余额不足，请先充值';
    case 403:
      return '该 Key 没有调用此模型的权限';
    case 404:
      return '接口地址或模型名不正确，请检查 Base URL 与 Model ID';
    case 429:
      return '请求过于频繁或已超出配额，请稍后重试';
    case 500:
    case 502:
    case 503:
      return `模型服务暂时不可用，请稍后重试${suffix}`;
    default:
      return `请求失败（HTTP ${status}）${suffix}`;
  }
}

export async function streamOpenAICompatible(params: StreamParams): Promise<void> {
  const { messages, apiKey, baseUrl, model, temperature, maxTokens, signal, onDelta } = params;

  if (!apiKey.trim()) {
    throw new ProviderError('尚未配置 API Key', 401);
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        temperature,
        max_tokens: maxTokens,
      }),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ProviderError('网络请求失败，请检查网络或接口地址是否正确');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(explainStatus(response.status, body), response.status);
  }

  if (!response.body) {
    throw new ProviderError('服务端没有返回流式内容');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 是逐行协议，但网络分片不保证按行到达，必须自己维护残留
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string | null } }>;
            error?: { message?: string };
          };

          if (parsed.error?.message) {
            throw new ProviderError(parsed.error.message);
          }

          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) onDelta(delta);
        } catch (error) {
          // 只忽略 JSON 还没凑齐的帧；服务端主动报的错要向上抛
          if (error instanceof ProviderError) throw error;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** 设置页的"测试连接"：发一个最小请求，只验证鉴权与地址是否可用。 */
export async function testConnection(config: { apiKey: string; baseUrl: string; model: string }): Promise<string> {
  if (!config.apiKey.trim()) throw new ProviderError('尚未填写 API Key');

  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let response: Response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 8,
        stream: false,
      }),
    });
  } catch {
    throw new ProviderError('网络不可达，请检查 Base URL');
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(explainStatus(response.status, body), response.status);
  }

  const data = (await response.json().catch(() => null)) as { model?: string } | null;
  return data?.model ? `连接成功，模型 ${data.model}` : '连接成功';
}

/**
 * 非流式补全。
 *
 * 只用于"压缩历史"这种内部任务：它不需要逐字显示，
 * 而且必须尽快结束，走流式反而增加复杂度和失败面。
 */
export async function completeOpenAICompatible(params: {
  messages: PromptMessage[];
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature?: number;
}): Promise<string> {
  const endpoint = `${params.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      stream: false,
      temperature: params.temperature ?? 0.2,
      max_tokens: params.maxTokens,
    }),
  });

  if (!response.ok) {
    throw new ProviderError(explainStatus(response.status, await response.text().catch(() => '')));
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? '';
}
