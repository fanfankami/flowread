/**
 * 站点偏好：决定某个网站要不要自动显示浮窗。
 *
 * 设计原则：**默认不显示**。
 * 阅读助手如果每打开一个网页就自己弹出来，用户第一反应就是卸载。
 * 正确的关系是"我需要你的时候你出现"，而不是"你一直在"。
 *
 * 记忆粒度选 origin 而不是 URL：同一站点的不同文章应该共享同一个意愿，
 * 否则每篇文章都要重新点一次，比不记忆更烦。
 */
import { STORAGE_KEYS } from '@/shared/constants';
import type { SitePreference } from '@/types';

/** 最多记多少个站点，超出按最后操作时间淘汰，避免 storage 无限膨胀 */
const MAX_SITES = 100;

type SiteMap = Record<string, SitePreference>;

async function readMap(): Promise<SiteMap> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.sites);
    return (stored[STORAGE_KEYS.sites] as SiteMap | undefined) ?? {};
  } catch {
    return {};
  }
}

export function useSitePreference() {
  const origin = location.origin;

  /** 这个站点用户上次是否主动开过浮窗。没记录过就是 false（不显示）。 */
  async function shouldOpen(): Promise<boolean> {
    if (!origin || origin === 'null') return false;
    const map = await readMap();
    return map[origin]?.open ?? false;
  }

  /** 记住用户在当前站点的选择。关闭时调用 remember(false)，下次进来就不会自动弹。 */
  async function remember(open: boolean): Promise<void> {
    if (!origin || origin === 'null') return;

    const map = await readMap();
    map[origin] = { open, at: Date.now() };

    const entries = Object.entries(map)
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, MAX_SITES);

    try {
      await chrome.storage.local.set({ [STORAGE_KEYS.sites]: Object.fromEntries(entries) });
    } catch {
      // 写失败不影响当前会话的可用性，只是下次进来会回到默认的"不显示"
    }
  }

  return { shouldOpen, remember };
}
