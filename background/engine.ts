/**
 * 对话调度引擎。
 *
 * 职责：把"一次提问"翻译成"一串发给模型的消息"，驱动流式输出，
 * 并把结果落库。所有状态都在 service worker 里，页面刷新不会丢。
 *
 * 上下文策略（对应"上下文锁定"需求）：
 * - 锚点（anchor）在会话创建时固定，之后滚动页面不会改变它
 * - 早期消息超出预算时，用规则摘要压缩，而不是调模型生成（省一次请求）
 * - 稳定内容（system + 锚点原文）永远排在最前面，便于命中前缀缓存
 */
import { CONTEXT_BUDGET, DEMO_MODEL, EXPLAIN_QUESTION } from '@/shared/constants';
import { pickRecentWindow, truncate } from '@/shared/token';
import type { Anchor, ChatMessage, ChatRequest, Conversation, StreamEvent } from '@/types';
import {
  appendMessage,
  createConversation,
  deleteMessage,
  getCachedAnswer,
  getConversation,
  listMessages,
  newId,
  setCachedAnswer,
  touchConversation,
  updateMessage,
} from './db';
import { getSettings } from './settings';
import { streamDemo } from './providers/demo';
import { streamOpenAICompatible, streamWithTools } from './providers/openai';
import { composeSummary, keepRecentCount } from './summarize';
import { ARTICLE_TOOLS, WEB_SEARCH_TOOL, describeToolCall } from '@/shared/tools';
import { webSearch } from './providers/search';
import type { PromptMessage, StreamParams } from './providers/types';

/** 正在进行的请求，用于"停止生成"。key 是 conversationId。 */
const activeRuns = new Map<string, AbortController>();

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** 缓存键：模型 + 地址 + 原文。同一段文字重复划词时直接回放，避免重复计费。 */
function cacheKey(anchor: Anchor, model: string): string {
  const head = anchor.text.slice(0, 80).replace(/\s+/g, ' ');
  return `${model}|${anchor.url}|${anchor.text.length}|${head}`;
}

function buildSystemPrompt(anchor: Anchor, readingParagraph?: string): string {
  const lines = [
    '你是 FlowRead，一个嵌在网页里的阅读助手。用户正在读一篇文章，请只围绕下面这段原文回答。',
    '',
    '## 当前讨论的原文',
    anchor.heading ? `- 章节：${anchor.heading}` : '',
    `- 文章：${anchor.pageTitle}`,
    `- 段落：${truncate(anchor.paragraph, CONTEXT_BUDGET.anchor)}`,
    `- 用户选中：${anchor.text}`,
    anchor.before ? `- 前文：${truncate(anchor.before, 240)}` : '',
    anchor.after ? `- 后文：${truncate(anchor.after, 240)}` : '',
    '',
    '## 回答要求',
    '- 用中文，紧贴上面这段原文，不要泛泛介绍整个主题',
    '- 先给结论，再给理由；不要重复用户的提问',
    '- 涉及代码时只给能说明问题的最小片段，不要整段贴源码',
    '- 不确定的地方直接说不确定，不要编造',
  ];

  if (readingParagraph) {
    // 只作为"读者现在看到哪"的弱信号，且明确要求不要主动提起，
    // 否则模型会在回答里莫名其妙插一句"你现在读到哪"
    lines.push(`- （参考）读者视线大致在这一段：${truncate(readingParagraph, 160)}。不要主动提及这个信息。`);
  }

  return lines.filter(Boolean).join('\n');
}

/** 早期消息的规则摘要：不调模型，成本为零，可读性够用。 */
function buildRuleSummary(dropped: ChatMessage[]): string {
  const lines = dropped.slice(-8).map((message) => {
    const firstSentence = message.content.replace(/\s+/g, ' ').split(/[。！？.!?]/)[0] ?? '';
    const role = message.role === 'user' ? '问' : '答';
    return `- ${role}：${firstSentence.slice(0, 80)}`;
  });

  return truncate(lines.join('\n'), CONTEXT_BUDGET.summary);
}

interface BuiltContext {
  messages: PromptMessage[];
  compressed: boolean;
}

export function buildContext(conversation: Conversation, history: ChatMessage[], request: ChatRequest): BuiltContext {
  // 只处理"还没进摘要"的那部分。已经压缩过的消息不再逐条塞进上下文，
  // 否则压缩就白做了 —— token 该省的地方必须真的省下来。
  const effective = history.slice(conversation.compressedCount ?? 0);
  const recent = pickRecentWindow(effective, CONTEXT_BUDGET.maxRecentTurns);

  // 从最近往回累加，超出预算就停。注意是按"整轮"回退，
  // 只留回答却丢掉对应提问会让模型完全误读上下文。
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const message = recent[i];
    if (message.role === 'system') continue;
    const cost = message.content.length;
    if (kept.length > 0 && used + cost > CONTEXT_BUDGET.recentMessages) break;
    used += cost;
    kept.unshift(message);
  }

  const keptIds = new Set(kept.map((message) => message.id));
  const dropped = effective.filter((message) => !keptIds.has(message.id));

  const messages: PromptMessage[] = [
    { role: 'system', content: buildSystemPrompt(conversation.anchor, request.readingParagraph) },
  ];

  // 优先用模型压缩出的摘要；没有时退到规则摘要（真实模型不可用时的兜底）
  const summary = conversation.summary ?? (dropped.length > 0 ? buildRuleSummary(dropped) : null);
  if (summary) {
    messages.push({ role: 'system', content: `## 更早的讨论（已压缩，仅供参考）\n${summary}` });
  }

  for (const message of kept) {
    if (message.status === 'error') continue;
    messages.push({ role: message.role, content: message.content });
  }

  messages.push({ role: 'user', content: request.question });

  return { messages, compressed: dropped.length > 0 };
}

/**
 * 按需压缩历史。
 *
 * 触发条件：未压缩的消息超过"保留窗口"的两倍才开始压，
 * 避免对话才三四轮就调一次模型，白白多花钱。
 */
async function ensureSummary(
  conversation: Conversation,
  history: ChatMessage[],
  settings: Awaited<ReturnType<typeof getSettings>>,
): Promise<Conversation> {
  const already = conversation.compressedCount ?? 0;
  const pending = history.slice(already);
  const keep = keepRecentCount();

  // 攒够两倍窗口才压一次，压完至少还能留一整窗的原文
  if (pending.length <= keep * 2) return conversation;

  const toCompress = pending.slice(0, pending.length - keep);
  const summary = await composeSummary(conversation.summary, toCompress, settings);
  if (!summary) return conversation;

  const compressedCount = already + toCompress.length;
  await touchConversation(conversation.id, { summary, compressedCount });

  return { ...conversation, summary, compressedCount };
}

export type EmitEvent =
  | StreamEvent
  /** 要求 content script 执行工具；和流式事件共用同一条通道 */
  | { type: 'tool'; callId: string; name: string; args: Record<string, unknown> };

export type Emit = (event: EmitEvent) => void;

/**
 * 等待 content script 回传的工具结果。
 * 工具必须在页面里跑（要读 DOM），而 Agent 循环在 background，
 * 所以这里用一张 Promise 表把异步往返接成同步语义。
 */
const pendingTools = new Map<string, (value: unknown) => void>();

export function resolveToolResult(callId: string, result: unknown): void {
  const settle = pendingTools.get(callId);
  if (!settle) return;
  pendingTools.delete(callId);
  settle(result);
}

function callContentTool(emit: Emit, name: string, args: Record<string, unknown>): Promise<unknown> {
  const callId = `tool_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTools.delete(callId);
      reject(new Error('工具执行超时，页面可能正在切换'));
    }, 8000);

    pendingTools.set(callId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });

    emit({ type: 'tool', callId, name, args });
  });
}

export async function startChat(request: ChatRequest, emit: Emit): Promise<void> {
  const settings = await getSettings();

  let conversation = request.conversationId ? await getConversation(request.conversationId) : null;
  const isNew = conversation === null;
  if (!conversation) {
    conversation = await createConversation(request.anchor);
  }

  const history = await listMessages(conversation.id);

  // 重新生成：删掉最后一条回答再重跑，不额外插入一条重复的用户消息，
  // 否则历史里会出现"同一个问题问了两遍、答案两条"的脏数据。
  if (request.regenerate) {
    const lastAssistant = [...history].reverse().find((item) => item.role === 'assistant');
    if (lastAssistant) {
      await deleteMessage(lastAssistant.id);
      const index = history.findIndex((item) => item.id === lastAssistant.id);
      if (index >= 0) history.splice(index, 1);
    }
  } else {
    const userMessage: ChatMessage = {
      id: newId(),
      conversationId: conversation.id,
      role: 'user',
      content: request.question,
      status: 'done',
      createdAt: Date.now(),
    };
    await appendMessage(userMessage);
  }

  const assistantId = newId();
  const assistantMessage: ChatMessage = {
    id: assistantId,
    conversationId: conversation.id,
    role: 'assistant',
    content: '',
    status: 'streaming',
    createdAt: Date.now() + 1,
    model: settings.provider === 'demo' ? DEMO_MODEL : settings.model,
  };

  // 先把 id 和会话信息发回去，前端才能立刻挂上一条"正在生成"的消息
  emit({ type: 'start', messageId: assistantId, conversationId: conversation.id, conversation });
  await appendMessage(assistantMessage);

  const modelName = settings.provider === 'demo' ? DEMO_MODEL : settings.model;
  const memoKey = cacheKey(conversation.anchor, modelName);
  const cacheable = isNew && request.question === EXPLAIN_QUESTION && settings.provider !== 'demo';

  // 命中缓存：直接按流式回放，不产生任何 API 调用
  if (cacheable) {
    const cached = await getCachedAnswer(memoKey);
    if (cached) {
      await replayCached(cached, assistantId, emit, conversation.id);
      return;
    }
  }

  // 先把可能超长的历史压一遍，再组装上下文
  conversation = await ensureSummary(conversation, history, settings);
  const { messages } = buildContext(conversation, history, request);

  const controller = new AbortController();
  activeRuns.set(conversation.id, controller);

  let buffer = '';
  try {
    const common = {
      messages,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      signal: controller.signal,
      onDelta: (text: string) => {
        buffer += text;
        emit({ type: 'delta', messageId: assistantId, text });
      },
    };

    if (settings.provider === 'demo') {
      // 演示模式没有真实模型，工具调用无从谈起
      await streamDemo({
        ...common,
        demo: {
          anchor: conversation.anchor,
          question: request.question,
          turn: history.length + 1,
        },
      });
    } else {
      // 工具分两类：文章检索必须在页面里跑（读 DOM），
      // 联网搜索必须在 background 跑（页面上下文受 CORS 限制）
      const tools: unknown[] = [...ARTICLE_TOOLS];
      const searchReady = settings.webSearchEnabled && settings.webSearchApiKey.trim().length > 0;
      if (searchReady) tools.push(WEB_SEARCH_TOOL);

      await streamWithTools({
        ...common,
        tools,
        onToolStart: (name, args) => {
          emit({ type: 'tool-status', messageId: assistantId, label: describeToolCall(name, args) });
        },
        onToolCall: (name, args) => {
          if (name === 'web_search') {
            return webSearch(String(args.query ?? ''), {
              apiKey: settings.webSearchApiKey,
              maxResults: settings.webSearchResults,
              signal: controller.signal,
            });
          }
          return callContentTool(emit, name, args);
        },
      });
    }

    await updateMessage(assistantId, { content: buffer, status: 'done' });
    emit({ type: 'done', messageId: assistantId, content: buffer });

    if (cacheable && buffer.trim()) {
      await setCachedAnswer(memoKey, buffer);
    }
  } catch (error) {
    if (isAbortError(error)) {
      // 停止生成也保留已经吐出来的部分，用户能接着读，不用从头再问
      await updateMessage(assistantId, { content: buffer, status: 'stopped' });
      emit({ type: 'stopped', messageId: assistantId });
    } else {
      const message = error instanceof Error ? error.message : '生成失败';
      await updateMessage(assistantId, { content: buffer, status: 'error', error: message });
      emit({ type: 'error', messageId: assistantId, message });
    }
  } finally {
    activeRuns.delete(conversation.id);
    await touchConversation(conversation.id, { messageCount: history.length + 2 });
  }
}

async function replayCached(content: string, messageId: string, emit: Emit, conversationId: string): Promise<void> {
  const step = 24;
  for (let i = 0; i < content.length; i += step) {
    emit({ type: 'delta', messageId, text: content.slice(i, i + step) });
    await new Promise((resolve) => setTimeout(resolve, 12));
  }
  await updateMessage(messageId, { content, status: 'done' });
  emit({ type: 'done', messageId, content });
  await touchConversation(conversationId, {});
}

export function stopChat(conversationId: string): void {
  activeRuns.get(conversationId)?.abort();
}
