<script setup lang="ts">
/**
 * 对话视图：上下文条 + 消息列表 + 输入框。
 *
 * 上下文条是"上下文锁定"的可视化：它永远显示**本会话绑定的锚点**，
 * 而不是当前滚动位置。两者不同时，才出现"切到当前段落"的入口。
 */
import { computed, nextTick, ref, watch } from 'vue';
import MessageBubble from './MessageBubble.vue';
import type { Anchor, ChatMessage, ReadingContext } from '@/types';

const props = defineProps<{
  messages: ChatMessage[];
  streaming: boolean;
  anchor: Anchor | null;
  reading: ReadingContext | null;
  demoMode: boolean;
  errorMessage: string;
  /** 已被压缩进摘要的早期消息条数，0 表示没有压缩过 */
  compressedCount: number;
  /** Agent 正在执行工具时的动作描述，空串表示没有 */
  toolLabel?: string;
  /** 待发送的截图 data URL，null 表示没有 */
  pendingImage?: string | null;
}>();

const emit = defineEmits<{
  ask: [question: string];
  stop: [];
  regenerate: [];
  switchAnchor: [];
  summarize: [];
  capture: [];
  clearImage: [];
  locate: [];
  openSettings: [];
}>();

const draft = ref('');
const listEl = ref<HTMLElement | null>(null);
const inputEl = ref<HTMLTextAreaElement | null>(null);

const hasMessages = computed(() => props.messages.length > 0);

/**
 * 是否应该提示"切到当前段落"。
 *
 * 只在**章节变了**的时候提示。
 * 同一章节内滚到下一段是很正常的阅读动作，如果每段都亮起按钮，
 * 它会一直闪，反而变成噪音。用户真想换段落，重新划词就行。
 */
/**
 * 导出为 Markdown。
 *
 * 在 shadow DOM 里用 Blob + a[download] 是可行的，
 * 但 a 元素必须由我们创建且不被插入文档 —— 插进去会被页面样式影响。
 */
function exportMarkdown(): void {
  const current = props.anchor;
  if (!current) return;

  const title = (current.heading || current.text.slice(0, 30)).replace(/\s+/g, ' ').trim();
  const lines: string[] = [
    `# ${title}`,
    '',
    `> ${current.text.replace(/\n/g, ' ')}`,
    '',
    `来源：${current.pageTitle || current.url}`,
    '',
    '---',
    '',
  ];

  for (const message of props.messages) {
    if (message.role === 'user') {
      lines.push(`**问：** ${message.content.trim()}`, '');
      continue;
    }
    if (message.status === 'error') {
      lines.push(`> 生成失败：${message.error ?? ''}`, '');
      continue;
    }
    if (!message.content.trim()) continue;
    lines.push(message.content.trim(), '', '---', '');
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${title.slice(0, 24).replace(/[\\/:*?"<>|]/g, '_')}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

const anchorDrifted = computed(() => {
  const reading = props.reading;
  const anchor = props.anchor;
  if (!reading || !anchor) return false;
  if (!reading.heading || !anchor.heading) return false;
  return reading.heading !== anchor.heading;
});

const lastAssistant = computed(() => [...props.messages].reverse().find((m) => m.role === 'assistant') ?? null);

/**
 * 只在用户本来就贴着底部时才自动滚动。
 * 否则用户往上翻看历史时，会被新到的流式内容强行拽回底部。
 */
function scrollToBottom(force = false): void {
  const el = listEl.value;
  if (!el) return;
  const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (force || nearBottom) {
    el.scrollTop = el.scrollHeight;
  }
}

watch(
  () => props.messages.length,
  async () => {
    await nextTick();
    scrollToBottom(true);
  },
);

watch(
  () => lastAssistant.value?.content,
  async () => {
    await nextTick();
    scrollToBottom();
  },
);

/**
 * 回答结束后，如果这条回答比可视区还高，把它的**顶部**滚进视野。
 *
 * 否则流式输出会一路跟到底部，用户最后看到的是回答的结尾 ——
 * 对"解释这段话"这种一次性长回答来说，等于每次都要自己往回滚。
 */
function scrollToAnswerTop(): void {
  const last = lastAssistant.value;
  const list = listEl.value;
  if (!last || !list) return;

  const element = list.querySelector<HTMLElement>(`[data-mid="${last.id}"]`);
  if (!element) return;

  if (element.offsetHeight <= list.clientHeight * 0.7) return;

  const elementRect = element.getBoundingClientRect();
  const listRect = list.getBoundingClientRect();
  // 用 rect 差值而不是 offsetTop：offsetParent 未必是这个列表
  list.scrollTop += elementRect.top - listRect.top - 6;
}

watch(
  () => lastAssistant.value?.status,
  async (status) => {
    if (status !== 'done') return;
    await nextTick();
    scrollToAnswerTop();
  },
);

function submit(): void {
  const value = draft.value.trim();
  if (!value || props.streaming) return;
  emit('ask', value);
  draft.value = '';
  if (inputEl.value) inputEl.value.style.height = 'auto';
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
}

function autoGrow(): void {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
}

function focusInput(): void {
  inputEl.value?.focus();
}

defineExpose({ focusInput });
</script>

<template>
  <div class="fr-chat">
    <!-- 讨论对象卡片：这是"上下文在哪"的唯一答案，必须一直可见 -->
    <div v-if="anchor" class="fr-anchor">
      <div class="fr-anchor-head">
        <span class="fr-anchor-label">
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
            <path d="M3 3.5h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7.5L4.5 13v-2.5H3a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.3" fill="none" stroke-linejoin="round" />
          </svg>
          正在讨论
        </span>
        <div class="fr-anchor-tools">
          <button class="fr-anchor-locate" type="button" title="滚动到原文位置" @click="emit('locate')">
            回到原文
          </button>
          <button
            class="fr-anchor-locate"
            type="button"
            title="把这段对话导出为 Markdown 文件"
            @click="exportMarkdown"
          >
            导出
          </button>
        </div>
      </div>

      <p v-if="anchor.heading" class="fr-anchor-heading">{{ anchor.heading }}</p>
      <blockquote class="fr-anchor-quote">{{ anchor.text }}</blockquote>

      <p v-if="compressedCount > 0" class="fr-anchor-memo">
        前 {{ compressedCount }} 条早期对话已压缩为摘要，细节仍可在历史记录里回看
      </p>

      <div v-if="anchorDrifted" class="fr-anchor-drift">
        <span>你已经读到别的章节了</span>
        <button type="button" @click="emit('switchAnchor')">换成当前段落</button>
      </div>
    </div>

    <div ref="listEl" class="fr-list">
      <!-- Agent 工具状态：让用户知道它在查文章，而不是卡住了 -->
      <div v-if="toolLabel" class="fr-tool-status">
        <span class="fr-tool-dot" aria-hidden="true"></span>
        {{ toolLabel }}
      </div>

      <div v-if="!hasMessages" class="fr-welcome">
        <div class="fr-welcome-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20">
            <path d="M4 5.5h16M4 12h11M4 18.5h7" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none" />
          </svg>
        </div>
        <p class="fr-welcome-title">针对上面这段提问</p>
        <p class="fr-welcome-desc">直接在下面输入你的问题；也可以回到页面重新划词，用气泡里的「解释 / 翻译 / 总结」一键处理。</p>
        <button class="fr-welcome-link" type="button" @click="emit('summarize')">总结整篇文章</button>

        <button v-if="demoMode" class="fr-welcome-link" type="button" @click="emit('openSettings')">
          当前是演示模式，填入 API Key 使用真实模型
        </button>
      </div>

      <MessageBubble v-for="message in messages" :key="message.id" :message="message" />
    </div>

    <!-- 待发送的截图：让用户在发之前确认截的是哪块 -->
    <div v-if="pendingImage" class="fr-image-preview">
      <img :src="pendingImage" alt="待发送的截图" />
      <div class="fr-image-meta">
        <span>这张截图会随下一个问题一起发送</span>
        <button type="button" @click="emit('clearImage')">移除</button>
      </div>
    </div>

    <p v-if="errorMessage" class="fr-banner is-error">{{ errorMessage }}</p>

    <div class="fr-composer">
      <button
        class="fr-composer-btn"
        type="button"
        title="截取当前屏幕提问"
        :disabled="streaming"
        @click="emit('capture')"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M2.5 5.5h2l1-1.5h4l1 1.5h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round" />
          <circle cx="8" cy="9" r="2.3" stroke="currentColor" stroke-width="1.2" fill="none" />
        </svg>
      </button>

      <textarea
        ref="inputEl"
        v-model="draft"
        class="fr-input"
        rows="1"
        :placeholder="streaming ? '正在回答…' : '追问点什么，Enter 发送'"
        :disabled="streaming"
        @keydown="onKeydown"
        @input="autoGrow"
      ></textarea>

      <div class="fr-composer-actions">
        <button v-if="streaming" class="fr-icon-btn" type="button" title="停止生成" @click="emit('stop')">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          v-else-if="lastAssistant"
          class="fr-icon-btn"
          type="button"
          title="重新生成"
          @click="emit('regenerate')"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M13 8a5 5 0 1 1-1.6-3.7M13 3v3.5H9.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <button class="fr-send" type="button" :disabled="streaming || !draft.trim()" @click="submit">
          发送
        </button>
      </div>
    </div>
  </div>
</template>
