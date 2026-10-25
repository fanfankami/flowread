import { describe, expect, it } from 'vitest';
import { estimateTokens, pickRecentWindow, truncate } from '@/shared/token';

describe('estimateTokens', () => {
  it('空字符串为 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('中文按每字约 0.7 token 估算', () => {
    // 收益只是"够保守"，不要求和真实 tokenizer 一致
    expect(estimateTokens('一二三四五六七八九十')).toBe(7);
  });

  it('英文按每 4 字符约 1 token 估算', () => {
    expect(estimateTokens('abcdefgh')).toBe(2);
  });

  it('中英混排分别计数', () => {
    const tokens = estimateTokens('中文abcd');
    expect(tokens).toBe(Math.ceil(2 * 0.7 + 4 / 4));
  });
});

describe('truncate', () => {
  it('短文本原样返回', () => {
    expect(truncate('短', 10)).toBe('短');
  });

  it('超长文本保留头尾', () => {
    const result = truncate('0123456789abcdefghij', 11);
    expect(result).toContain('…');
    expect(result.length).toBeLessThanOrEqual(12);
    expect(result.startsWith('0123')).toBe(true);
    expect(result.endsWith('hij')).toBe(true);
  });

  it('上限极小时直接截断', () => {
    expect(truncate('0123456789', 5)).toBe('01234');
  });
});

describe('pickRecentWindow', () => {
  const messages = [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'a2' },
    { role: 'user', content: 'q3' },
    { role: 'assistant', content: 'a3' },
  ];

  it('按整轮回退，不会只留回答丢掉提问', () => {
    const window = pickRecentWindow(messages, 2);
    // 保留最后两轮：q2/a2/q3/a3
    expect(window.map((m) => m.content)).toEqual(['q2', 'a2', 'q3', 'a3']);
  });

  it('轮数足够时返回全部', () => {
    expect(pickRecentWindow(messages, 10)).toHaveLength(6);
  });

  it('空数组返回空', () => {
    expect(pickRecentWindow([], 3)).toEqual([]);
  });
});
