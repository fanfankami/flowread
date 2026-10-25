import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 独立于 wxt.config.ts：WXT 的配置面向浏览器扩展构建，
// 单测只需要解析别名和测试环境，混在一起会让两边都变复杂。
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
