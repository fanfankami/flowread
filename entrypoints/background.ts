/**
 * Background Service Worker。
 *
 * 它是整个扩展唯一"可信"的地方：
 * - 持有 API Key（content script 只能拿到 hasApiKey 布尔值）
 * - 发起所有模型请求（不受页面 CORS 限制）
 * - 拥有 IndexedDB（数据挂在扩展 origin，页面脚本读不到）
 *
 * 用长连接 Port 而不是 sendMessage：流式回答需要持续推送，
 * 而且 Port 断开时能立刻察觉页面被关掉了。
 */
import { startChat, stopChat } from '@/background/engine';
import { clearAllConversations, deleteConversation, getConversation, listConversations, listMessages } from '@/background/db';
import { getSettings, saveSettings, toPublicSettings } from '@/background/settings';
import { testConnection } from '@/background/providers/openai';
import type { AppSettings, ChatRequest, ClientMessage, StreamEvent } from '@/types';

function post(port: chrome.runtime.Port, message: unknown): void {
  try {
    port.postMessage(message);
  } catch {
    // 端口已断开（页面刷新/关闭）。静默丢弃即可：
    // 此时 engine 仍会把结果写完进 IndexedDB，用户回到页面还能看到。
  }
}

async function handleMessage(port: chrome.runtime.Port, message: ClientMessage): Promise<void> {
  const { requestId } = message;

  const reply = (data?: unknown): void => {
    if (!requestId) return;
    post(port, { type: 'reply', requestId, ok: true, data });
  };
  const fail = (error: string): void => {
    if (!requestId) return;
    post(port, { type: 'reply', requestId, ok: false, error });
  };

  try {
    switch (message.type) {
      case 'settings:get': {
        reply(toPublicSettings(await getSettings()));
        return;
      }

      case 'settings:save': {
        const next = await saveSettings(message.patch as Partial<AppSettings>);
        reply(toPublicSettings(next));
        return;
      }

      case 'settings:test': {
        const settings = await getSettings();
        reply(
          await testConnection({
            apiKey: settings.apiKey,
            baseUrl: settings.baseUrl,
            model: settings.model,
          }),
        );
        return;
      }

      case 'chat:start': {
        const emit = (event: StreamEvent): void => post(port, { type: 'stream', event });
        // 刻意不 await：只有立即返回，端口才能继续接收 chat:stop，
        // 否则"停止生成"会在一次完整回答结束后才被处理。
        void startChat(message.payload as ChatRequest, emit).catch((error: unknown) => {
          emit({
            type: 'error',
            messageId: '',
            message: error instanceof Error ? error.message : '生成失败',
          });
        });
        reply(true);
        return;
      }

      case 'chat:stop': {
        stopChat(message.conversationId);
        reply(true);
        return;
      }

      case 'conversation:list': {
        reply(await listConversations(message.limit ?? 50));
        return;
      }

      case 'conversation:get': {
        const conversation = await getConversation(message.id);
        const messages = conversation ? await listMessages(message.id) : [];
        reply({ conversation, messages });
        return;
      }

      case 'conversation:delete': {
        await deleteConversation(message.id);
        reply(true);
        return;
      }

      case 'conversation:clearAll': {
        await clearAllConversations();
        reply(true);
        return;
      }

      default: {
        fail('未知的请求类型');
      }
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : '后台处理失败');
  }
}

export default defineBackground(() => {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'flowread') return;

    port.onMessage.addListener((message: ClientMessage) => {
      void handleMessage(port, message);
    });
  });

  // 首次安装后直接打开设置页。
  // 浮窗默认不出现在任何页面上，如果不给一个引导，用户会以为装失败了。
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
      void chrome.runtime.openOptionsPage();
    }
  });
});
