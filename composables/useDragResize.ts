/**
 * 浮窗的拖动与缩放。
 *
 * 状态全部收敛在调用方传入的 `rect` 上，本 composable 只做三件事：
 * 1. 把指针位移翻译成矩形变化（几何计算交给 utils/geometry 的纯函数）
 * 2. 管理拖拽期间的全局副作用（禁止选中、光标、iframe 遮挡层）
 * 3. 视口尺寸变化时把窗口拉回可见区域
 */
import { onUnmounted, ref, type Ref } from 'vue';
import type { Rect, SizeLimit, Viewport } from '@/types';
import { clampPosition, clampRect, resizeByEdge, snapRect, type ResizeEdge } from '@/utils/geometry';

export interface UseDragResizeOptions {
  rect: Ref<Rect>;
  viewport: Ref<Viewport>;
  limit: SizeLimit;
  /** 一次拖动/缩放结束时回调，用于持久化布局 */
  onCommit: () => void;
}

/** 缩放期间整页统一显示对应方向的光标，避免鼠标滑出热区后光标乱跳 */
const CURSOR_BY_EDGE: Record<ResizeEdge, string> = {
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
};

export function useDragResize(options: UseDragResizeOptions) {
  const { rect, viewport, limit, onCommit } = options;

  /** 当前交互模式，用于驱动光标和禁用过渡动画 */
  const mode = ref<'idle' | 'drag' | 'resize'>('idle');

  let startPointer = { x: 0, y: 0 };
  let startRect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  /** 本次缩放拖的是哪条边/哪个角 */
  let resizeEdge: ResizeEdge = 'se';
  let rafId = 0;
  let pendingDelta = { x: 0, y: 0 };
  /** 一次交互期间需要清理的副作用（遮罩层、页面样式锁），按注册顺序回收 */
  let cleanups: Array<() => void> = [];

  /**
   * 拖拽期间在文档最上层铺一层透明遮罩。
   *
   * 这是个容易被忽略的坑：如果页面上有 iframe（视频、广告、嵌入的地图），
   * 鼠标划过 iframe 时 pointermove 会被 iframe 的文档吃掉，
   * 表现为"拖到一半窗口卡住不动"。遮罩层把指针事件留在主文档里。
   */
  function mountDragShield(): () => void {
    const shield = document.createElement('div');
    shield.setAttribute('data-flowread-shield', '');
    // z-index 比浮窗宿主低 1，保证浮窗始终在遮罩之上、可继续移动
    shield.style.cssText = 'position:fixed;inset:0;z-index:2147482999;background:transparent;cursor:grabbing;';
    document.documentElement.appendChild(shield);
    return () => shield.remove();
  }

  /**
   * 拖拽期间禁止页面文字被选中。
   *
   * 为什么不用 `document.body.style.userSelect = 'none'`：
   * 那是内联样式，只能靠继承生效，任何一个 `p { user-select: text }`
   * 或者浏览器在 mousedown 后已经启动的选区扩展都能绕过它（实测会漏出 1~2 个字）。
   * 这里改成注入一条带 !important 的全局样式表，同时在 capture 阶段拦 selectstart，
   * 两道保险。
   */
  function lockPageSelection(): () => void {
    const style = document.createElement('style');
    style.setAttribute('data-flowread-lock', '');
    // 顺带把整页光标锁成当前方向：鼠标滑到页面元素上时光标不会跳回箭头，
    // 缩放过程中这个反馈比什么都重要。浮窗在 shadow root 内，不受这条规则影响。
    const cursor = mode.value === 'resize' ? CURSOR_BY_EDGE[resizeEdge] : 'grabbing';
    style.textContent = `*,*::before,*::after{-webkit-user-select:none!important;user-select:none!important;cursor:${cursor}!important;}`;
    document.documentElement.appendChild(style);

    const preventSelect = (event: Event) => event.preventDefault();
    document.addEventListener('selectstart', preventSelect, true);

    // 拖窗口时清掉页面上已有的选区：否则旧高亮会跟着窗口一起被拖来拖去，视觉上很脏。
    // 注意这不影响插件已捕获的快照 —— 快照早在选区变化时就独立保存了。
    window.getSelection()?.removeAllRanges();

    return () => {
      style.remove();
      document.removeEventListener('selectstart', preventSelect, true);
    };
  }

  function applyDelta(deltaX: number, deltaY: number): void {
    if (mode.value === 'drag') {
      // 拖动只改位置，尺寸保持不变（用 clampPosition 而不是 clampRect，避免误改宽高）
      const pos = clampPosition(
        { x: startRect.x + deltaX, y: startRect.y + deltaY },
        { width: startRect.width, height: startRect.height },
        viewport.value,
      );
      rect.value = { ...startRect, ...pos };
      return;
    }

    if (mode.value === 'resize') {
      rect.value = resizeByEdge(startRect, resizeEdge, deltaX, deltaY, limit, viewport.value);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (mode.value === 'idle') return;

    pendingDelta = {
      x: event.clientX - startPointer.x,
      y: event.clientY - startPointer.y,
    };

    // 用 rAF 合并高频 pointermove：直接写 style 在 120Hz 鼠标下会产生大量无意义重排
    if (rafId !== 0) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      applyDelta(pendingDelta.x, pendingDelta.y);
    });
  }

  function endInteraction(): void {
    if (mode.value === 'idle') return;

    const wasDrag = mode.value === 'drag';
    mode.value = 'idle';
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endInteraction);
    window.removeEventListener('pointercancel', endInteraction);

    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }

    for (const cleanup of cleanups) cleanup();
    cleanups = [];

    // 吸附只在拖动结束时做一次。
    // 放到 pointermove 里的话，窗口靠近边缘会被"黏住"，鼠标拉不出来。
    if (wasDrag) {
      rect.value = snapRect(rect.value, viewport.value);
    }

    onCommit();
  }

  function beginInteraction(event: PointerEvent, nextMode: 'drag' | 'resize'): void {
    // 只响应主键，右键/中键不触发拖动
    if (event.button !== 0) return;
    if (mode.value !== 'idle') return;

    event.preventDefault();
    mode.value = nextMode;
    startPointer = { x: event.clientX, y: event.clientY };
    startRect = { ...rect.value };

    cleanups = [mountDragShield(), lockPageSelection()];

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endInteraction);
    window.addEventListener('pointercancel', endInteraction);
  }

  function startDrag(event: PointerEvent): void {
    beginInteraction(event, 'drag');
  }

  /**
   * 开始缩放。
   * @param edge 拖的是哪条边/角，默认右下角（历史行为）
   */
  function startResize(event: PointerEvent, edge: ResizeEdge = 'se'): void {
    // 缩放手柄的 pointerdown 不能冒泡到标题栏，否则会同时触发拖动
    event.stopPropagation();
    resizeEdge = edge;
    beginInteraction(event, 'resize');
  }

  /** 视口变化（窗口缩放、旋转、侧边栏展开）时重新校正，保证窗口仍然完整可见。 */
  function handleViewportResize(): void {
    viewport.value = { width: window.innerWidth, height: window.innerHeight };
    rect.value = clampRect(rect.value, viewport.value, limit);
    onCommit();
  }

  window.addEventListener('resize', handleViewportResize);

  onUnmounted(() => {
    endInteraction();
    window.removeEventListener('resize', handleViewportResize);
  });

  return { mode, startDrag, startResize };
}
