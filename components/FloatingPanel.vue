<script setup lang="ts">
/**
 * FlowRead 悬浮窗主容器。
 *
 * 只做编排：布局、视图切换、把选区 / 对话 / 阅读位置三者接起来。
 * 具体逻辑都在 composable 和子组件里，方便单独测试。
 */
import { computed, inject, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import ChatView from './ChatView.vue';
import HistoryView from './HistoryView.vue';
import SettingsView from './SettingsView.vue';
import SelectionPill from './SelectionPill.vue';
import { useChat } from '@/composables/useChat';
import { HIGHLIGHT_COLORS, useAnchorHighlight } from '@/composables/useAnchorHighlight';
import { useAppearance } from '@/composables/useAppearance';
import { useDragResize } from '@/composables/useDragResize';
import { useReadingPosition } from '@/composables/useReadingPosition';
import { useSelection } from '@/composables/useSelection';
import { useSitePreference } from '@/composables/useSitePreference';
import { backgroundClient } from '@/composables/useBackground';
import { DEFAULT_SETTINGS, EXPLAIN_QUESTION, SUMMARIZE_PAGE_QUESTION, STORAGE_KEYS } from '@/shared/constants';
import { buildAnchor, locateAnchor, scrollToAnchor } from '@/utils/anchor';
import { getSurroundingText, normalizeParagraph } from '@/utils/dom-context';
import { clampRect, defaultRect, minimizedRect } from '@/utils/geometry';
import type { Anchor, LayoutState, PublicSettings, Rect, Viewport } from '@/types';

type View = 'chat' | 'history' | 'settings';

const MIN_SIZE = { minWidth: 340, minHeight: 320 };
const DEFAULT_SIZE = { width: 396, height: 580 };
const ICON_SIZE = 46;

/** 八个缩放方向。四边给细长热区，四角给方形热区，合起来覆盖整个边框 */
const RESIZE_EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

const isOwnNode = inject<(node: Node) => boolean>('flowread:isOwnNode', () => false);
/** 由 content script 入口注入：扩展图标点击后要求展开浮窗 */
const showSignal = inject<Ref<number>>('flowread:showSignal', ref(0));

const { shouldOpen, remember } = useSitePreference();

/* ---------------- 布局 ---------------- */

const viewport = ref<Viewport>({ width: window.innerWidth, height: window.innerHeight });
const rect = ref<Rect>(defaultRect(viewport.value, DEFAULT_SIZE));
const minimized = ref(false);
/** 默认不显示。是否出现完全由"站点偏好"决定，绝不自动往页面里塞东西。 */
const hidden = ref(true);

const { mode, startDrag, startResize } = useDragResize({
  rect,
  viewport,
  limit: MIN_SIZE,
  onCommit: persistLayout,
});

const displayRect = computed<Rect>(() => (minimized.value ? minimizedRect(rect.value, ICON_SIZE, viewport.value) : rect.value));
const panelStyle = computed(() => ({
  left: `${displayRect.value.x}px`,
  top: `${displayRect.value.y}px`,
  width: `${displayRect.value.width}px`,
  height: `${displayRect.value.height}px`,
}));

/* ---------------- 数据 ---------------- */

const view = ref<View>('chat');
const settings = ref<PublicSettings>({ ...DEFAULT_SETTINGS, hasApiKey: false });

const {
  anchor: selectionAnchor,
  pillRect,
  range: selectionRange,
  settleTick,
  dismissSelection,
  clear: clearSelection,
} = useSelection({ isOwnNode, minLength: 4 });
const { current: reading, element: readingElement, supported: readingSupported } = useReadingPosition();
const highlight = useAnchorHighlight();

// 解构出来才能在模板里直接使用（模板不会自动解包嵌套在对象里的 ref）
const {
  messages,
  conversation,
  streaming,
  errorMessage,
  toolLabel,
  explain,
  ask,
  stop,
  regenerate,
  load: loadConversation,
  reset: resetChat,
} = useChat();

const chatViewRef = ref<InstanceType<typeof ChatView> | null>(null);

/** 待发送的截图。不持久化，发完即弃 */
const pendingImage = ref<string | null>(null);

async function onCapture(): Promise<void> {
  try {
    // 截图必须由 background 调 chrome.tabs.captureVisibleTab，
    // content script 拿不到这个 API
    const dataUrl = await backgroundClient.send<string>({ type: 'capture:tab' }, 10000);
    pendingImage.value = dataUrl;
    errorMessage.value = '';
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '截图失败，请刷新页面后重试';
  }
}

/**
 * 气泡是否已被用户"消费掉"。
 *
 * 刻意和锚点分开：点完「追问」之后气泡要收起，但那段文字仍然是讨论对象，
 * 卡片还得显示。如果把两者绑在一起，就会出现"点了追问，正在讨论直接消失"。
 */
const pillDismissed = ref(false);

/** 会话一旦建立，锚点就固定，不随滚动改变 */
const conversationAnchor = computed<Anchor | null>(() => conversation.value?.anchor ?? null);
const activeAnchor = computed(() => conversationAnchor.value ?? selectionAnchor.value);
const demoMode = computed(() => settings.value.provider === 'demo');

const { attrs: appearanceAttrs } = useAppearance(settings);

// 页面上的高亮拿不到 shadow 内的 CSS 变量，颜色只能由 JS 传过去
watch(
  () => settings.value.accent,
  (accent) => {
    highlight.setColor(HIGHLIGHT_COLORS[accent]?.light ?? HIGHLIGHT_COLORS.mono.light);
  },
  { immediate: true },
);

// 不再限制必须是 chat 视图：在读历史时划词也应该能直接提问
const pillVisible = computed(
  () =>
    Boolean(selectionAnchor.value) &&
    !pillDismissed.value &&
    !minimized.value &&
    // 正在生成时点了也不会有反应（explain/ask 都会被 streaming 挡住），
    // 与其让用户点了没反馈，不如干脆不出气泡
    !streaming.value,
);

/* ---------------- 布局持久化 ---------------- */

let saveTimer: number | null = null;

function persistLayout(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    // 只存几何信息。是否显示属于"站点偏好"，跟窗口布局是两件事，不要混在一个键里
    const layout: LayoutState = { rect: rect.value, minimized: minimized.value };
    void chrome.storage.local.set({ [STORAGE_KEYS.layout]: layout }).catch(() => undefined);
  }, 160);
}

async function restoreLayout(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.layout);
    const layout = stored[STORAGE_KEYS.layout] as LayoutState | undefined;
    if (!layout?.rect) return;
    rect.value = clampRect(layout.rect, viewport.value, MIN_SIZE);
    minimized.value = Boolean(layout.minimized);
  } catch {
    // 隐私模式下 storage 可能不可用，保持默认布局即可
  }
}

/* ---------------- 设置 ---------------- */

async function loadSettings(): Promise<void> {
  try {
    settings.value = await backgroundClient.send<PublicSettings>({ type: 'settings:get' });
  } catch {
    // 后台还没醒，先用默认值
  }
}

/**
 * 设置页改外观后，所有已经打开的页面要立刻跟着变。
 * 没有这条监听，用户得刷新页面才能看到效果，会以为没生效。
 */
function onSettingsChanged(changes: Record<string, chrome.storage.StorageChange>, area: string): void {
  if (area !== 'local' || !changes[STORAGE_KEYS.settings]) return;
  void loadSettings();
}

chrome.storage.onChanged.addListener(onSettingsChanged);
onUnmounted(() => chrome.storage.onChanged.removeListener(onSettingsChanged));

/* ---------------- 交互 ---------------- */

function onExplain(prompt: string = EXPLAIN_QUESTION): void {
  const anchor = selectionAnchor.value;
  if (!anchor) return;

  // 先留住 Range 副本：下面 clearSelection 会把选区清掉，
  // 但高亮要在选区消失之后继续存在。
  const capturedRange = selectionRange.value;
  const previousUrl = conversation.value?.anchor.url;

  // 换了讨论对象（或换了文章）= 开新会话。旧会话仍在历史里，不会丢。
  if (conversation.value && (conversation.value.anchor.text !== anchor.text || previousUrl !== anchor.url)) {
    resetChat();
  }

  showPanel(false);
  view.value = 'chat';
  // 收起气泡，但保留锚点：解释失败时卡片仍然要能显示"你刚才问的是这段"。
  // dismissSelection 必须调 —— 否则 220ms 后的 settle 会让气泡重新冒出来。
  pillDismissed.value = true;
  dismissSelection();
  highlight.apply(capturedRange);
  void explain(anchor, prompt, reading.value?.paragraph);
}

function onAskFromPill(): void {
  const anchor = selectionAnchor.value;
  if (!anchor) return;

  const current = conversationAnchor.value;
  // 用户划了一段新文字再点追问，意图是"我要问这段"，不是继续问上一段
  const switched = !current || current.text !== anchor.text || current.url !== anchor.url;

  // 和「解释」一样要留住 Range：页面选区随后会被清掉，
  // 不提前抓副本的话，追问时页面就完全没有"正在讨论哪段"的视觉标记了。
  const capturedRange = selectionRange.value;

  showPanel(true);
  view.value = 'chat';
  pillDismissed.value = true;
  dismissSelection();
  highlight.apply(capturedRange);

  if (switched) {
    // 换段落：清掉上一段的对话，让讨论对象卡片显示新选中的内容。
    // **刻意不自动发请求** —— 追问的语义是"我要自己问"，
    // 如果这里替他发一条"解释"，它和「解释」按钮就没有任何区别了。
    // 反馈靠两件事传达：对话被清空 + 卡片换成新段落。
    resetChat();
  }

  window.setTimeout(() => chatViewRef.value?.focusInput(), 70);
}

/**
 * 总结整篇文章。
 *
 * 不依赖选区 —— 用户可能只是想"这篇讲了什么"。
 * 用当前阅读位置伪造一个锚点，因为会话必须绑定某段原文才能建立上下文。
 * 真正的全文靠 Agent 工具去取，这里只是给它一个起点。
 */
function onSummarizePage(): void {
  const now = reading.value;
  const anchor: Anchor =
    now
      ? {
          text: now.paragraph.slice(0, 240),
          paragraph: now.paragraph,
          heading: now.heading,
          before: '',
          after: '',
          blockIndex: 0,
          url: location.href,
          pageTitle: document.title,
        }
      : (selectionAnchor.value as Anchor);

  if (!anchor) return;

  showPanel(false);
  view.value = 'chat';
  pillDismissed.value = true;
  resetChat();
  void explain(anchor, SUMMARIZE_PAGE_QUESTION, now?.paragraph);
}

/** 用户一旦开始操作浮窗，就不再需要那个选区气泡了 */
function onPanelPointerDown(): void {
  if (!pillDismissed.value) pillDismissed.value = true;
}

function onSend(question: string): void {
  const image = pendingImage.value ?? undefined;
  pendingImage.value = null;
  const anchor = conversationAnchor.value ?? selectionAnchor.value;
  if (!anchor) return;
  void ask(question, anchor, reading.value?.paragraph, image);
}

/** 把讨论对象换成当前阅读位置 */
function onSwitchAnchor(): void {
  const element = readingElement.value;
  const current = reading.value;
  if (!element || !current) return;

  const { before, after } = getSurroundingText(element as HTMLElement);
  const next = buildAnchor({
    text: current.paragraph.slice(0, 120),
    paragraph: normalizeParagraph(element as HTMLElement),
    heading: current.heading,
    before,
    after,
    block: element,
  });

  resetChat();
  pillDismissed.value = true;

  // 切段落后同样标出原文位置，不然用户不知道现在讨论的是哪一段
  const range = document.createRange();
  range.selectNodeContents(element);
  highlight.apply(range);

  void explain(next, EXPLAIN_QUESTION, current.paragraph);
}

function onToggleMinimize(): void {
  minimized.value = !minimized.value;
  persistLayout();
}

/**
 * 展开浮窗。会记住"用户在这个站点想用它"，下次进站自动出现。
 * @param focusInput 是否要把光标放进输入框
 */
function showPanel(focusInput: boolean): void {
  hidden.value = false;
  minimized.value = false;
  rect.value = clampRect(rect.value, viewport.value, MIN_SIZE);
  void remember(true);
  persistLayout();
  if (focusInput) {
    window.setTimeout(() => chatViewRef.value?.focusInput(), 80);
  }
}

/**
 * 关闭浮窗。
 *
 * 语义是"我在这个站点不想看到它"，所以会写进站点偏好：
 * 下次访问同站不再自动出现，但仍然可以划词唤出。
 */
function onClose(): void {
  hidden.value = true;
  pillDismissed.value = true;
  clearSelection();
  // 关掉之后页面上还留着一块高亮会很怪，一并清掉
  highlight.clear();
  void remember(false);
  persistLayout();
}

/** 「回到原文」：把视口滚到锚点位置，并让高亮闪一下做视觉引导 */
function onLocate(): void {
  // 优先用当前会话的锚点；没有会话时用最近一次选区
  const anchor = conversation.value?.anchor ?? selectionAnchor.value;
  if (!anchor) return;

  const result = locateAnchor(anchor);
  if (!result.ok) {
    // 定位失败时至少让已有高亮闪一下，提示原文可能已经变了
    highlight.flash();
    return;
  }

  scrollToAnchor(result.element);
  const range = document.createRange();
  range.selectNodeContents(result.element);
  highlight.apply(range);
}

function onOpenHistory(): void {
  view.value = view.value === 'history' ? 'chat' : 'history';
}

/**
 * 设置直接在浮窗里切换视图。
 * 跳独立标签页会让用户觉得"点了个按钮就飞走了"，而且外观配置根本不需要额外权限。
 * 只有自定义服务商要申请域名权限，那一项会引导到完整设置页。
 */
function onOpenSettings(): void {
  view.value = view.value === 'settings' ? 'chat' : 'settings';
}

function onBack(): void {
  view.value = 'chat';
}

async function onOpenConversation(id: string): Promise<void> {
  try {
    await loadConversation(id);
    view.value = 'chat';
  } catch {
    view.value = 'history';
  }
}

/* ---------------- 自动解释 ---------------- */

let lastAutoKey = '';

/**
 * 每次成功选中都重新给一次操作机会 —— 包括"滚动后又选了同一段文字"。
 * 这个 watch 必须注册在 autoExplain 之前：自动解释会主动收起气泡，
 * 如果顺序反了，气泡会被这里的重置逻辑重新叫出来。
 */
watch(settleTick, () => {
  pillDismissed.value = false;
});

watch(selectionAnchor, (next) => {
  if (!next) return;

  if (!settings.value.autoExplain) return;
  // 不判断 view：在读历史时划词也该直接出结果
  if (minimized.value) return;

  const key = `${next.url}|${next.text}`;
  if (key === lastAutoKey) return;
  lastAutoKey = key;
  onExplain();
});

/**
 * 滚动时收起气泡。
 *
 * 气泡的位置是选区那一刻的快照，页面一滚它就和选区错位了，
 * 留在屏幕上只会变成一个"飘着的按钮"。
 */
function onPageScroll(): void {
  if (!pillDismissed.value && selectionAnchor.value) {
    pillDismissed.value = true;
  }
}

/**
 * 右键唤起上下文菜单时把气泡收起来。
 * 用户右键是要复制/搜索/翻译，气泡浮在那儿只会挡菜单。
 */
function onContextMenu(): void {
  if (!pillDismissed.value) pillDismissed.value = true;
}

window.addEventListener('scroll', onPageScroll, { passive: true });
document.addEventListener('contextmenu', onContextMenu, true);

onUnmounted(() => {
  window.removeEventListener('scroll', onPageScroll);
  document.removeEventListener('contextmenu', onContextMenu, true);
});

// 扩展图标 / 快捷键要求展开浮窗
watch(showSignal, () => showPanel(false));

onMounted(async () => {
  await restoreLayout();
  // 只有用户在这个站点主动开过，才自动显示。默认是关的。
  hidden.value = !(await shouldOpen());
  await loadSettings();
});
</script>

<template>
  <!-- 根元素都带 data-theme / data-accent / data-font，样式靠属性选择器切换变量 -->
  <!-- 默认什么都不渲染。浮窗只在用户主动唤出后才进入 DOM。 -->
  <section
    v-if="!hidden"
    v-bind="appearanceAttrs"
    class="fr-panel"
    :class="[`is-${mode}`, { 'is-min': minimized }]"
    :style="panelStyle"
    @pointerdown.capture="onPanelPointerDown"
  >
    <button v-if="minimized" class="fr-min-btn" type="button" title="展开 FlowRead" @click="onToggleMinimize">
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <path d="M4 5.5h12M4 10h12M4 14.5h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none" />
      </svg>
    </button>

    <template v-else>
      <header class="fr-header" @pointerdown="startDrag">
        <div class="fr-brand">
          <button v-if="view !== 'chat'" class="fr-icon-btn" type="button" title="返回" @pointerdown.stop @click="onBack">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M9.5 3.5L5 8l4.5 4.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <span class="fr-dot" aria-hidden="true"></span>
          <span class="fr-name">FlowRead</span>
          <span v-if="demoMode" class="fr-tag" title="当前为演示模式，未接入真实模型">演示</span>
          <span v-else-if="!readingSupported" class="fr-tag" title="未识别到正文容器，阅读跟随可能不准">正文?</span>
        </div>

        <div class="fr-header-actions" @pointerdown.stop>
          <button class="fr-icon-btn" type="button" title="总结整篇文章" @click="onSummarizePage">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M4 2.5h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z" stroke="currentColor" stroke-width="1.2" fill="none" />
              <path d="M5.6 6h4.8M5.6 8.4h4.8M5.6 10.8h2.8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>

          <button class="fr-icon-btn" type="button" title="历史记录" @click="onOpenHistory">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.4" fill="none" />
              <path d="M8 5v3.2l2.2 1.3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" />
            </svg>
          </button>
          <button class="fr-icon-btn" type="button" title="设置" @click="onOpenSettings">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="8" cy="8" r="2.1" stroke="currentColor" stroke-width="1.3" fill="none" />
              <path d="M12.9 9.6a1.1 1.1 0 0 0 .22 1.2l.04.04a1.32 1.32 0 1 1-1.87 1.87l-.04-.04a1.1 1.1 0 0 0-1.2-.22 1.1 1.1 0 0 0-.67 1v.1a1.32 1.32 0 1 1-2.64 0v-.06a1.1 1.1 0 0 0-.72-1 1.1 1.1 0 0 0-1.2.22l-.04.04a1.32 1.32 0 1 1-1.87-1.87l.04-.04a1.1 1.1 0 0 0 .22-1.2 1.1 1.1 0 0 0-1-.67h-.1a1.32 1.32 0 1 1 0-2.64h.06a1.1 1.1 0 0 0 1-.72 1.1 1.1 0 0 0-.22-1.2l-.04-.04a1.32 1.32 0 1 1 1.87-1.87l.04.04a1.1 1.1 0 0 0 1.2.22h.05a1.1 1.1 0 0 0 .67-1v-.1a1.32 1.32 0 1 1 2.64 0v.06a1.1 1.1 0 0 0 .67 1 1.1 1.1 0 0 0 1.2-.22l.04-.04a1.32 1.32 0 1 1 1.87 1.87l-.04.04a1.1 1.1 0 0 0-.22 1.2v.05a1.1 1.1 0 0 0 1 .67h.1a1.32 1.32 0 1 1 0 2.64h-.06a1.1 1.1 0 0 0-1 .67z" stroke="currentColor" stroke-width="1.1" fill="none" stroke-linejoin="round" />
            </svg>
          </button>
          <button class="fr-icon-btn" type="button" title="最小化" @click="onToggleMinimize">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M4 8h8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
            </svg>
          </button>
          <button class="fr-icon-btn" type="button" title="关闭" @click="onClose">
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
            </svg>
          </button>
        </div>
      </header>

      <main class="fr-body">
        <ChatView
          v-if="view === 'chat'"
          ref="chatViewRef"
          :messages="messages"
          :streaming="streaming"
          :anchor="activeAnchor"
          :reading="reading"
          :demo-mode="demoMode"
          :error-message="errorMessage"
          :compressed-count="conversation?.compressedCount ?? 0"
          :tool-label="toolLabel"
          :pending-image="pendingImage"
          @capture="onCapture"
          @clear-image="pendingImage = null"
          @ask="onSend"
          @stop="stop"
          @regenerate="regenerate"
          @switch-anchor="onSwitchAnchor"
          @locate="onLocate"
          @summarize="onSummarizePage"
          @open-settings="onOpenSettings"
        />

        <SettingsView
          v-else-if="view === 'settings'"
          :settings="settings"
          in-panel
          @updated="settings = $event"
          @close="onBack"
        />

        <HistoryView v-else @open="onOpenConversation" @close="onBack" />
      </main>

      <div
        v-for="edge in RESIZE_EDGES"
        :key="edge"
        class="fr-handle"
        :class="`fr-handle-${edge}`"
        :title="edge === 'se' ? '拖动调整大小' : undefined"
        @pointerdown="startResize($event, edge)"
      ></div>
    </template>
  </section>

  <SelectionPill
    v-if="pillVisible"
    v-bind="appearanceAttrs"
    :rect="pillRect"
    :busy="streaming"
    :custom-actions="settings.customActions"
    @action="onExplain"
    @ask="onAskFromPill"
    @dismiss="clearSelection"
  />
</template>
