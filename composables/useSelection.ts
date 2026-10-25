/**
 * 选区捕获。
 *
 * 时序上最微妙的一块，核心约束只有一句：
 * **必须在选区还活着的时候把内容抄下来，不能等用户点按钮再读。**
 *
 * 原因是浏览器行为：用户一旦点击浮窗，页面的 Selection 会被清除（或 collapsed）。
 * 等到「解释」的 click 回调里再调 window.getSelection()，拿到的是空字符串。
 */
import { onUnmounted, ref, type Ref } from 'vue';
import type { Anchor } from '@/types';
import { buildAnchor } from '@/utils/anchor';
import { closestBlock, findHeading, getSurroundingText, isEditableContext, normalizeParagraph } from '@/utils/dom-context';

export interface UseSelectionOptions {
  /** 判断节点是否属于插件自身 UI，用于排除插件内部划选 */
  isOwnNode: (node: Node) => boolean;
  /** 最短选区长度，低于此值视为误触 */
  minLength?: number;
  /** 选区稳定多久后提交，避免拖选过程中反复计算 */
  settleDelay?: number;
}

export interface UseSelectionReturn {
  /** 最近一次有效选区的锚点。无效选区不会清空它 */
  anchor: Ref<Anchor | null>;
  /** 选区在屏幕上的位置，用于把操作气泡贴在选区旁边 */
  pillRect: Ref<{ left: number; top: number; right: number; bottom: number } | null>;
  /** 选区的 Range 副本。用于在选区被浏览器清掉之后，仍然能高亮原文 */
  range: Ref<Range | null>;
  /**
   * 每次**成功**识别出选区都会自增，即使和上一次是同一段文字。
   * 用来区分"第一次选中"和"用户又选了一次同一段" —— 后者必须能让气泡重新出现。
   */
  settleTick: Ref<number>;
  /**
   * 清掉页面上的选区，但**保留**锚点和 Range 副本。
   *
   * 点完「解释/追问」后必须调用：否则 220ms 后那次 settle 会把仍然存在的选区
   * 再读一遍，settleTick 一涨，气泡就又弹回来了。
   */
  dismissSelection: () => void;
  clear: () => void;
}

export function useSelection(options: UseSelectionOptions): UseSelectionReturn {
  const minLength = () => options.minLength ?? 4;
  const settleDelay = options.settleDelay ?? 220;

  const anchor = ref<Anchor | null>(null);
  const pillRect = ref<{ left: number; top: number; right: number; bottom: number } | null>(null);
  const range = ref<Range | null>(null);
  const settleTick = ref(0);
  let lastKey = '';
  let timer: number | null = null;

  function readSelection(): Anchor | null {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const text = selection.toString().trim();
    if (text.length < minLength()) return null;
    // 上限保护：Ctrl+A 全选整页时不应该把整篇文章塞进上下文
    if (text.length > 10000) return null;

    const node = selection.anchorNode;
    if (!node) return null;

    // 插件自己 UI 里的选区不算（否则在浮窗里复制回答也会触发解释）
    if (options.isOwnNode(node)) return null;
    // 输入框、密码框、代码编辑器里不算
    if (isEditableContext(node)) return null;

    const block = closestBlock(node);
    if (!block) return null;

    const { before, after } = getSurroundingText(block);

    return buildAnchor({
      text,
      paragraph: normalizeParagraph(block),
      heading: findHeading(node),
      before,
      after,
      block,
    });
  }

  function settle(): void {
    timer = null;

    // 先取选区矩形再取文本：这两个都必须在最靠近事件的那一刻读，
    // 因为用户下一步动作（点气泡）就会让 Selection 消失。
    const selection = window.getSelection();
    let rect: { left: number; top: number; right: number; bottom: number } | null = null;
    let clonedRange: Range | null = null;

    if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
      try {
        const live = selection.getRangeAt(0);
        const bounds = live.getBoundingClientRect();
        if (bounds.width || bounds.height) {
          rect = { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom };
        }
        // 存一份副本：用户下一步点击就会让 Selection 消失，
        // 但副本仍然可以拿去给 Highlight API 做持久高亮
        clonedRange = live.cloneRange();
      } catch {
        // 某些页面（含 iframe / shadow）取 range 会抛错，忽略即可
      }
    }

    const next = readSelection();
    // 无效就保留上一次的锚点。这条规则让"点浮窗导致选区消失"变成无害事件。
    if (!next) return;

    const key = `${next.text}|${next.paragraph.slice(0, 80)}|${next.url}`;
    if (key === lastKey) {
      // 同一段文字被再次选中：锚点不用更新，但必须通知外层"用户又选了一次"，
      // 否则滚动或点击收起气泡之后，重新选同一段就再也叫不出气泡。
      if (rect) pillRect.value = rect;
      if (clonedRange) range.value = clonedRange;
      settleTick.value += 1;
      return;
    }

    lastKey = key;
    anchor.value = next;
    if (rect) pillRect.value = rect;
    if (clonedRange) range.value = clonedRange;
    settleTick.value += 1;
  }

  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(settle, settleDelay);
  }

  function onPointerUp(event: PointerEvent): void {
    // 只响应主键（左键）。右键同样会派发 pointerup，
    // 但用户右键是要打开上下文菜单，不是要提问 ——
    // 此时弹气泡既有遮挡，又会把上一次的左键选区重新激活。
    if (event.button !== 0) return;
    schedule();
  }

  function onKeyUp(event: KeyboardEvent): void {
    // 键盘选择（Shift+方向键、Shift+Home、Ctrl+A）不产生 pointerup。
    // 注意 'a' 必须配合 Ctrl/Cmd：否则正常打字每按一次 a 都会触发一次检测。
    const isSelectAll = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a';
    if (event.key.startsWith('Arrow') || event.key === 'Shift' || isSelectAll) {
      schedule();
    }
  }

  // capture 阶段监听：某些站点会在冒泡阶段 stopPropagation 掉事件
  document.addEventListener('pointerup', onPointerUp, true);
  document.addEventListener('keyup', onKeyUp, true);

  onUnmounted(() => {
    document.removeEventListener('pointerup', onPointerUp, true);
    document.removeEventListener('keyup', onKeyUp, true);
    if (timer !== null) window.clearTimeout(timer);
  });

  return {
    anchor,
    pillRect,
    range,
    settleTick,
    dismissSelection(): void {
      // 只清浏览器选区，anchor 和 range 副本都留着
      window.getSelection()?.removeAllRanges();
    },
    clear(): void {
      // 必须连页面上的选区一起清掉。
      // 只把 anchor 置空的话，220ms 后那次 settle 会重新读到仍然存在的选区，
      // 于是气泡刚收起又弹回来（点「解释」后尤其明显）。
      window.getSelection()?.removeAllRanges();
      anchor.value = null;
      pillRect.value = null;
      range.value = null;
      lastKey = '';
    },
  };
}
