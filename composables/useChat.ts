/**
 * 对话状态。
 *
 * 前端只做"乐观展示"：用户消息立刻上屏，AI 回答先插一条空气泡再逐字填充。
 * 真正的持久化全在 background，即使页面刷新，内容也已经写进扩展的 IndexedDB。
 */
import { computed, onUnmounted, ref } from 'vue';
import { EXPLAIN_QUESTION } from '@/shared/constants';
import type { Anchor, ChatMessage, ChatRequest, Conversation, StreamEvent } from '@/types';
import { backgroundClient } from './useBackground';

interface ConversationDetail {
  conversation: Conversation | null;
  messages: ChatMessage[];
}

export function useChat() {
  const messages = ref<ChatMessage[]>([]);
  const conversation = ref<Conversation | null>(null);
  const streaming = ref(false);
  const errorMessage = ref('');

  let tempSeq = 0;

  const canStop = computed(() => streaming.value && Boolean(conversation.value));
  const canRegenerate = computed(() => !streaming.value && messages.value.some((m) => m.role === 'assistant'));
  const lastUserMessage = computed(() => [...messages.value].reverse().find((m) => m.role === 'user') ?? null);

  function handleEvent(event: StreamEvent): void {
    switch (event.type) {
      case 'start': {
        conversation.value = event.conversation;
        // 后端生成了真正的消息 id，前端据此挂载空气泡
        messages.value.push({
          id: event.messageId,
          conversationId: event.conversationId,
          role: 'assistant',
          content: '',
          status: 'streaming',
          createdAt: Date.now(),
        });
        break;
      }

      case 'delta': {
        const target = messages.value.find((m) => m.id === event.messageId);
        if (target) target.content += event.text;
        break;
      }

      case 'done': {
        const target = messages.value.find((m) => m.id === event.messageId);
        if (target) {
          target.content = event.content;
          target.status = 'done';
        }
        streaming.value = false;
        break;
      }

      case 'stopped': {
        const target = messages.value.find((m) => m.id === event.messageId);
        if (target) target.status = 'stopped';
        streaming.value = false;
        break;
      }

      case 'error': {
        const target = messages.value.find((m) => m.id === event.messageId);
        if (target) {
          target.status = 'error';
          target.error = event.message;
        } else {
          errorMessage.value = event.message;
        }
        streaming.value = false;
        break;
      }

      default:
        break;
    }
  }

  const unsubscribe = backgroundClient.onStream(handleEvent);
  onUnmounted(unsubscribe);

  function pushLocalUser(content: string): void {
    messages.value.push({
      id: `local-${Date.now()}-${tempSeq++}`,
      conversationId: conversation.value?.id ?? '',
      role: 'user',
      content,
      status: 'done',
      createdAt: Date.now(),
    });
  }

  async function dispatch(question: string, anchor: Anchor, options: { regenerate?: boolean; readingParagraph?: string } = {}): Promise<void> {
    if (streaming.value) return;

    errorMessage.value = '';
    streaming.value = true;

    const payload: ChatRequest = {
      conversationId: conversation.value?.id ?? '',
      question,
      anchor,
      isNew: false,
      regenerate: options.regenerate,
      readingParagraph: options.readingParagraph,
    };

    try {
      await backgroundClient.send({ type: 'chat:start', payload });
    } catch (error) {
      streaming.value = false;
      errorMessage.value = error instanceof Error ? error.message : '发送失败';
    }
  }

  /**
   * 快捷动作（解释 / 翻译 / 总结）。
   * 传固定指令而不是让用户手打，后台也好按问题内容做缓存。
   */
  async function explain(anchor: Anchor, prompt: string = EXPLAIN_QUESTION, readingParagraph?: string): Promise<void> {
    if (streaming.value) return;
    pushLocalUser(prompt);
    await dispatch(prompt, anchor, { readingParagraph });
  }

  /** 点「追问」或在输入框发送：进入连续对话。 */
  async function ask(question: string, anchor: Anchor, readingParagraph?: string): Promise<void> {
    const trimmed = question.trim();
    if (!trimmed || streaming.value) return;

    // 会话已经存在时，锚点沿用会话里那一个（上下文锁定），
    // 只有第一轮才用当前选区创建会话。
    const effectiveAnchor = conversation.value?.anchor ?? anchor;
    pushLocalUser(trimmed);
    await dispatch(trimmed, effectiveAnchor, { readingParagraph });
  }

  async function stop(): Promise<void> {
    if (!conversation.value) return;
    try {
      await backgroundClient.send({ type: 'chat:stop', conversationId: conversation.value.id });
    } catch {
      streaming.value = false;
    }
  }

  async function regenerate(): Promise<void> {
    const last = lastUserMessage.value;
    if (!last || streaming.value) return;

    // 本地先移除上一条回答，避免"删掉又加回来"造成闪动
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      if (messages.value[i].role === 'assistant') {
        messages.value.splice(i, 1);
        break;
      }
    }

    streaming.value = true;
    await dispatch(last.content, conversation.value?.anchor ?? ({} as Anchor), { regenerate: true });
  }

  async function load(conversationId: string): Promise<void> {
    const detail = await backgroundClient.send<ConversationDetail>({ type: 'conversation:get', id: conversationId });
    conversation.value = detail.conversation;
    messages.value = detail.messages;
    errorMessage.value = '';
  }

  function reset(): void {
    messages.value = [];
    conversation.value = null;
    errorMessage.value = '';
    streaming.value = false;
  }

  return {
    messages,
    conversation,
    streaming,
    errorMessage,
    canStop,
    canRegenerate,
    lastUserMessage,
    explain,
    ask,
    stop,
    regenerate,
    load,
    reset,
  };
}
