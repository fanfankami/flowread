<script setup lang="ts">
/**
 * 选区旁的操作气泡。
 *
 * 只给一个"解释"很浪费：选中术语想翻译、选中长段想总结，都得自己敲字。
 * 参考 ChatGPTBox 的做法，把高频意图直接做成按钮。
 */
import { computed } from 'vue';
import { SELECTION_ACTIONS } from '@/shared/constants';
import type { CustomAction } from '@/types';

const props = defineProps<{
  rect: { left: number; top: number; right: number; bottom: number } | null;
  busy: boolean;
  /** 用户自定义的动作，接在内置动作后面 */
  customActions?: CustomAction[];
}>();

const emit = defineEmits<{ action: [prompt: string]; ask: []; dismiss: [] }>();

const style = computed(() => {
  const rect = props.rect;
  if (!rect) return { display: 'none' };

  const centerX = (rect.left + rect.right) / 2;
  // 气泡宽度随按钮数量变化，按最宽情形留边距，避免贴边被裁
  const buttons = 3 + (props.customActions?.length ?? 0) + 2;
  const half = Math.min(210, 40 * buttons + 30);
  const left = Math.max(half, Math.min(centerX, window.innerWidth - half));

  const placeAbove = rect.top > 58;
  const top = placeAbove ? rect.top - 46 : rect.bottom + 10;

  return {
    left: `${left}px`,
    top: `${Math.max(8, top)}px`,
    transform: 'translateX(-50%)',
  };
});
</script>

<template>
  <div class="fr-pill" :style="style" @pointerdown.stop @mousedown.stop>
    <button
      v-for="(action, index) in SELECTION_ACTIONS"
      :key="action.id"
      class="fr-pill-btn"
      :class="{ 'is-primary': index === 0 }"
      type="button"
      :disabled="busy"
      @click="emit('action', action.prompt)"
    >
      {{ action.label }}
    </button>

    <button
      v-for="action in props.customActions ?? []"
      :key="action.id"
      class="fr-pill-btn is-custom"
      type="button"
      :disabled="busy"
      :title="action.prompt"
      @click="emit('action', action.prompt)"
    >
      {{ action.label }}
    </button>

    <span class="fr-pill-sep" aria-hidden="true"></span>

    <button class="fr-pill-btn" type="button" :disabled="busy" @click="emit('ask')">追问</button>

    <button class="fr-pill-close" type="button" title="收起" @click="emit('dismiss')">
      <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
        <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
      </svg>
    </button>
  </div>
</template>
