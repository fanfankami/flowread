/**
 * 浮窗几何计算 —— 全部是纯函数，不碰 DOM。
 *
 * 之所以把它们单独抽出来：浮窗的"拖动、缩放、边界校正、窗口变化重算"
 * 本质上是同一套坐标约束，如果散落在组件里用 if 拼，边界情况必然漏。
 * 抽成纯函数后可以用 Vitest 穷举，组件只负责把结果写进 style。
 */
import type { Rect, SizeLimit, Viewport } from '@/types';

/** 数值钳制，语义与常见的 clamp 一致：低于下限取下限，高于上限取上限。 */
export function clamp(value: number, min: number, max: number): number {
  // max < min 时（例如视口比最小尺寸还小）优先保证下限，避免返回非法值
  if (max < min) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * 按最小尺寸与视口约束修正宽高。
 *
 * 注意顺序：先夹到最小值，再夹到视口。反过来会出现
 * "视口比最小宽度还小 → 结果小于最小宽度"的矛盾。
 */
export function clampSize(size: { width: number; height: number }, limit: SizeLimit, viewport: Viewport): { width: number; height: number } {
  const maxWidth = Math.max(limit.minWidth, viewport.width);
  const maxHeight = Math.max(limit.minHeight, viewport.height);

  return {
    width: clamp(size.width, limit.minWidth, maxWidth),
    height: clamp(size.height, limit.minHeight, maxHeight),
  };
}

/**
 * 按视口修正位置，保证窗口完整落在可见区域内。
 *
 * 当窗口比视口还大时，`viewport.width - width` 会变成负数，
 * Math.max(0, ...) 把它压回 0，也就是贴左边，而不是飞出屏幕。
 */
export function clampPosition(pos: { x: number; y: number }, size: { width: number; height: number }, viewport: Viewport): { x: number; y: number } {
  return {
    x: clamp(pos.x, 0, Math.max(0, viewport.width - size.width)),
    y: clamp(pos.y, 0, Math.max(0, viewport.height - size.height)),
  };
}

/** 一次性修正整个矩形：先修尺寸，再基于新尺寸修位置。 */
export function clampRect(rect: Rect, viewport: Viewport, limit: SizeLimit): Rect {
  const size = clampSize(rect, limit, viewport);
  const pos = clampPosition(rect, size, viewport);
  return { ...pos, ...size };
}

/**
 * 拖拽右下角时的尺寸计算。
 *
 * 这里直接以视口为上限（视口宽度 - 起始 x），
 * 而不是"先随便长、最后再 clampRect"：
 * 后者会让鼠标已经停在边界上、窗口却还在变大的错觉消失得更晚，手感更差。
 */
export function resizeFromCorner(start: Rect, deltaX: number, deltaY: number, limit: SizeLimit, viewport: Viewport): Rect {
  return resizeByEdge(start, 'se', deltaX, deltaY, limit, viewport);
}

/** 缩放的八个方向。用字符串包含判断（'ne' 同时命中 'n' 和 'e'），避免写八份分支。 */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * 按边/角缩放窗口。
 *
 * 拖左边和拖右边的差别不只是"宽度加减"：
 * - 拖右边：左上角不动，只有 width 变
 * - 拖左边：右边界不动，x 和 width **同时**变
 *
 * 拖左边时还必须防止两件事：
 * 1. 往右拖过头把宽度挤到小于最小值 —— x 停在 right - minWidth
 * 2. 往左拖出屏幕 —— x 最小为 0
 *
 * 用"四条边各自维护"的写法比分别处理八个 case 更不容易漏边界。
 */
export function resizeByEdge(
  start: Rect,
  edge: ResizeEdge,
  deltaX: number,
  deltaY: number,
  limit: SizeLimit,
  viewport: Viewport,
): Rect {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;

  if (edge.includes('e')) {
    right = clamp(start.x + start.width + deltaX, start.x + limit.minWidth, viewport.width);
  }
  if (edge.includes('w')) {
    left = clamp(start.x + deltaX, 0, right - limit.minWidth);
  }
  if (edge.includes('s')) {
    bottom = clamp(start.y + start.height + deltaY, start.y + limit.minHeight, viewport.height);
  }
  if (edge.includes('n')) {
    top = clamp(start.y + deltaY, 0, bottom - limit.minHeight);
  }

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * 最小化后的位置：从原窗口右下角向内收，视觉上是"收起来了"。
 * 如果只是保留左上角坐标，窗口在屏幕右侧时圆钮会突然跳到左边。
 */
export function minimizedRect(rect: Rect, iconSize: number, viewport: Viewport): Rect {
  const pos = clampPosition({ x: rect.x + rect.width - iconSize, y: rect.y + rect.height - iconSize }, { width: iconSize, height: iconSize }, viewport);
  return { x: pos.x, y: pos.y, width: iconSize, height: iconSize };
}

/** 默认吸附距离：窗口边缘进入这个范围就贴边 */
export const SNAP_THRESHOLD = 22;
/** 吸附后与屏幕边缘保留的间距，完全贴死会显得局促 */
export const SNAP_MARGIN = 8;

/**
 * 边缘吸附。
 *
 * 模仿桌面窗口的行为：拖到接近屏幕边缘时自动贴住，
 * 不用精确对齐也能得到一个整齐的布局。
 *
 * 只在拖动**结束时**调用一次，而不是拖动过程中每帧生效 ——
 * 后者会让窗口在靠近边缘时被"吸住"，鼠标移不出来，手感很黏。
 */
export function snapRect(rect: Rect, viewport: Viewport, threshold = SNAP_THRESHOLD, margin = SNAP_MARGIN): Rect {
  let { x, y } = rect;

  if (x <= threshold) {
    x = margin;
  } else if (x + rect.width >= viewport.width - threshold) {
    x = viewport.width - rect.width - margin;
  }

  if (y <= threshold) {
    y = margin;
  } else if (y + rect.height >= viewport.height - threshold) {
    y = viewport.height - rect.height - margin;
  }

  // 窗口比视口还宽/高时上面的计算可能给出负数，最后统一夹一次
  const safe = clampPosition({ x, y }, { width: rect.width, height: rect.height }, viewport);
  return { ...rect, ...safe };
}

/** 默认位置：右下角留出边距，不遮挡正文的主要阅读区。 */
export function defaultRect(viewport: Viewport, size: { width: number; height: number }, margin = 24): Rect {
  return clampRect(
    {
      x: viewport.width - size.width - margin,
      y: viewport.height - size.height - margin,
      width: size.width,
      height: size.height,
    },
    viewport,
    { minWidth: Math.min(size.width, viewport.width), minHeight: Math.min(size.height, viewport.height) },
  );
}
