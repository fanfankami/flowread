/**
 * 内置演示模型。
 *
 * 存在的理由：这个产品是 BYOK 的，用户第一次装好时手里不一定有 Key。
 * 如果没 Key 就什么都看不到，"先看看效果"这件事就无从谈起。
 *
 * 但它必须诚实：
 * - 明确标注这是固定示例，不假装做了真实分析
 * - 内容只讲"如何读这段话"的方法论，不编造具体技术事实
 * - 排版上覆盖标题/列表/粗体/行内代码/代码块，让用户看到渲染能力
 *
 * 一旦填入 Key 并切到真实服务商，这条路径就不会再被走到。
 */
import { ProviderError, type StreamParams } from './types';
import type { Anchor } from '@/types';

const DEMO_BANNER = '> **演示模式**：这条回复是固定示例，用来展示排版与流式输出的效果，**并没有真的分析你选中的内容**。到设置里填入 API Key，同样的操作会得到针对这段文字的真实解释。';

function quote(text: string, max = 110): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function firstAnswer(anchor: Anchor): string {
  const topic = anchor.heading ?? '这段文字';
  return `${DEMO_BANNER}

你选中了「**${topic}**」里的这一段：

> ${quote(anchor.text)}

## 读这类句子的四个切入点

1. **找触发条件** —— 哪些前提必须同时成立，哪些是可选的
2. **找动作** —— 条件满足后到底发生了什么变化
3. **找代价** —— 为什么要设门槛，无条件执行会怎样
4. **找例外** —— 边界情况往往才是理解的入口

## 一个通用的追问顺序

- 先问 *"它为什么要这样做"*，建立动机
- 再问 *"如果不这样做会怎样"*，建立对比
- 最后问 *"有没有反例"*，确认自己没有过度概括

---

下面这段代码只是用来展示代码块的渲染效果：

\`\`\`java
if (binCount >= TREEIFY_THRESHOLD - 1)
    treeifyBin(tab, hash);
\`\`\`

**下一步**：选中上面任意一句，点「追问」，可以试试问"为什么阈值是 8"。`;
}

function whyAnswer(anchor: Anchor, question: string): string {
  return `${DEMO_BANNER}

你问的是：_${quote(question, 60)}_

## 在演示模式下，我只能给你"怎么找答案"的路径

针对「${quote(anchor.heading ?? anchor.text, 40)}」这类问题，原因通常藏在这三个地方：

1. **设计者的取舍** —— 两种方案各有什么代价，为什么选了这一个
2. **历史包袱** —— 兼容性、性能拐点、实现复杂度
3. **反例验证** —— 如果阈值改成别的值，什么会坏掉

## 建议你这样追问真实模型

> "如果把这个阈值改小，具体会在哪个场景下变差？"

比"为什么是 8"更容易得到有信息量的回答，因为它逼模型给出**失效场景**，而不是背书。

\`\`\`text
开放式提问 → 容易得到泛泛而谈
指定场景提问 → 容易得到具体权衡
\`\`\`

填入 API Key 后，这句话就会变成真实分析了。`;
}

function codeAnswer(anchor: Anchor, question: string): string {
  return `${DEMO_BANNER}

你问的是：_${quote(question, 60)}_

## 想看真实代码解读，需要接入模型

演示模式不生成针对你文章的代码分析，但可以先看看代码块在浮窗里的渲染效果：

\`\`\`java
// 这段只是排版示例，不是对你文章的解释
final V putVal(int hash, K key, V value) {
    Node<K, V>[] tab;
    // 1. 表为空先初始化
    if ((tab = table) == null || (n = tab.length) == 0)
        n = (tab = resize()).length;
    // 2. 定位槽位，为空直接放
    if ((p = tab[i = (n - 1) & hash]) == null)
        tab[i] = newNode(hash, key, value, null);
}
\`\`\`

代码块支持：

- 横向滚动，不会撑破浮窗
- 一键复制（右上角）
- 生成过程中未闭合也不会塌成正文

选中代码块里的任意一行，再点追问，就能问「这里为什么要 (n - 1) & hash」。`;
}

function compareAnswer(anchor: Anchor, question: string): string {
  return `${DEMO_BANNER}

你问的是：_${quote(question, 60)}_

## 对比类问题，建议这样拆

| 维度 | 该看什么 |
| --- | --- |
| 触发条件 | 两者分别在什么前提下发生 |
| 时间复杂度 | 最坏情况和平均情况分别是多少 |
| 空间代价 | 多存了什么，多存多少 |
| 适用场景 | 什么数据分布下谁更划算 |

## 注意

对比类问题最容易得到的错误答案是"各有优缺点" —— 那是没有信息量的。

有效的对比一定带**具体数字或具体场景**，比如"在冲突率低于 1/8 时链表更快，因为树节点多占约 2 倍内存"。

填入 Key 后，这类问题会针对你选中的原文回答。`;
}

function defaultAnswer(anchor: Anchor, question: string): string {
  return `${DEMO_BANNER}

你问的是：_${quote(question, 60)}_

## 这是一个追问，说明上下文没有丢

注意看：你的问题里没有提到「${quote(anchor.heading ?? '这段文字', 30)}」，但我仍然知道你在问它 —— 因为会话创建时就把锚点固定下来了。

这正是 FlowRead 和普通侧边栏的关键差别：

- **滚动页面**不会改变讨论对象
- **点其他地方**不会改变讨论对象
- 只有你主动点「切到当前段落」才会换锚点

## 当前锚点

> ${quote(anchor.text, 140)}

---

演示模式到此为止。到设置面板填入 API Key，这里就会变成真实的连续对话。`;
}

function translateAnswer(anchor: Anchor): string {
  return `${DEMO_BANNER}

你按了「翻译」，但演示模式没有翻译能力，只能展示这条链路会长什么样。

真实模型返回时，这里应该只有译文，不会出现这段说明。比如选中：

> ${quote(anchor.text, 100)}

会得到对应的译句，不带任何"以下是翻译"之类的前缀。

到设置里填入 API Key，这条就通了。`;
}

function summaryAnswer(anchor: Anchor): string {
  return `${DEMO_BANNER}

你按了「总结」。演示模式不会真的提炼，但可以展示排版形态：

- 这段文字讨论的是 **${quote(anchor.heading ?? '当前段落', 30)}**
- 核心信息集中在开头一句
- 后面的部分是补充说明与边界条件

真实模型会把它压成两三句话，而不是这样罗列。

选中文字 → 点「总结」，就是这条路径。`;
}

function buildDemoAnswer(anchor: Anchor, question: string, turn: number): string {
  // 快捷动作优先判断：它们用的是固定指令，不该走追问分支
  if (/翻译成中文/.test(question)) return translateAnswer(anchor);
  if (/总结这段内容的核心/.test(question)) return summaryAnswer(anchor);
  if (turn <= 1) return firstAnswer(anchor);
  if (/为什么|原因|why|怎么会/i.test(question)) return whyAnswer(anchor, question);
  if (/代码|例子|示例|实现|code/i.test(question)) return codeAnswer(anchor, question);
  if (/区别|对比|不同|vs|差异/i.test(question)) return compareAnswer(anchor, question);
  return defaultAnswer(anchor, question);
}

export async function streamDemo(params: StreamParams): Promise<void> {
  if (!params.demo) {
    throw new ProviderError('演示模式缺少上下文');
  }

  const { anchor, question, turn } = params.demo;
  const answer = buildDemoAnswer(anchor, question, turn);

  // 按 2~4 个字符切片输出，速度贴近真实模型的观感。
  // 太快会像一次性贴上去，太慢用户会以为卡住。
  let index = 0;
  while (index < answer.length) {
    if (params.signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const size = 2 + (index % 3);
    params.onDelta(answer.slice(index, index + size));
    index += size;

    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}
