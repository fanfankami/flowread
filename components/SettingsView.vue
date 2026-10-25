<script setup lang="ts">
/**
 * 模型配置。
 *
 * 两个必须让用户看见的事实：
 * 1. Key 存在本地浏览器的扩展存储里，没有加密，也没有上传到任何服务器
 * 2. 演示模式不消耗任何额度，但也不会真的分析你的文章
 */
import { computed, ref, watch } from 'vue';
import { ACCENT_OPTIONS, FONT_OPTIONS, FONT_SIZE_OPTIONS, PROVIDER_PRESETS } from '@/shared/constants';
import type { AccentId, AppSettings, FontFamilyId, FontSizeId, ProviderId, PublicSettings } from '@/types';
import { backgroundClient } from '@/composables/useBackground';

const props = defineProps<{ settings: PublicSettings; showClose?: boolean; inPanel?: boolean }>();
const emit = defineEmits<{ close: []; updated: [settings: PublicSettings] }>();

const provider = ref<ProviderId>(props.settings.provider);
const baseUrl = ref(props.settings.baseUrl);
const model = ref(props.settings.model);
const apiKeyInput = ref('');
const temperature = ref(props.settings.temperature);
const maxTokens = ref(props.settings.maxTokens);
const autoExplain = ref(props.settings.autoExplain);
const minLength = ref(props.settings.minSelectionLength);
const follow = ref(props.settings.followReadingPosition);

// 外观：这三项改动即时生效，不需要点保存
const accent = ref<AccentId>(props.settings.accent);
const fontFamily = ref<FontFamilyId>(props.settings.fontFamily);
const fontSize = ref<FontSizeId>(props.settings.fontSize);

const busy = ref(false);
const status = ref('');
const statusIsError = ref(false);

/** 外观改动立刻落盘，这样用户能在浮窗里马上看到效果 */
async function saveAppearance(): Promise<void> {
  try {
    const next = await backgroundClient.send<PublicSettings>({
      type: 'settings:save',
      patch: { accent: accent.value, fontFamily: fontFamily.value, fontSize: fontSize.value },
    });
    emit('updated', next);
  } catch {
    // 外观保存失败不阻塞主流程，用户重新点保存即可
  }
}

watch([accent, fontFamily, fontSize], () => {
  void saveAppearance();
});

const isDemo = computed(() => provider.value === 'demo');
const keyHint = computed(() => (props.settings.hasApiKey ? '已保存，留空表示不修改' : '粘贴你的 API Key'));

// 切换服务商时把地址和模型带过去，省得用户自己查
watch(provider, (value) => {
  const preset = PROVIDER_PRESETS[value];
  if (!preset || value === 'custom') return;
  baseUrl.value = preset.baseUrl;
  model.value = preset.model;
});

function setProvider(id: string): void {
  provider.value = id as ProviderId;
}

function openFullSettings(): void {
  void chrome.runtime.openOptionsPage();
}

function setStatus(message: string, isError = false): void {
  status.value = message;
  statusIsError.value = isError;
}

/**
 * 自定义服务商需要在运行时申请域名权限。
 *
 * MV3 里 fetch 跨域受 host_permissions 约束，而用户填的地址无法提前声明。
 * 这里必须在 options 页里调用（content script 无权访问 chrome.permissions），
 * 而且要在用户点击的同一个交互里发起，否则 Chrome 会拒绝弹授权框。
 */
async function ensureOriginPermission(url: string): Promise<boolean> {
  try {
    const origin = new URL(url).origin;
    if (!/^https?:$/.test(new URL(url).protocol)) return false;
    const pattern = `${origin}/*`;

    // content script 里 Chrome 只暴露 storage / runtime / i18n，
    // chrome.permissions 是 undefined。这里不能硬调，否则整个保存流程会崩。
    if (typeof chrome.permissions === 'undefined') {
      setStatus('配置已保存。自定义地址需要在完整设置页里授权一次才能请求', true);
      return true;
    }

    const already = await chrome.permissions.contains({ origins: [pattern] });
    if (already) return true;
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

async function save(): Promise<PublicSettings | null> {
  // 真实服务商才需要网络权限；演示模式不发请求
  if (provider.value !== 'demo' && baseUrl.value.trim()) {
    const granted = await ensureOriginPermission(baseUrl.value.trim());
    if (!granted) {
      setStatus('没有获得访问该域名的权限，请求会被浏览器拦截', true);
      return null;
    }
  }

  const patch: Partial<AppSettings> = {
    provider: provider.value,
    baseUrl: baseUrl.value.trim(),
    model: model.value.trim(),
    temperature: Number(temperature.value),
    maxTokens: Number(maxTokens.value),
    autoExplain: autoExplain.value,
    minSelectionLength: Number(minLength.value),
    followReadingPosition: follow.value,
    accent: accent.value,
    fontFamily: fontFamily.value,
    fontSize: fontSize.value,
  };

  // 留空表示"不改动"，避免用户只想改温度却把 Key 清空了
  if (apiKeyInput.value.trim()) patch.apiKey = apiKeyInput.value.trim();

  try {
    const next = await backgroundClient.send<PublicSettings>({ type: 'settings:save', patch });
    apiKeyInput.value = '';
    emit('updated', next);
    setStatus('已保存');
    return next;
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '保存失败', true);
    return null;
  }
}

async function test(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  setStatus('正在测试…');

  try {
    const saved = await save();
    if (!saved) return;
    if (!saved.hasApiKey) {
      setStatus('还没有填 API Key', true);
      return;
    }
    const message = await backgroundClient.send<string>({ type: 'settings:test' });
    setStatus(message);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '测试失败', true);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="fr-settings">
    <section class="fr-field">
      <label class="fr-label">服务商</label>
      <div class="fr-segmented">
        <button
          v-for="(preset, id) in PROVIDER_PRESETS"
          :key="id"
          type="button"
          class="fr-seg"
          :class="{ 'is-active': provider === id }"
          @click="setProvider(String(id))"
        >
          {{ preset.label }}
        </button>
      </div>
    </section>


    <section class="fr-field">
      <label class="fr-label">外观 · 即时生效</label>

      <div class="fr-swatches">
        <button
          v-for="option in ACCENT_OPTIONS"
          :key="option.id"
          type="button"
          class="fr-swatch"
          :class="{ 'is-active': accent === option.id }"
          :style="{ '--swatch-color': option.color }"
          :title="option.label"
          @click="accent = option.id"
        ></button>
      </div>

      <div class="fr-segmented">
        <button
          v-for="option in FONT_OPTIONS"
          :key="option.id"
          type="button"
          class="fr-seg"
          :class="{ 'is-active': fontFamily === option.id }"
          :title="option.hint"
          @click="fontFamily = option.id"
        >
          {{ option.label }}
        </button>
      </div>

      <div class="fr-segmented">
        <button
          v-for="option in FONT_SIZE_OPTIONS"
          :key="option.id"
          type="button"
          class="fr-seg"
          :class="{ 'is-active': fontSize === option.id }"
          @click="fontSize = option.id"
        >
          {{ option.label }}
        </button>
      </div>
    </section>

    <template v-if="!isDemo">
      <section class="fr-field">
        <label class="fr-label">Base URL</label>
        <input v-model="baseUrl" class="fr-input-line" type="text" placeholder="https://api.deepseek.com" spellcheck="false" />
        <p class="fr-help">填到域名或 /v1 为止，程序会自动拼 /chat/completions</p>
      </section>

      <section class="fr-field">
        <label class="fr-label">API Key</label>
        <input v-model="apiKeyInput" class="fr-input-line" type="password" :placeholder="keyHint" spellcheck="false" autocomplete="off" />
        <p class="fr-help">只保存在本机扩展存储中，不经过任何第三方服务器，但也**没有加密**</p>
      </section>

      <section class="fr-field">
        <label class="fr-label">模型 ID</label>
        <input v-model="model" class="fr-input-line" type="text" placeholder="deepseek-chat" spellcheck="false" />
      </section>

      <div class="fr-row">
        <section class="fr-field fr-field-half">
          <label class="fr-label">温度 {{ Number(temperature).toFixed(1) }}</label>
          <input v-model.number="temperature" class="fr-range" type="range" min="0" max="1.5" step="0.1" />
        </section>
        <section class="fr-field fr-field-half">
          <label class="fr-label">最大输出</label>
          <input v-model.number="maxTokens" class="fr-input-line" type="number" min="256" max="8192" step="128" />
        </section>
      </div>
    </template>

    <p v-else class="fr-demo-note">
      演示模式使用内置的固定回复，用来展示排版、流式输出与多轮对话的交互形态，<strong>不会真的分析你选中的内容</strong>，也不会产生任何费用。
    </p>

    <section class="fr-field">
      <label class="fr-toggle">
        <input v-model="autoExplain" type="checkbox" />
        <span>选中后直接解释（关闭时先出气泡，点一下才请求）</span>
      </label>
      <label class="fr-toggle">
        <input v-model="follow" type="checkbox" />
        <span>自动跟随阅读位置</span>
      </label>
    </section>

    <section class="fr-field">
      <label class="fr-label">最短选区长度 {{ minLength }} 字</label>
      <input v-model.number="minLength" class="fr-range" type="range" min="2" max="20" step="1" />
    </section>

    <p v-if="status" class="fr-status" :class="{ 'is-error': statusIsError }">{{ status }}</p>

    <div class="fr-settings-actions">
      <button class="fr-btn fr-btn-primary" type="button" :disabled="busy" @click="save">保存</button>
      <button v-if="!isDemo" class="fr-btn" type="button" :disabled="busy" @click="test">测试连接</button>
      <button v-if="showClose" class="fr-btn" type="button" @click="emit('close')">返回</button>
      <button
        v-if="inPanel"
        class="fr-btn fr-settings-more"
        type="button"
        title="自定义服务商地址需要在那里授权域名"
        @click="openFullSettings"
      >
        完整设置页
      </button>
    </div>
  </div>
</template>
