/**
 * 粗略的 token 估算。
 *
 * 为什么不用真正的 tokenizer：那需要引入模型的词表文件（几百 KB），
 * 而这里只需要一个"够保守"的数字来决定何时压缩上下文。宁可高估，
 * 让压缩提前发生，也不要低估导致请求超限。
 */

/** 中日韩字符大致 1 字 ≈ 0.7 token；其余字符约 4 字符 ≈ 1 token。 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let cjk = 0;
  let other = 0;
  for (const char of text) {
    // 基本汉字区 + 扩展区 + 全角标点，统一按 CJK 计
    const code = char.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }

  return Math.ceil(cjk * 0.7 + other / 4);
}

/** 把一段文本按字符预算截断，保留头尾、中间用省略号，用于前文/后文这类辅助上下文。 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 8) return text.slice(0, maxChars);
  const head = Math.ceil((maxChars - 3) / 2);
  const tail = Math.floor((maxChars - 3) / 2);
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/**
 * 选择一个"最近 N 轮"的切点。
 *
 * 按整轮（user + assistant 成对）回退，而不是按单条消息：
 * 只保留一条孤立的 assistant 回答、却丢了它对应的提问，模型会完全误解上下文。
 */
export function pickRecentWindow<T extends { role: string }>(messages: T[], maxTurns: number): T[] {
  const result: T[] = [];
  let turns = 0;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    result.unshift(message);
    if (message.role === 'user') {
      turns += 1;
      if (turns >= maxTurns) break;
    }
  }

  return result;
}
