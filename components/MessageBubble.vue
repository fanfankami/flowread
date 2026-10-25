<script setup lang="ts">
/**
 * 单条消息。
 *
 * assistant 的正文走自研 Markdown 渲染（已全量转义），user 的走纯文本，
 * 避免用户输入 "**粗体**" 被当成格式解析。
 */
import { computed } from 'vue';
import { renderMarkdown } from '@/shared/markdown';
import type { ChatMessage } from '@/types';

const props = defineProps<{ message: ChatMessage }>();

const html = computed(() => (props.message.role === 'assistant' ? renderMarkdown(props.message.content) : ''));
const isStreaming = computed(() => props.message.status === 'streaming');

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文（http）下 clipboard 不可用，退化成选中提示
  }
}

function copyWhole(): void {
  void writeClipboard(props.message.content);
}

/** 代码块复制走事件委托：v-html 里的按钮没法直接绑 Vue 事件。 */
function onMarkdownClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const button = target?.closest('[data-action="copy-code"]');
  if (!button) return;

  const code = button.closest('.fr-code')?.querySelector('code')?.textContent ?? '';
  void writeClipboard(code);
  button.textContent = '已复制';
  window.setTimeout(() => {
    button.textContent = '复制';
  }, 1200);
}
</script>

<template>
  <div class="fr-msg" :class="[`is-${message.role}`, { 'is-streaming': isStreaming }]" :data-mid="message.id">
    <div v-if="message.role === 'assistant'" class="fr-md" @click="onMarkdownClick" v-html="html"></div>
    <div v-else class="fr-user-text">{{ message.content }}</div>

    <p v-if="message.status === 'error'" class="fr-msg-error">
      {{ message.error || '生成失败' }}
    </p>

    <div class="fr-msg-foot">
      <span v-if="message.status === 'stopped'" class="fr-msg-tag">已停止</span>
      <button
        v-if="message.role === 'assistant' && !isStreaming && message.content"
        class="fr-msg-copy"
        type="button"
        @click="copyWhole"
      >
        复制
      </button>
    </div>
  </div>
</template>
