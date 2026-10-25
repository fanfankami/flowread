import { createApp } from 'vue';
// 直接复用浮窗的样式表：设置表单与浮窗共用同一套 CSS 变量和控件样式，
// 避免两处维护两份颜色/间距。
import '@/assets/inter.css';
import '@/assets/panel.css';
import './style.css';
import App from './App.vue';

createApp(App).mount('#app');
