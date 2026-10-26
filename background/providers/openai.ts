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

interface ToolCallBuffer {
  id: string;
  name: string;
  args: string;
}

interface StreamOnceResult {
  content: string;
  toolCalls: ToolCallBuffer[];
}

/**
 * 单轮流式请求。
 *
 * content 边收边通过 onDelta 吐出去；tool_calls 的 arguments 是**分片到达**的
 * （一个 JSON 可能横跨十几个 SSE 帧），所以按 index 累积，等流结束再拼。
 */
async function streamOnce(params: StreamParams & { tools?: unknown[] }): Promise<StreamOnceResult> {
  const { messages, apiKey, baseUrl, model, temperature, maxTokens, signal, onDelta, tools } = params;

  if (!apiKey.trim()) {
    throw new ProviderError('尚未配置 API Key', 401);
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    temperature,
    max_tokens: maxTokens,
  };
  if (tools && tools.length > 0) body.tools = tools;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ProviderError('网络请求失败，请检查网络或接口地址是否正确');
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ProviderError(explainStatus(response.status, text), response.status);
  }

  if (!response.body) {
    throw new ProviderError('服务端没有返回流式内容');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  const toolBuffers = new Map<number, ToolCallBuffer>();
  let finished = false;

  try {
    while (!finished) {
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
        if (payload === '[DONE]') {
          finished = true;
          break;
        }

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
            }>;
            error?: { message?: string };
          };

          if (parsed.error?.message) throw new ProviderError(parsed.error.message);

          const delta = parsed.choices?.[0]?.delta;

          if (delta?.content) {
            content += delta.content;
            onDelta(delta.content);
          }

          if (delta?.tool_calls) {
            for (const piece of delta.tool_calls) {
              const existing = toolBuffers.get(piece.index) ?? { id: '', name: '', args: '' };
              if (piece.id) existing.id = piece.id;
              if (piece.function?.name) existing.name += piece.function.name;
              if (piece.function?.arguments) existing.args += piece.function.arguments;
              toolBuffers.set(piece.index, existing);
            }
          }
        } catch (error) {
          // 只忽略 JSON 还没凑齐的帧；服务端主动报的错要向上抛
          if (error instanceof ProviderError) throw error;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return {
    content,
    toolCalls: [...toolBuffers.values()].filter((call) => call.name.length > 0),
  };
}

/** 纯文本流式输出，不带工具。 */
export async function streamOpenAICompatible(params: StreamParams): Promise<void> {
  await streamOnce(params);
}

export interface ToolLoopParams extends StreamParams {
  tools: unknown[];
  /** 单次对话最多允许几轮工具调用，防止模型陷入死循环 */
  maxRounds?: number;
  onToolStart?: (name: string, args: Record<string, unknown>) => void;
  onToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * 带工具的多轮对话。
 *
 * 循环：请求 → 有 tool_calls 就执行 → 结果拼回 messages → 再请求，
 * 直到模型不再调工具（那一轮的 content 就是最终答案，边流边出）。
 */
export async function streamWithTools(params: ToolLoopParams): Promise<void> {
  const { tools, maxRounds = 4, onToolStart, onToolCall, ...rest } = params;
  const messages: PromptMessage[] = [...rest.messages];

  for (let round = 0; round < maxRounds; round += 1) {
    const result = await streamOnce({ ...rest, messages, tools });

    if (result.toolCalls.length === 0) return;

    // 把模型的"我要调工具"意图记进历史，否则下一轮它会重复调
    messages.push({
      role: 'assistant',
      content: result.content || null,
      tool_calls: result.toolCalls.map((call) => ({
        id: call.id || `call_${round}`,
        type: 'function' as const,
        function: { name: call.name, arguments: call.args || '{}' },
      })),
    });

    for (const call of result.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.args || '{}') as Record<string, unknown>;
      } catch {
        args = {};
      }

      onToolStart?.(call.name, args);

      let toolResult: unknown;
      try {
        toolResult = await onToolCall(call.name, args);
      } catch (error) {
        // 工具失败不能中断整轮对话，把错误当成结果喂回去让模型自己决定怎么办
        toolResult = { error: error instanceof Error ? error.message : '工具执行失败' };
      }

      messages.push({
        role: 'tool',
        tool_call_id: call.id || `call_${round}`,
        content: JSON.stringify(toolResult).slice(0, 6000),
      });
    }
  }

  throw new ProviderError('工具调用轮数超过上限，已中止。可以换个问法再试。');
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
