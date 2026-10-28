/**
 * 端到端验收（真实 Chromium + 真实扩展）。
 *
 * 核心是三条产品约定：
 * 1. 装上之后，页面里**什么都不该出现**
 * 2. 用户划词才出气泡，点气泡才开浮窗
 * 3. 关掉之后，这个站点下次进来自动不出现
 *
 * 运行：node scripts/e2e.mjs
 * 前置：npm run build
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(rootDir, '.output', 'chrome-mv3');

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>HashMap 扩容机制详解 - 小林 Coding</title>
<style>
  /* 正文左对齐且限宽：浮窗展开后停在右下角，
     若正文居中，右端会落在浮窗下方，拖选终点被浮窗吃掉。 */
  body { margin: 0; padding: 32px 24px; max-width: 620px; font: 16px/1.85 system-ui, sans-serif; color: #111; }
  h1 { font-size: 24px; }
  h2 { font-size: 18px; margin-top: 30px; }
  p { margin: 12px 0; }
  pre { background: #f4f5f8; padding: 12px; border-radius: 8px; overflow: auto; font-size: 13.5px; }
  #editable { margin-top: 24px; padding: 10px; border: 1px solid #ccc; border-radius: 6px; }
</style>
</head>
<body>
<article>
  <h1>HashMap 扩容机制详解</h1>
  <h2>一、为什么容量一定是 2 的幂</h2>
  <p>HashMap 在计算元素下标时，使用的是 (n - 1) &amp; hash 而不是取模运算。</p>
  <p id="target">当链表长度超过 8 且数组长度大于等于 64 时，链表会转换为红黑树，以降低极端情况下的查询时间复杂度。</p>
  <p id="p2">之所以选择 8 而不是更小的值，是因为链路长度达到 8 的概率已经极低。</p>
  <pre><code>if (binCount >= TREEIFY_THRESHOLD - 1)
    treeifyBin(tab, hash);</code></pre>
  <h2>二、扩容时元素的迁移规律</h2>
  <p id="p3">扩容后元素的新位置要么是原位置，要么是原位置加原数组长度。</p>
  <p>理解这一点，就能明白为什么 JDK 8 用高低位拆分代替了 JDK 7 的重新计算 hash。</p>
  <h2>三、负载因子为什么是 0.75</h2>
  <p>负载因子决定了扩容的时机。取值过高会让冲突变多，取值过低会浪费大量空间。</p>
  <p>0.75 是在空间利用率和查询效率之间取的一个折中值，同时它还能让容量在扩容后仍然是 2 的幂。</p>
  <pre><code>if (++size &gt; threshold)
    resize();</code></pre>
  <h2>四、树化之后还会退化回链表吗</h2>
  <p>会。在扩容或者删除元素时，如果红黑树的节点数降到 6 以下，就会重新退化成链表。</p>
  <p>这个 6 和 8 之间留出的缓冲区，是为了避免在边界值附近反复树化与退化，造成性能抖动。</p>
  <div id="editable" contenteditable="true">这是一段可编辑内容，在里面划选不应该触发捕获。</div>
</article>
</body>
</html>`;

const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? '');
  } catch (error) {
    record(name, false, error.message ?? String(error));
  }
}

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE_HTML);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const pageUrl = `http://127.0.0.1:${port}/article`;

const profileDir = mkdtempSync(path.join(tmpdir(), 'flowread-e2e-'));
let context;
let page;

/** 页面上是否存在浮窗 / 气泡 */
function probe() {
  return page.evaluate(() => {
    const shadow = document.querySelector('#flowread-root')?.shadowRoot;
    return {
      host: Boolean(document.querySelector('#flowread-root')),
      panel: Boolean(shadow?.querySelector('.fr-panel')),
      pill: Boolean(shadow?.querySelector('.fr-pill')),
      launcher: Boolean(shadow?.querySelector('.fr-launcher')),
    };
  });
}

async function waitForStreamEnd(timeout = 30000) {
  await page.waitForFunction(() => {
    const shadow = document.querySelector('#flowread-root')?.shadowRoot;
    if (!shadow) return false;
    return shadow.querySelectorAll('.fr-msg.is-streaming').length === 0;
  }, { timeout });
}

/**
 * 用 Range 直接选中整段并派发 pointerup。
 *
 * 为什么不用真实鼠标：Playwright 在"页面上已有选区"的情况下连续第二次拖选，
 * 不再派发 pointerup（实测：日志里只有第一次的事件）。这是合成事件的行为，
 * 真实浏览器不会有这个问题。所以"重复选中同一段"的场景改用这种方式，
 * 真实拖选链路由第一个用例单独覆盖。
 */
async function selectViaRange(selector) {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) return;
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, selector);
  await page.waitForTimeout(500);
}

async function selectParagraph(selector) {
  const box = await page.locator(selector).boundingBox();
  // y 取首行内部（不是 height/2）：两行以上的段落中线正好落在行距空白上，
  // mouse.down 按在空白处不会启动选区。
  const y = box.y + Math.min(12, box.height / 3);
  await page.mouse.move(box.x + 5, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 5, y, { steps: 8 });
  await page.mouse.up();
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
  });

  // 全新的 profile 会被当成"首次安装"，扩展会自动打开设置页。
  // 那个页面会抢占导航，把后续的 page.goto 打断，所以先等它出来再关掉。
  await new Promise((resolve) => setTimeout(resolve, 900));
  for (const opened of context.pages()) {
    if (opened.url().startsWith('chrome-extension://')) {
      await opened.close().catch(() => undefined);
    }
  }

  page = await context.newPage();
  page.on('pageerror', (error) => console.log('[pageerror]', error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.log('[console.error]', message.text());
  });
  await page.goto(pageUrl, { waitUntil: 'load' });

  console.log('\n[1] 默认零存在感');

  await check('注入成功，但页面上不出现任何 UI', async () => {
    await page.waitForSelector('#flowread-root', { state: 'attached', timeout: 15000 });
    // 多等一会儿，确认不是"晚一点才弹出来"
    await page.waitForTimeout(1600);
    const state = await probe();
    assert.equal(state.panel, false, '浮窗自动出现了');
    assert.equal(state.pill, false, '气泡自动出现了');
    assert.equal(state.launcher, false, '残留了悬浮入口按钮');
    return `host 已就绪，UI 为空`;
  });

  console.log('\n[2] 划词才出气泡');

  await check('划词后出现操作气泡，但浮窗仍然不出现', async () => {
    await selectParagraph('#target');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });
    const state = await probe();
    assert.equal(state.panel, false, '划词时浮窗不该自己弹出来');
    return '气泡已出现，浮窗未展开';
  });

  await check('滚动页面时气泡自动收起', async () => {
    await page.mouse.wheel(0, 200);
    await page.waitForTimeout(300);
    const state = await probe();
    assert.equal(state.pill, false, '滚动后气泡仍留在原地');
    // 滚回去，方便后续操作
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(300);
  });

  await check('点「追问」后讨论对象卡片仍然显示', async () => {
    // 气泡可能因上一步滚动而收起，重新划一次
    const first = await probe();
    if (!first.pill) {
      await selectViaRange('#target');
      await page.waitForSelector('.fr-pill', { timeout: 6000 });
    }

    await page.locator('.fr-pill-btn', { hasText: '追问' }).first().click();
    await page.waitForSelector('.fr-panel', { timeout: 8000 });

    const quote = (await page.locator('.fr-anchor-quote').textContent())?.trim() ?? '';
    assert.ok(quote.length > 5, '追问之后"正在讨论"卡片变空了');

    const after = await probe();
    assert.equal(after.pill, false, '追问后气泡没有收起');

    // 换段落点追问会开新会话并自动解释，必须等它跑完再继续
    await waitForStreamEnd();
    return quote.slice(0, 16);
  });

  await check('历史视图下划词也能出气泡', async () => {
    // 当前停在对话视图，切到历史
    await page.locator('.fr-header-actions .fr-icon-btn[title="历史记录"]').click();
    await page.waitForSelector('.fr-history', { timeout: 6000 });

    // 关键：以前这里写死了 view === 'chat'，在读历史时划词完全没反应
    await selectViaRange('#target');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });

    // 只验证气泡出现，不点解释 —— 否则会新建会话，把后面用例的消息计数打乱
    // 切回对话视图
    await page.locator('.fr-header .fr-icon-btn[title="返回"]').click();
    await page.waitForSelector('.fr-list', { timeout: 6000 });
  });

  console.log('\n[3] 点气泡才展开浮窗');

  await check('点「解释」后浮窗展开并流式渲染 Markdown', async () => {
    // 前面的用例已经建过会话，这里刷新一次回到干净状态，
    // 否则"用户消息与回答成对出现"这类计数断言会被污染
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#flowread-root', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(1200);

    if (!(await probe()).pill) {
      await selectViaRange('#target');
      await page.waitForSelector('.fr-pill', { timeout: 6000 });
    }

    await page.locator('.fr-pill-btn').first().click();
    await page.waitForSelector('.fr-panel', { timeout: 10000 });
    await page.waitForSelector('.fr-md', { timeout: 20000 });
    await waitForStreamEnd();

    const html = (await page.locator('.fr-md').last().innerHTML()) ?? '';
    assert.ok(html.includes('<h2'), 'Markdown 标题未渲染');
    assert.ok(html.includes('fr-code'), '代码块未渲染');

    const state = await probe();
    assert.equal(state.pill, false, '展开浮窗后气泡应该收起');
    return `${html.length} 字符 HTML`;
  });

  await check('用户消息与回答成对出现', async () => {
    const users = await page.locator('.fr-user-text').count();
    const bots = await page.locator('.fr-md').count();
    assert.equal(users, 1);
    assert.equal(bots, 1);
  });

  console.log('\n[4] 连续追问与上下文锁定');

  await check('追问得到第二轮回答', async () => {
    await page.locator('.fr-input').fill('为什么阈值是 8 而不是更小？');
    await page.locator('.fr-input').press('Enter');
    await page.waitForFunction(() => {
      const shadow = document.querySelector('#flowread-root')?.shadowRoot;
      return (shadow?.querySelectorAll('.fr-md').length ?? 0) >= 2;
    }, { timeout: 20000 });
    await waitForStreamEnd();
    assert.equal(await page.locator('.fr-md').count(), 2);
  });


  await check('换另一段后点追问，讨论对象跟着切换', async () => {
    const before = (await page.locator('.fr-anchor-quote').textContent())?.trim() ?? '';

    await selectViaRange('#p2');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });
    await page.locator('.fr-pill-btn', { hasText: '追问' }).first().click();
    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    await page.waitForTimeout(700);

    const after = (await page.locator('.fr-anchor-quote').textContent())?.trim() ?? '';
    assert.notEqual(after, before, '换了段落点追问，讨论对象没跟着变');
    assert.ok(after.length > 5, '新的讨论对象为空');

    await waitForStreamEnd();
    return after.slice(0, 16);
  });

  await check('滚动页面不改变讨论对象', async () => {
    const before = await page.locator('.fr-anchor-quote').textContent();
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(900);
    const after = await page.locator('.fr-anchor-quote').textContent();
    assert.equal(after?.trim(), before?.trim(), '滚动后讨论对象被改动了');
    // 滚回顶部，否则后面的用例点到的是视口外的元素
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(400);
    return before?.trim()?.slice(0, 14);
  });

  await check('停止生成后已输出内容保留', async () => {
    await page.locator('.fr-input').fill('举个代码例子');
    await page.locator('.fr-input').press('Enter');
    await page.waitForSelector('.fr-msg.is-streaming', { timeout: 15000 });
    await page.waitForTimeout(420);
    await page.locator('.fr-composer-actions .fr-icon-btn').first().click();
    await page.waitForTimeout(600);

    const tag = await page.locator('.fr-msg-tag').last().textContent();
    assert.equal(tag?.trim(), '已停止');
    const partial = await page.locator('.fr-md').last().textContent();
    assert.ok((partial?.length ?? 0) > 0, '停止后内容被清空');
  });

  console.log('\n[5] 窗口交互');

  await check('拖动标题栏移动窗口', async () => {
    const before = await page.locator('.fr-panel').evaluate((el) => el.style.left);
    const header = await page.locator('.fr-header').boundingBox();
    const startX = header.x + 120;
    const startY = header.y + header.height / 2;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX - 460, startY - 110, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await page.locator('.fr-panel').evaluate((el) => el.style.left);
    assert.ok(Number.parseFloat(after) - Number.parseFloat(before) < -360, '位移不足');
  });

  await check('拖动时不会选中页面文字', async () => {
    const header = await page.locator('.fr-header').boundingBox();
    await page.mouse.move(header.x + 120, header.y + header.height / 2);
    await page.mouse.down();
    await page.mouse.move(header.x + 210, header.y + header.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    assert.equal(selected, '');
  });

  await check('拖右下角缩放', async () => {
    const before = await page.locator('.fr-panel').boundingBox();
    const handle = await page.locator('.fr-handle-se').boundingBox();
    await page.mouse.move(handle.x + 8, handle.y + 8);
    await page.mouse.down();
    await page.mouse.move(handle.x + 58, handle.y + 48, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const after = await page.locator('.fr-panel').boundingBox();
    assert.ok(after.width > before.width + 30);
    return `${Math.round(before.width)} → ${Math.round(after.width)}`;
  });

  await check('拖右边缘只改宽度，左侧位置不动', async () => {
    const before = await page.locator('.fr-panel').boundingBox();
    const handle = await page.locator('.fr-handle-e').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 70, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const after = await page.locator('.fr-panel').boundingBox();
    assert.ok(after.width > before.width + 40, `宽度未增长: ${before.width} → ${after.width}`);
    assert.ok(Math.abs(after.x - before.x) < 2, `左侧位置被带动了: ${before.x} → ${after.x}`);
    assert.ok(Math.abs(after.height - before.height) < 2, '高度不该变');
    return `宽度 ${Math.round(before.width)} → ${Math.round(after.width)}`;
  });

  await check('拖左边缘时右边界保持不动', async () => {
    const before = await page.locator('.fr-panel').boundingBox();
    const rightEdge = before.x + before.width;
    const handle = await page.locator('.fr-handle-w').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 60, handle.y + handle.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const after = await page.locator('.fr-panel').boundingBox();
    assert.ok(after.x < before.x - 30, `左边界未移动: ${before.x} → ${after.x}`);
    assert.ok(after.width > before.width + 30, '宽度未同步变大');
    // 这是"自由缩放"最关键的手感：拖左边时右边必须钉住
    assert.ok(Math.abs(after.x + after.width - rightEdge) < 2, `右边界漂移: ${rightEdge} → ${after.x + after.width}`);
    return `x ${Math.round(before.x)} → ${Math.round(after.x)}`;
  });

  await check('缩放不会小于最小尺寸', async () => {
    const handle = await page.locator('.fr-handle-e').boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 900, handle.y + handle.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const box = await page.locator('.fr-panel').boundingBox();
    assert.ok(box.width >= 340, `宽度低于最小值: ${box.width}`);
    return `收缩到 ${Math.round(box.width)}px`;
  });

  await check('最小化与恢复', async () => {
    const before = await page.locator('.fr-panel').boundingBox();
    await page.locator('.fr-header-actions .fr-icon-btn[title="最小化"]').click();
    await page.waitForTimeout(350);
    const mini = await page.locator('.fr-panel').boundingBox();
    assert.ok(mini.width < 60);
    await page.locator('.fr-min-btn').click();
    await page.waitForTimeout(350);
    const restored = await page.locator('.fr-panel').boundingBox();
    assert.ok(Math.abs(restored.width - before.width) < 3);
  });

  await check('浮窗不遮挡页面点击', async () => {
    await page.evaluate(() => {
      document.querySelector('h1').addEventListener('click', () => {
        window.__clicked = true;
      }, { once: true });
    });
    const heading = await page.locator('h1').boundingBox();
    await page.mouse.click(heading.x + 15, heading.y + heading.height / 2);
    assert.ok(await page.evaluate(() => window.__clicked === true), '点击没到达页面');
  });

  console.log('\n[6] 关闭与站点记忆');

  await check('关闭后浮窗彻底消失，不留任何入口', async () => {
    await page.locator('.fr-header-actions .fr-icon-btn[title="关闭"]').click();
    await page.waitForTimeout(400);
    const state = await probe();
    assert.equal(state.panel, false, '关闭后浮窗仍在');
    assert.equal(state.pill, false, '关闭后气泡仍在');
    assert.equal(state.launcher, false, '关闭后仍残留入口按钮');
  });

  await check('刷新页面后不会自动出现（记住关闭）', async () => {
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#flowread-root', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(1600);
    const state = await probe();
    assert.equal(state.panel, false, '刷新后浮窗又自己出现了');
    return '站点偏好已生效';
  });

  await check('关闭状态下划词，气泡仍然可用', async () => {
    await selectViaRange('#target');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });
    const state = await probe();
    assert.equal(state.pill, true);
    assert.equal(state.panel, false);
  });

  console.log('\n[7] 主动唤出（对应扩展图标的"在本页打开"）');

  await check('content script 能响应 ping（消息链路可用）', async () => {
    const workers = context.serviceWorkers();
    if (workers.length === 0) throw new Error('service worker 未就绪');

    const alive = await workers[0].evaluate(async () => {
      const tabs = await chrome.tabs.query({ active: true });
      const tab = tabs.find((item) => typeof item.id === 'number');
      if (!tab?.id) return false;
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'flowread:ping' });
        return response?.ok === true;
      } catch {
        return false;
      }
    });

    assert.ok(alive, 'ping 没有收到响应，popup 的"在本页打开"也会失败');
  });

  await check('外部 show 消息能把浮窗唤出来', async () => {
    // 直接模拟 popup 的行为：向当前标签页发 flowread:show
    const workers = context.serviceWorkers();
    if (workers.length === 0) {
      throw new Error('service worker 未就绪，跳过');
    }
    await workers[0].evaluate(async () => {
      // service worker 没有"当前窗口"的概念，currentWindow 会查不到页面，
      // 这里退化成"所有窗口里处于激活状态的标签页"
      const tabs = await chrome.tabs.query({ active: true });
      const tab = tabs.find((item) => typeof item.id === 'number');
      if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'flowread:show' });
    });

    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    return '消息链路可用';
  });

  await check('打开过一次后，刷新会自动出现（记住打开）', async () => {
    await page.waitForTimeout(500);
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#flowread-root', { state: 'attached', timeout: 10000 });
    await page.waitForTimeout(1500);
    const state = await probe();
    assert.equal(state.panel, true, '记住的"打开"状态没生效');
  });

  await check('浮窗字体未被页面样式污染', async () => {
    const font = await page.locator('.fr-panel').evaluate((el) => getComputedStyle(el).fontFamily);
    assert.ok(!/Times New Roman/i.test(font), `字体异常: ${font}`);
    return font.split(',')[0];
  });

  console.log('\n[8] 生命周期');

  await check('扩展失效后自动从页面清除自己', async () => {
    // 必须放在最后：重载扩展会让后续用例全部失效
    const before = await page.evaluate(() => ({
      host: Boolean(document.querySelector('#flowread-root')),
      style: Boolean(document.getElementById('flowread-highlight-style')),
    }));
    assert.equal(before.host, true, '前置条件不成立：页面上没有浮窗');

    const workers = context.serviceWorkers();
    if (workers.length === 0) throw new Error('service worker 未就绪');
    try {
      await workers[0].evaluate(() => chrome.runtime.reload());
    } catch {
      // 重载瞬间连接必然断开，属于预期
    }

    await page.waitForTimeout(3600);

    const after = await page.evaluate(() => ({
      host: Boolean(document.querySelector('#flowread-root')),
      style: Boolean(document.getElementById('flowread-highlight-style')),
      lock: document.querySelectorAll('style[data-flowread-lock]').length,
    }));
    assert.equal(after.host, false, '扩展失效了，浮窗还挂在页面上');
    assert.equal(after.style, false, '高亮样式残留');
    assert.equal(after.lock, 0, '拖动锁样式残留');
  });
} finally {
  if (context) await context.close();
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
}

const passed = results.filter((item) => item.ok).length;
const failed = results.length - passed;

console.log(`\n${'='.repeat(54)}`);
console.log(`验收结果：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
console.log('='.repeat(54));

if (failed > 0) {
  console.log('\n失败项：');
  for (const item of results.filter((entry) => !entry.ok)) {
    console.log(`  - ${item.name}\n      ${item.detail}`);
  }
  process.exitCode = 1;
}
