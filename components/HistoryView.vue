<script setup lang="ts">
/**
 * 历史记录列表。
 *
 * 点击一条会话会回到对应的原文锚点 —— 但先做定位校验，
 * 找不到就明确告诉用户，而不是假装成功然后把页面滚到莫名其妙的位置。
 */
import { computed, onMounted, ref } from 'vue';
import type { Conversation } from '@/types';
import { locateAnchor, scrollToAnchor } from '@/utils/anchor';
import { backgroundClient } from '@/composables/useBackground';

const emit = defineEmits<{ close: []; open: [id: string] }>();

const items = ref<Conversation[]>([]);
const loading = ref(true);
const notice = ref('');

/** 历史搜索：标题、选中原文、章节、页面标题都要能命中 */
const keyword = ref('');

const filtered = computed(() => {
  const needle = keyword.value.trim().toLowerCase();
  if (!needle) return items.value;
  return items.value.filter((item) => {
    const haystack = [
      item.title,
      item.anchor.text,
      item.anchor.heading ?? '',
      item.pageTitle ?? '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(needle);
  });
});

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    items.value = await backgroundClient.send<Conversation[]>({ type: 'conversation:list', limit: 50 });
  } catch {
    notice.value = '读取历史失败';
  } finally {
    loading.value = false;
  }
}

async function remove(id: string): Promise<void> {
  try {
    await backgroundClient.send({ type: 'conversation:delete', id });
    items.value = items.value.filter((item) => item.id !== id);
  } catch {
    notice.value = '删除失败';
  }
}

async function clearAll(): Promise<void> {
  try {
    await backgroundClient.send({ type: 'conversation:clearAll' });
    items.value = [];
    notice.value = '已清空全部历史';
  } catch {
    notice.value = '清空失败';
  }
}

/** 回到原文：定位失败要说清楚，不要静默 */
function jumpToAnchor(conversation: Conversation): void {
  const result = locateAnchor(conversation.anchor);
  if (!result.ok) {
    notice.value = result.reason;
    return;
  }
  scrollToAnchor(result.element);
  notice.value = result.ok && !result.exact ? '原文有改动，已定位到最接近的段落' : '';
}

onMounted(refresh);
</script>

<template>
  <div class="fr-history">
    <div v-if="loading" class="fr-history-empty">读取中…</div>

    <div v-else-if="items.length === 0" class="fr-history-empty">
      还没有对话记录。选中一段文字，点「解释」就会出现在这里。
    </div>

    <template v-else>
      <ul class="fr-history-list">
        <li v-for="item in filtered" :key="item.id" class="fr-history-item">
          <button class="fr-history-main" type="button" @click="emit('open', item.id)">
            <span class="fr-history-title">{{ item.title }}</span>
            <span class="fr-history-sub">
              <span class="fr-history-page">{{ item.anchor.heading || item.pageTitle || item.url }}</span>
              <span class="fr-history-time">{{ formatTime(item.updatedAt) }}</span>
            </span>
          </button>
          <div class="fr-history-tools">
            <button type="button" title="回到原文" @click="jumpToAnchor(item)">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </button>
            <button type="button" title="删除" @click="remove(item.id)">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none" />
              </svg>
            </button>
          </div>
        </li>
      </ul>

      <button class="fr-history-clear" type="button" @click="clearAll">清空全部</button>
    </template>

    <p v-if="notice" class="fr-status">{{ notice }}</p>
  </div>
</template>
