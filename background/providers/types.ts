/** 模型服务商的统一接口。 */
import type { Anchor } from '@/types';

/** 比 ChatMessage 多一个 tool：提示词里要能表达工具返回值 */
export type PromptRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** 图片内容块。只允许出现在 user 消息里 —— 放 system/assistant 会 400 */
export interface ImageBlock {
  type: 'image_url';
  image_url: { url: string };
}

export interface TextBlock {
  type: 'text';
  text: string;
}

export type ContentBlock = TextBlock | ImageBlock;

/**
 * 提示词消息。
 * assistant 可能同时带 content 和 tool_calls（模型先说"我查一下"再调工具），
 * tool 消息则必须带 tool_call_id 才能和请求对上。
 */
export type PromptMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentBlock[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallPayload[] }
  | { role: 'tool'; content: string; tool_call_id: string };

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
