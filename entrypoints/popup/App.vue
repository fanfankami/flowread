<script lang="ts" setup>
/**
 * 扩展弹窗：只做三件事 —— 说明当前状态、给一个打开设置的入口、提供一个复位逃生口。
 * 真正的设置项在 options 页，因为只有扩展页面才能申请自定义域名的运行时权限。
 */
import { computed, onMounted, ref } from 'vue';
import { backgroundClient } from '@/composables/useBackground';
import type { PublicSettings } from '@/types';

const settings = ref<PublicSettings | null>(null);
const message = ref('');

const statusTag = computed(() => {
  const current = settings.value;
  if (!current) return '…';
  if (current.provider === 'demo') return '演示';
  // 选了 DeepSeek 但没填 Key 时不能显示"已接入"，
  // 否则用户会以为能用了，实际一请求就 401
  if (!current.hasApiKey) return '缺 Key';
  return '已接入';
});

const statusTitle = computed(() => {
  const current = settings.value;
  if (!current) return '';
  if (current.provider === 'demo') return '当前使用内置演示回复，不消耗额度';
  if (!current.hasApiKey) return '已经选了服务商，但还没填 API Key';
  return '已连接真实模型，会消耗对应额度';
});

function openOptions(): void {
  void chrome.runtime.openOptionsPage();
}

/** 探一下目标页面里有没有活着的 content script */
async function isContentScriptAlive(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'flowread:ping' });
    return Boolean((response as { ok?: boolean } | undefined)?.ok);
  } catch {
    return false;
  }
}

/** 在当前标签页展开浮窗。这是用户"主动启动"的主要入口。 */
async function openPanel(): Promise<void> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    message.value = '取不到当前标签页，换一个网页再试';
    return;
  }

  if (!tab?.id) {
    message.value = '取不到当前标签页，换一个网页再试';
    return;
  }

  // 先探测再发送：这样能把"页面需要刷新"和"发送失败"两种情况分开，
  // 否则一律报"页面不支持"，用户会以为插件坏了。
  if (!(await isContentScriptAlive(tab.id))) {
    message.value = '这个页面还没加载 FlowRead —— 扩展刚安装或刚更新过时，已打开的页面需要按 F5 刷新才会注入。刷新后重试即可。（浏览器内置页面如 chrome:// 则始终无法使用）';
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'flowread:show' });
    window.close();
  } catch {
    message.value = '唤醒失败，请刷新页面后重试';
  }
}

function resetLayout(): void {
  chrome.storage.local.remove(['flowread:layout', 'flowread:sites'], () => {
    message.value = '已复位：浮窗回到默认位置，所有站点恢复为"不自动显示"';
  });
}

onMounted(async () => {
  try {
    settings.value = await backgroundClient.send<PublicSettings>({ type: 'settings:get' });
  } catch {
    message.value = '读取状态失败，请刷新页面重试';
  }
});
</script>

<template>
  <div class="wrap">
    <header class="head">
      <span class="dot"></span>
      <h1>FlowRead</h1>
      <span class="tag" :title="statusTitle">{{ statusTag }}</span>
    </header>

    <p class="desc">选中网页文字，点气泡里的「解释」；或点下面的按钮唤出完整浮窗。</p>

    <button class="btn btn-primary" type="button" @click="openPanel">在本页打开浮窗</button>

    <ul class="list">
      <li>模型：<b>{{ settings?.provider === 'demo' ? '内置演示（无需 Key）' : settings?.model || '未配置' }}</b></li>
      <li>自动解释：<b>{{ settings?.autoExplain ? '开' : '关（先出气泡）' }}</b></li>
      <li>阅读跟随：<b>{{ settings?.followReadingPosition ? '开' : '关' }}</b></li>
    </ul>

    <button class="btn" type="button" @click="openOptions">打开设置</button>
    <button class="btn" type="button" @click="resetLayout">复位浮窗位置</button>

    <p v-if="message" class="msg">{{ message }}</p>
  </div>
</template>

<style scoped>
.wrap {
  width: 268px;
  padding: 14px 16px 16px;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  font-size: 13px;
  line-height: 1.6;
  color: #1c1c1e;
  background: #ffffff;
}

.head {
  display: flex;
  align-items: center;
  gap: 7px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #3b6ef5;
}

h1 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.tag {
  font-size: 10px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  color: #63636b;
  border: 1px solid rgba(16, 18, 27, 0.12);
}

.desc {
  margin: 7px 0 10px;
  color: #63636b;
  font-size: 12px;
}

.list {
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
  font-size: 11.5px;
  color: #63636b;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.list b {
  color: #1c1c1e;
  font-weight: 500;
}

.btn {
  width: 100%;
  margin-bottom: 6px;
  padding: 7px 0;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  border-radius: 6px;
  border: 1px solid rgba(16, 18, 27, 0.16);
  background: #ffffff;
  color: #1c1c1e;
  cursor: pointer;
}

.btn:hover {
  background: #f6f7f9;
}

.btn-primary {
  background: #3b6ef5;
  border-color: #3b6ef5;
  color: #ffffff;
}

.btn-primary:hover {
  background: #3461dd;
}

.msg {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: #3b6ef5;
}

@media (prefers-color-scheme: dark) {
  .wrap {
    background: #1e1f22;
    color: #ececf1;
  }

  .desc,
  .list {
    color: #a8a8b3;
  }

  .list b {
    color: #ececf1;
  }

  .tag {
    color: #a8a8b3;
    border-color: rgba(255, 255, 255, 0.16);
  }

  .btn {
    background: #1e1f22;
    color: #ececf1;
    border-color: rgba(255, 255, 255, 0.18);
  }

  .btn:hover {
    background: #26272b;
  }

  .btn-primary {
    background: #6b93ff;
    border-color: #6b93ff;
    color: #0b1020;
  }
}
</style>
