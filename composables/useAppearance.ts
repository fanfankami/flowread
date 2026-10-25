/**
 * 外观属性。
 *
 * 把用户设置翻译成两个 data 属性挂在根元素上，CSS 靠属性选择器切换：
 *   data-accent = mono | blue | green | amber | violet
 *   data-font   = misans | noto | deng | yahei | serif | mono
 *   data-size   = sm | md | lg | xl
 *
 * 深浅色只有浅色一套（深色已移除），所以不再需要 data-theme。
 */
import { computed, type Ref } from 'vue';
import type { PublicSettings } from '@/types';

export function useAppearance(settings: Ref<PublicSettings>) {
  const attrs = computed(() => ({
    'data-accent': settings.value.accent,
    'data-font': settings.value.fontFamily,
    'data-size': settings.value.fontSize,
  }));

  return { attrs };
}
