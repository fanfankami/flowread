/**
 * 设置读写。
 *
 * 只有 service worker 会 import 这个模块。API Key 存在这里，
 * 因此任何 content script 都不得直接读取 settings 对象 ——
 * 对外一律走 toPublicSettings()，把 apiKey 摘掉。
 */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '@/shared/constants';
import type { AppSettings, PublicSettings } from '@/types';

export async function getSettings(): Promise<AppSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const saved = (stored[STORAGE_KEYS.settings] ?? {}) as Partial<AppSettings>;
  // 合并默认值而不是直接返回：旧版本存下的对象缺少新字段时不会崩
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = { ...current, ...patch };

  // 少量规范化，避免用户填了带尾斜杠的地址导致拼接出双斜杠
  next.baseUrl = next.baseUrl.trim().replace(/\/+$/, '');
  next.model = next.model.trim();

  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

/** 去掉密钥后的视图，可以安全地发给 content script。 */
export function toPublicSettings(settings: AppSettings): PublicSettings {
  const { apiKey, ...rest } = settings;
  return { ...rest, hasApiKey: apiKey.trim().length > 0 };
}
