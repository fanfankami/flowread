/** 模型服务商的统一接口。所有 provider 都只暴露一个流式函数。 */
import type { Anchor, Role } from '@/types';

export interface PromptMessage {
  role: Role;
  content: string;
}

export interface StreamParams {
  messages: PromptMessage[];
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  signal: AbortSignal;
  onDelta: (text: string) => void;
  /** 演示模式需要的元信息，真实 provider 会忽略 */
  demo?: {
    anchor: Anchor;
    question: string;
    turn: number;
  };
}

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}
