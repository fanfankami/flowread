/**
 * content script 侧的 background 客户端。
 *
 * 用 Port 长连接而不是 chrome.runtime.sendMessage：
 * 流式回答需要服务端主动推送，sendMessage 是一次性请求-响应模型，
 * 拿不到中间态。
 *
 * MV3 的 service worker 会被回收，端口随时可能断开，
 * 因此每次发送前都要确认端口存活，断了就重连（并让调用方重试）。
 */
import type { ClientMessage, ServerMessage, StreamEvent } from '@/types';

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: number;
};

type StreamListener = (event: StreamEvent) => void;

/** background 要求执行一个工具；工具实现在页面侧（要读 DOM） */
type ToolCall = { callId: string; name: string; args: Record<string, unknown> };
type ToolHandler = (call: ToolCall) => Promise<unknown> | unknown;

class BackgroundClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<string, Pending>();
  private listeners = new Set<StreamListener>();
  private toolHandlers = new Set<ToolHandler>();
  private counter = 0;

  private ensurePort(): chrome.runtime.Port {
    if (this.port) return this.port;

    const port = chrome.runtime.connect({ name: 'flowread' });
    port.onMessage.addListener((message: ServerMessage) => this.handle(message));
    port.onDisconnect.addListener(() => {
      this.port = null;
      // 端口断开时把所有在途请求立刻失败，避免调用方一直等
      for (const [id, entry] of this.pending) {
        window.clearTimeout(entry.timer);
        entry.reject(new Error('与后台的连接已断开'));
        this.pending.delete(id);
      }
    });

    this.port = port;
    return port;
  }

  private handle(message: ServerMessage): void {
    if (message.type === 'tool') {
      void this.runTool(message);
      return;
    }

    if (message.type === 'stream') {
      for (const listener of this.listeners) listener(message.event);
      return;
    }

    if (message.type === 'reply') {
      const entry = this.pending.get(message.requestId);
      if (!entry) return;
      window.clearTimeout(entry.timer);
      this.pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.data);
      else entry.reject(new Error(message.error));
    }
  }

  /** 执行工具并把结果回传给 background。工具失败也要回传，否则那边只能等超时 */
  private async runTool(call: ToolCall): Promise<void> {
    let result: unknown = { error: '页面侧没有注册工具处理器' };

    for (const handler of this.toolHandlers) {
      try {
        result = await handler(call);
        break;
      } catch (error) {
        result = { error: error instanceof Error ? error.message : '工具执行失败' };
      }
    }

    try {
      await this.send({ type: 'tool:result', callId: call.callId, result }, 5000);
    } catch {
      // 回传失败就交给 background 侧的超时兜底
    }
  }

  /** 注册工具处理器。返回取消注册函数。 */
  onTool(handler: ToolHandler): () => void {
    this.toolHandlers.add(handler);
    return () => this.toolHandlers.delete(handler);
  }

  send<T>(message: ClientMessage, timeoutMs = 20000): Promise<T> {
    const port = this.ensurePort();
    const requestId = `req-${Date.now()}-${this.counter++}`;

    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('后台响应超时'));
      }, timeoutMs);

      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timer });
      port.postMessage({ ...message, requestId });
    });
  }

  /** 订阅流式事件。返回取消订阅函数。 */
  onStream(listener: StreamListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const backgroundClient = new BackgroundClient();
