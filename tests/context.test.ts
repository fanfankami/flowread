import { describe, expect, it } from 'vitest';
import { buildContext } from '@/background/engine';
import type { Anchor, ChatMessage, ChatRequest, Conversation } from '@/types';

const anchor: Anchor = {
  text: '防重复的关键还是唯一约束。',
  paragraph: '防重复的关键还是唯一约束，后面两种写法都建立在前面的唯一索引基础上。',
  heading: '第一节 唯一约束',
  before: '前一段',
  after: '后一段',
  blockIndex: 2,
  url: 'https://example.com/a',
  pageTitle: '测试页',
};

function makeConversation(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: '测试会话',
    url: anchor.url,
    pageTitle: anchor.pageTitle,
    anchor,
    createdAt: 0,
    updatedAt: 0,
    summary: null,
    compressedCount: 0,
    messageCount: 0,
    ...patch,
  };
}

/** 生成 n 条消息，严格交替 user / assistant */
function makeHistory(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${i}`,
    conversationId: 'c1',
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `第${i}条消息的内容`,
    status: 'done' as const,
    createdAt: i,
  }));
}

const request: ChatRequest = {
  conversationId: 'c1',
  question: '这一轮的问题',
  anchor,
  isNew: false,
};

function texts(conversation: Conversation, history: ChatMessage[]): string[] {
  return buildContext(conversation, history, request).messages.map((m) => m.content ?? '');
}

describe('buildContext · 压缩游标', () => {
  it('会话刚开始时，全部消息都进入上下文', () => {
    const history = makeHistory(4);
    const contents = texts(makeConversation(), history);
    for (let i = 0; i < 4; i += 1) {
      expect(contents.some((c) => c.includes(`第${i}条消息`))).toBe(true);
    }
  });

  it('已压缩的消息不再逐条塞进上下文（否则压缩白做）', () => {
    const history = makeHistory(10);
    const contents = texts(makeConversation({ compressedCount: 6, summary: '早期结论：唯一约束是根本保障。' }), history);

    // 前 6 条应该只以摘要形式存在
    for (let i = 0; i < 6; i += 1) {
      expect(contents.some((c) => c.includes(`第${i}条消息`))).toBe(false);
    }
    // 后 4 条仍然逐条保留
    for (let i = 6; i < 10; i += 1) {
      expect(contents.some((c) => c.includes(`第${i}条消息`))).toBe(true);
    }
  });

  it('有摘要时会作为 system 消息插入，并标注已压缩', () => {
    const contents = texts(makeConversation({ compressedCount: 6, summary: '早期结论：唯一约束是根本保障。' }), makeHistory(10));
    const summaryMessage = contents.find((c) => c.includes('唯一约束是根本保障'));
    expect(summaryMessage).toBeDefined();
    expect(summaryMessage).toContain('已压缩');
  });

  it('锚点原文永远在第一条 system 消息里，不参与压缩', () => {
    const contents = texts(makeConversation({ compressedCount: 8, summary: '旧摘要' }), makeHistory(12));
    expect(contents[0]).toContain(anchor.text);
    expect(contents[0]).toContain(anchor.heading!);
  });

  it('本轮问题始终是最后一条消息', () => {
    const { messages } = buildContext(makeConversation({ compressedCount: 4, summary: '旧摘要' }), makeHistory(8), request);
    expect(messages[messages.length - 1].content).toBe('这一轮的问题');
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('compressedCount 不会越过历史长度导致漏消息', () => {
    const history = makeHistory(3);
    // 游标大于实际条数（理论上不该发生，但要能容错）
    const contents = texts(makeConversation({ compressedCount: 99 }), history);
    expect(contents.length).toBeGreaterThanOrEqual(2); // system + 本轮问题
  });
});

describe('buildContext · 窗口裁剪', () => {
  it('消息很多时只保留最近若干轮，并提供压缩标记', () => {
    const history = makeHistory(40);
    const result = buildContext(makeConversation(), history, request);
    expect(result.compressed).toBe(true);
    // 最早的那条不该出现
    expect(result.messages.some((m) => (m.content ?? '').includes('第0条消息'))).toBe(false);
  });

  it('错误状态的消息被跳过', () => {
    const history: ChatMessage[] = [
      { ...makeHistory(1)[0], status: 'error', error: '失败了' },
      { ...makeHistory(1)[0], id: 'ok', role: 'user', status: 'done', content: '正常消息' },
    ];
    const contents = texts(makeConversation(), history);
    expect(contents.some((c) => c.includes('失败了'))).toBe(false);
    expect(contents.some((c) => c.includes('正常消息'))).toBe(true);
  });
});
