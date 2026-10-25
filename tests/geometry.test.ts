import { describe, expect, it } from 'vitest';
import { clamp, clampPosition, clampRect, clampSize, defaultRect, minimizedRect, resizeByEdge, resizeFromCorner, snapRect } from '@/utils/geometry';
import type { Rect, SizeLimit, Viewport } from '@/types';

const LIMIT: SizeLimit = { minWidth: 320, minHeight: 260 };
const VIEWPORT: Viewport = { width: 1440, height: 900 };

describe('clamp', () => {
  it('区间内原样返回', () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it('低于下限取下限，高于上限取上限', () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });

  it('上限小于下限时优先保证下限', () => {
    // 场景：视口宽 200，最小宽度 320。此时不能返回 200，
    // 否则浮窗会小到布局崩坏；返回 320 虽然超出视口，但至少结构完整。
    expect(clamp(100, 320, 200)).toBe(320);
  });
});

describe('clampSize', () => {
  it('合法尺寸不做修改', () => {
    expect(clampSize({ width: 400, height: 500 }, LIMIT, VIEWPORT)).toEqual({ width: 400, height: 500 });
  });

  it('小于最小尺寸时提升到最小值', () => {
    expect(clampSize({ width: 100, height: 80 }, LIMIT, VIEWPORT)).toEqual({ width: 320, height: 260 });
  });

  it('大于视口时收缩到视口大小', () => {
    const smallViewport: Viewport = { width: 500, height: 400 };
    expect(clampSize({ width: 900, height: 800 }, LIMIT, smallViewport)).toEqual({ width: 500, height: 400 });
  });
});

describe('clampPosition', () => {
  const size = { width: 400, height: 300 };

  it('在可视区内不移动', () => {
    expect(clampPosition({ x: 100, y: 100 }, size, VIEWPORT)).toEqual({ x: 100, y: 100 });
  });

  it('越出左/上边界时贴边', () => {
    expect(clampPosition({ x: -50, y: -20 }, size, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });

  it('越出右/下边界时贴住视口右下', () => {
    expect(clampPosition({ x: 1200, y: 800 }, size, VIEWPORT)).toEqual({ x: 1040, y: 600 });
  });

  it('窗口比视口还大时定位到 0，而不是飞出去', () => {
    const huge = { width: 2000, height: 1200 };
    expect(clampPosition({ x: 300, y: 300 }, huge, VIEWPORT)).toEqual({ x: 0, y: 0 });
  });
});

describe('clampRect', () => {
  it('同时修正尺寸与位置', () => {
    const broken: Rect = { x: 1400, y: 880, width: 5000, height: 100 };
    const fixed = clampRect(broken, VIEWPORT, LIMIT);
    expect(fixed.width).toBe(1440);
    expect(fixed.height).toBe(260);
    expect(fixed.x).toBe(0);
    expect(fixed.y).toBe(Math.max(0, 900 - 260));
  });
});

describe('resizeFromCorner', () => {
  const start: Rect = { x: 100, y: 100, width: 400, height: 400 };

  it('按位移直接扩张', () => {
    expect(resizeFromCorner(start, 50, 30, LIMIT, VIEWPORT)).toEqual({ x: 100, y: 100, width: 450, height: 430 });
  });

  it('缩到小于最小尺寸时停在最小值', () => {
    const result = resizeFromCorner(start, -1000, -1000, LIMIT, VIEWPORT);
    expect(result.width).toBe(LIMIT.minWidth);
    expect(result.height).toBe(LIMIT.minHeight);
    // 关键：收缩时左上角不能跟着动，否则手感像在"拽走"整个窗口
    expect(result.x).toBe(start.x);
    expect(result.y).toBe(start.y);
  });

  it('扩张不会越过视口右下边界', () => {
    const result = resizeFromCorner(start, 5000, 5000, LIMIT, VIEWPORT);
    expect(result.width).toBe(VIEWPORT.width - start.x);
    expect(result.height).toBe(VIEWPORT.height - start.y);
  });
});

describe('minimizedRect', () => {
  it('从原窗口右下角向内收，位置连续', () => {
    const normal: Rect = { x: 1032, y: 356, width: 384, height: 520 };
    const result = minimizedRect(normal, 46, VIEWPORT);
    expect(result).toEqual({ x: 1370, y: 830, width: 46, height: 46 });
  });

  it('贴住视口右下时仍然完整可见', () => {
    const normal: Rect = { x: 1394, y: 854, width: 46, height: 46 };
    const result = minimizedRect(normal, 46, VIEWPORT);
    expect(result.x + result.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(result.y + result.height).toBeLessThanOrEqual(VIEWPORT.height);
  });
});

describe('defaultRect', () => {
  it('落在右下角且完全可见', () => {
    const result = defaultRect(VIEWPORT, { width: 384, height: 520 });
    expect(result).toEqual({ x: 1032, y: 356, width: 384, height: 520 });
    expect(result.x + result.width).toBeLessThanOrEqual(VIEWPORT.width);
    expect(result.y + result.height).toBeLessThanOrEqual(VIEWPORT.height);
  });

  it('小视口下也不会溢出', () => {
    const tiny: Viewport = { width: 360, height: 300 };
    const result = defaultRect(tiny, { width: 384, height: 520 });
    expect(result.x + result.width).toBeLessThanOrEqual(Math.max(tiny.width, 384));
  });
});

describe('resizeByEdge', () => {
  const start: Rect = { x: 200, y: 150, width: 400, height: 300 };

  it('拖右边缘只改宽度，左上角不动', () => {
    const result = resizeByEdge(start, 'e', 60, 999, LIMIT, VIEWPORT);
    expect(result).toEqual({ x: 200, y: 150, width: 460, height: 300 });
  });

  it('拖下边缘只改高度', () => {
    const result = resizeByEdge(start, 's', 999, 70, LIMIT, VIEWPORT);
    expect(result).toEqual({ x: 200, y: 150, width: 400, height: 370 });
  });

  it('拖左边缘时 x 与宽度同时变化，右边界保持不动', () => {
    const result = resizeByEdge(start, 'w', -80, 0, LIMIT, VIEWPORT);
    expect(result.x).toBe(120);
    expect(result.width).toBe(480);
    // 右边界必须纹丝不动，这是"自由缩放"最核心的手感
    expect(result.x + result.width).toBe(start.x + start.width);
  });

  it('拖左边缘往右过头时，宽度停在最小值', () => {
    const result = resizeByEdge(start, 'w', 5000, 0, LIMIT, VIEWPORT);
    expect(result.width).toBe(LIMIT.minWidth);
    expect(result.x).toBe(start.x + start.width - LIMIT.minWidth);
  });

  it('拖左边缘往左出屏时，x 停在 0', () => {
    const result = resizeByEdge(start, 'w', -5000, 0, LIMIT, VIEWPORT);
    expect(result.x).toBe(0);
    expect(result.width).toBe(start.x + start.width);
  });

  it('拖上边缘时 y 与高度同时变化，下边界保持不动', () => {
    const result = resizeByEdge(start, 'n', 0, -60, LIMIT, VIEWPORT);
    expect(result.y).toBe(90);
    expect(result.height).toBe(360);
    expect(result.y + result.height).toBe(start.y + start.height);
  });

  it('拖上边缘往下的极限不小于最小高度', () => {
    const result = resizeByEdge(start, 'n', 0, 5000, LIMIT, VIEWPORT);
    expect(result.height).toBe(LIMIT.minHeight);
    expect(result.y).toBe(start.y + start.height - LIMIT.minHeight);
  });

  it('右上角同时影响上和右', () => {
    const result = resizeByEdge(start, 'ne', 50, -40, LIMIT, VIEWPORT);
    expect(result.width).toBe(450);
    expect(result.height).toBe(340);
    expect(result.y).toBe(110);
    expect(result.x).toBe(200);
  });

  it('左下角同时影响下和左', () => {
    const result = resizeByEdge(start, 'sw', -50, 40, LIMIT, VIEWPORT);
    expect(result.x).toBe(150);
    expect(result.width).toBe(450);
    expect(result.height).toBe(340);
  });

  it('任何方向都不会超出视口', () => {
    for (const edge of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const) {
      const result = resizeByEdge(start, edge, 5000, 5000, LIMIT, VIEWPORT);
      expect(result.x).toBeGreaterThanOrEqual(0);
      expect(result.y).toBeGreaterThanOrEqual(0);
      expect(result.x + result.width).toBeLessThanOrEqual(VIEWPORT.width);
      expect(result.y + result.height).toBeLessThanOrEqual(VIEWPORT.height);
    }
  });
});

describe('snapRect 边缘吸附', () => {
  const viewport: Viewport = { width: 1440, height: 900 };
  const base: Rect = { x: 600, y: 200, width: 400, height: 500 };

  it('靠近左边缘时贴左', () => {
    const result = snapRect({ ...base, x: 12 }, viewport);
    expect(result.x).toBe(8);
    expect(result.y).toBe(200);
  });

  it('靠近右边缘时贴右', () => {
    const result = snapRect({ ...base, x: 1440 - 400 - 15 }, viewport);
    expect(result.x).toBe(1440 - 400 - 8);
  });

  it('靠近上边缘时贴上', () => {
    const result = snapRect({ ...base, y: 10 }, viewport);
    expect(result.y).toBe(8);
  });

  it('靠近下边缘时贴下', () => {
    const result = snapRect({ ...base, y: 900 - 500 - 6 }, viewport);
    expect(result.y).toBe(900 - 500 - 8);
  });

  it('中间位置不吸附', () => {
    const result = snapRect(base, viewport);
    expect(result).toEqual(base);
  });

  it('左上角同时吸附', () => {
    const result = snapRect({ ...base, x: 5, y: 4 }, viewport);
    expect(result.x).toBe(8);
    expect(result.y).toBe(8);
  });

  it('吸附不会把窗口推出视口', () => {
    const wide: Rect = { x: 10, y: 10, width: 1430, height: 880 };
    const result = snapRect(wide, viewport);
    expect(result.x).toBeGreaterThanOrEqual(0);
    expect(result.y).toBeGreaterThanOrEqual(0);
    expect(result.x + result.width).toBeLessThanOrEqual(viewport.width);
  });
});
