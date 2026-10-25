import { defineConfig } from 'wxt';

/**
 * 权限设计：
 *
 * - `storage`：存浮窗布局和模型配置（含 Key，明文，已在设置页说明）
 * - `host_permissions` 只写死 DeepSeek 一个域名，默认路径不需要任何额外授权
 * - 自定义服务商走 `optional_host_permissions`，在设置页保存时按需申请，
 *   用户不填自定义地址就永远不会看到额外的授权弹窗
 *
 * 刻意不申请 `tabs`、`scripting`、`webRequest` —— 用不到，
 * 权限越多，商店审核越严，用户安装时的心理门槛也越高。
 */
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'FlowRead',
    description: '阅读助手：划词即问，上下文锁定，长对话不失忆',
    version: '0.3.1',
    permissions: ['storage'],
    host_permissions: ['https://api.deepseek.com/*'],
    optional_host_permissions: ['https://*/*'],
    // 设置项比较多，用独立标签页打开，塞在弹窗里会滚得很憋屈
    options_ui: { page: 'options.html', open_in_tab: true },
  },
});
