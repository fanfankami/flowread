/**
 * Content Script 入口。
 *
 * 职责边界很窄：挂载一个经过 Shadow DOM 隔离的 Vue 应用，然后把
 * "当前节点是否属于我们自己的 UI" 这个判断能力、以及"外部要求展开浮窗"的信号注入给组件。
 *
 * 注意这里**不做任何自动显示**：浮窗默认不存在于页面上，
 * 只有用户划词、点气泡或从扩展图标主动唤出时才会出现。
 */
import { createApp, ref } from 'vue';
import { createShadowRootUi, defineContentScript } from '#imports';
import FloatingPanel from '@/components/FloatingPanel.vue';
import '@/assets/inter.css';
import '@/assets/panel.css';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main(ctx) {
    // 用计数器而不是布尔值：用户可能连续点多次"打开"，
    // 每次都要能重新触发一轮（比如关掉之后又点了一次）。
    const showSignal = ref(0);

    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const payload = message as { type?: string } | undefined;

      // 必须显式响应。不响应的话 sendMessage 的 Promise 会走 reject，
      // 调用方只能看到一个笼统的失败，分不清"脚本没加载"和"其他错误"。
      if (payload?.type === 'flowread:ping') {
        sendResponse({ ok: true });
        return false;
      }

      if (payload?.type === 'flowread:show') {
        showSignal.value += 1;
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });

    const ui = await createShadowRootUi(ctx, {
      name: 'flowread-root',
      // 用 inline 而不是 overlay：overlay 会插入一个铺满视口的容器，
      // 稍不注意就会挡住页面点击。
      position: 'inline',
      anchor: 'body',
      onMount(container, shadow, shadowHost) {
        shadowHost.id = 'flowread-root';
        const app = createApp(FloatingPanel);

        // Chrome 对 shadow tree 内的 Selection 存在 retargeting 行为，
        // anchorNode 有时会报成宿主元素本身，两个条件缺一不可。
        app.provide('flowread:isOwnNode', (node: Node) => node === shadowHost || shadow.contains(node));
        app.provide('flowread:showSignal', showSignal);

        app.mount(container);
        return app;
      },
      onRemove(app) {
        app?.unmount();
      },
    });

    ui.mount();

    /**
     * 扩展被卸载或禁用时，把自己从页面上彻底抹掉。
     *
     * Chrome 会销毁 content script 的 JS 上下文，但**不会**清理它注入的 DOM ——
     * 于是 <flowread-root> 会一直挂在 body 上，用户卸载完扩展仍能看到浮窗和气泡。
     * 页面不刷新的话，这东西会待到下次刷新为止。
     */
    function teardown(): void {
      try {
        ui.remove();
      } catch {
        // 上下文已失效时 remove 可能失败，直接动 DOM 兜底
        document.getElementById('flowread-root')?.remove();
      }
      document.getElementById('flowread-highlight-style')?.remove();
      document.querySelectorAll('style[data-flowread-lock]').forEach((el) => el.remove());
    }

    // WXT 提供的失效钩子：扩展被禁用/更新时会触发
    ctx.onInvalidated(teardown);

    /**
     * 兜底轮询。onInvalidated 并不总能跑到（比如强制卸载），
     * 所以额外探一次 chrome.runtime.id —— 上下文失效后访问它会抛异常。
     */
    const livenessTimer = window.setInterval(() => {
      try {
        if (!chrome.runtime?.id) throw new Error('invalidated');
      } catch {
        window.clearInterval(livenessTimer);
        teardown();
      }
    }, 1500);

    ctx.onInvalidated(() => window.clearInterval(livenessTimer));
  },
});
