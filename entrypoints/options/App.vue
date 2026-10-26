<script setup lang="ts">
/**
 * 设置页。
 *
 * 之所以独立成 options 页而不是塞进浮窗：
 * 自定义服务商需要在保存时调用 chrome.permissions.request 动态申请域名权限，
 * 而这个 API 只能在扩展自己的页面里调用 —— content script 无权访问。
 */
import { onMounted, ref } from 'vue';
import SettingsView from '@/components/SettingsView.vue';
import { backgroundClient } from '@/composables/useBackground';
import { useAppearance } from '@/composables/useAppearance';
import { DEFAULT_SETTINGS } from '@/shared/constants';
import type { PublicSettings } from '@/types';

const settings = ref<PublicSettings>({ ...DEFAULT_SETTINGS, hasApiKey: false });
const loading = ref(true);
const { attrs: appearanceAttrs } = useAppearance(settings);
const loadError = ref('');

onMounted(async () => {
  try {
    settings.value = await backgroundClient.send<PublicSettings>({ type: 'settings:get' });
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : '读取设置失败';
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div v-bind="appearanceAttrs" class="fr-scope opt-page">
    <header class="opt-head">
      <h1>FlowRead 设置</h1>
      <p class="opt-sub">
        这是一个本地优先的浏览器扩展：模型配置只保存在这台机器的浏览器里，
        不会上传到我们的服务器，也没有任何账号体系。
      </p>
    </header>

    <p v-if="loadError" class="opt-error">{{ loadError }}</p>
    <p v-else-if="loading" class="opt-loading">读取中…</p>

    <SettingsView v-else :settings="settings" :show-close="false" @updated="settings = $event" @close="() => undefined" />

    <footer class="opt-foot">
      <span>Key 保存在这台电脑的浏览器里，没有加密。能翻看你浏览器数据的人（比如共用这台电脑的人）也能拿到它。</span>
      <span>公用电脑上建议不要保存长期有效的 Key；卸载扩展时会一并删除。</span>
    </footer>
  </div>
</template>
