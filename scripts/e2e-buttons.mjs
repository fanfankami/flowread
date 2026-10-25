/**
 * 「解释 / 追问」两个按钮的行为矩阵。
 *
 * 这两颗按钮是全产品交互最密集的地方：涉及选区、会话切换、流式状态、面板可见性
 * 四个维度的组合。靠手点很难覆盖全，所以单独拉一套来跑。
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

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>测试页</title>
<style>body{margin:0;padding:30px 24px;max-width:600px;font:16px/1.9 system-ui}
p{margin:14px 0}</style></head><body>
<h2>第一节 唯一约束</h2>
<p id="a">防重复的关键还是唯一约束，后面两种写法都建立在前面的唯一索引基础上处理数据。</p>
<p id="b">如果只是先 SELECT 判断不存在，再 INSERT，并发时两个请求都可能查不到存在。</p>
<h2>第二节 索引</h2>
<p id="c">联合唯一索引的字段顺序会影响命中，最左前缀原则在这里同样适用。</p>
</body></html>`;

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
async function check(name, fn) {
  try {
    record(name, true, (await fn()) ?? '');
  } catch (error) {
    record(name, false, error.message ?? String(error));
  }
}

const server = createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  s.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const profileDir = mkdtempSync(path.join(tmpdir(), 'fr-btn-'));

let context;
let page;

const probe = () =>
  page.evaluate(() => {
    const sr = document.querySelector('#flowread-root')?.shadowRoot;
    return {
      pill: Boolean(sr?.querySelector('.fr-pill')),
      pillDisabled: sr?.querySelector('.fr-pill-btn')?.disabled ?? null,
      panel: Boolean(sr?.querySelector('.fr-panel')),
      users: sr?.querySelectorAll('.fr-user-text').length ?? 0,
      bots: sr?.querySelectorAll('.fr-md').length ?? 0,
      streaming: (sr?.querySelectorAll('.fr-msg.is-streaming').length ?? 0) > 0,
      anchor: sr?.querySelector('.fr-anchor-quote')?.textContent?.trim().slice(0, 12) ?? null,
    };
  });

const waitIdle = () =>
  page.waitForFunction(
    () => {
      const sr = document.querySelector('#flowread-root')?.shadowRoot;
      return sr && sr.querySelectorAll('.fr-msg.is-streaming').length === 0;
    },
    { timeout: 40000 },
  );

/** 用 Range 选词并派发 pointerup，避免 Playwright 连续拖选不再触发 pointerup 的问题 */
async function pick(selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, selector);
  await page.waitForTimeout(420);
}

/** 按文字点按钮，不用下标 —— 气泡里的动作数量会变，下标写死必然过时 */
async function clickPill(label) {
  await page.locator('.fr-pill-btn', { hasText: label }).first().click();
}

try {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-sandbox'],
  });

  // 首装会弹设置页，关掉避免抢导航
  await new Promise((r) => setTimeout(r, 900));
  for (const opened of context.pages()) {
    if (opened.url().startsWith('chrome-extension://')) await opened.close().catch(() => undefined);
  }

  page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForSelector('#flowread-root', { state: 'attached', timeout: 15000 });

  console.log('\n[A] 首次使用');

  await check('划词后气泡出现且按钮可用', async () => {
    await pick('#a');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });
    const s = await probe();
    assert.equal(s.pillDisabled, false, '按钮处于禁用态');
  });

  await check('点解释后气泡立即消失', async () => {
    await clickPill('解释');
    await page.waitForTimeout(300);
    const s = await probe();
    assert.equal(s.pill, false, '气泡没有消失');
    assert.equal(s.panel, true, '浮窗没有展开');
  });

  await check('流式过程中不再出现气泡（避免点了没反应）', async () => {
    await page.waitForFunction(
      () => {
        const sr = document.querySelector('#flowread-root')?.shadowRoot;
        return (sr?.querySelectorAll('.fr-msg.is-streaming').length ?? 0) > 0;
      },
      { timeout: 10000 },
    );
    await pick('#b');
    const s = await probe();
    assert.equal(s.pill, false, '回答生成中仍然弹出了气泡，点它会毫无反应');
  });

  await check('流式结束后气泡恢复可用', async () => {
    await waitIdle();
    await pick('#b');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });
  });

  console.log('\n[B] 切换讨论对象');

  await check('换段落后点解释，讨论对象跟着换', async () => {
    const before = await probe();
    await clickPill('解释');
    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    await page.waitForTimeout(700);
    const after = await probe();
    assert.notEqual(after.anchor, before.anchor, '讨论了还是上一段');
    await waitIdle();
    return after.anchor;
  });

  await check('换段落后点追问：切换锚点、清空旧对话、但不自动发请求', async () => {
    await pick('#c');
    const before = await probe();
    await clickPill('追问');
    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    await page.waitForTimeout(600);

    const after = await probe();
    assert.notEqual(after.anchor, before.anchor, '点追问没有切换段落');
    // 追问 = 让用户自己问，绝不能替他把请求发出去
    assert.equal(after.users, 0, `追问自动发了 ${after.users} 条请求`);
    assert.equal(after.streaming, false, '追问不应该开始生成');
    assert.equal(after.bots, 0, '追问不应该产生回答');
    return after.anchor;
  });

  await check('同一段再点追问，只聚焦输入框、不新建会话', async () => {
    const before = await probe();
    await pick('#c');
    await clickPill('追问');
    await page.waitForTimeout(600);
    const after = await probe();
    assert.equal(after.anchor, before.anchor, '讨论对象被意外改变');
    assert.equal(after.users, before.users, '同一段追问不应新增消息');
    const focused = await page.evaluate(() => {
      const sr = document.querySelector('#flowread-root')?.shadowRoot;
      return sr?.activeElement?.closest('.fr-input') !== null;
    });
    assert.ok(focused, '输入框没有获得焦点');
  });


  await check('点「追问」后原文仍然高亮（否则不知道在问哪段）', async () => {
    await pick('#b');
    await clickPill('追问');
    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    await page.waitForTimeout(500);

    const has = await page.evaluate(() => {
      if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null;
      return CSS.highlights.has('flowread-anchor');
    });
    if (has === null) return '浏览器不支持 Highlight API，跳过';
    assert.equal(has, true, '追问之后页面上的原文高亮消失了');
    return '高亮保留';
  });

  await check('点「解释」后原文同样保持高亮', async () => {
    await pick('#c');
    await clickPill('解释');
    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    await page.waitForTimeout(400);

    const has = await page.evaluate(() => {
      if (typeof CSS === 'undefined' || !('highlights' in CSS)) return null;
      return CSS.highlights.has('flowread-anchor');
    });
    if (has === null) return '浏览器不支持 Highlight API，跳过';
    assert.equal(has, true, '解释之后原文高亮消失了');
    await waitIdle();
    return '高亮保留';
  });

  console.log('\n[C] 边界情况');

  await check('连点解释不会重复发请求', async () => {
    await pick('#a');
    const before = await probe();
    // 快速连点三次：气泡在第一次之后就会消失，后两次应该点不中
    await page.locator('.fr-pill-btn').first().click();
    await page.waitForTimeout(60);
    await page.evaluate(() => {
      const sr = document.querySelector('#flowread-root')?.shadowRoot;
      const buttons = [...(sr?.querySelectorAll('.fr-pill-btn') ?? [])];
      const explain = buttons.find((b) => b.textContent?.trim() === '解释');
      explain?.click();
      explain?.click();
    });
    await waitIdle();
    const after = await probe();
    const added = after.users - before.users;
    assert.ok(added <= 1, `一次操作产生了 ${added} 条用户消息`);
    return `新增 ${added} 条`;
  });

  await check('关闭面板后划词，气泡仍可出现，点解释能重新打开', async () => {
    // 关闭
    await page.locator('.fr-header-actions .fr-icon-btn').nth(3).click();
    await page.waitForTimeout(400);
    assert.equal((await probe()).panel, false, '面板没关掉');

    await pick('#a');
    await page.waitForSelector('.fr-pill', { timeout: 6000 });
    await clickPill('解释');
    await page.waitForSelector('.fr-panel', { timeout: 8000 });
    await waitIdle();
  });

  await check('最小化时划词不弹气泡', async () => {
    await page.locator('.fr-header-actions .fr-icon-btn').nth(2).click();
    await page.waitForTimeout(400);
    await pick('#b');
    const s = await probe();
    assert.equal(s.pill, false, '最小化状态下仍然弹出了气泡');
    // 还原
    await page.locator('.fr-min-btn').click();
    await page.waitForTimeout(400);
  });

  console.log('\n[D] 历史记录');

  await check('不同段落的历史记录标题不同', async () => {
    await page.locator('.fr-header-actions .fr-icon-btn').first().click();
    await page.waitForSelector('.fr-history', { timeout: 8000 });
    const titles = await page.locator('.fr-history-title').allTextContents();
    assert.ok(titles.length >= 2, `历史条目太少: ${titles.length}`);
    const unique = new Set(titles.map((t) => t.trim()));
    // 同一段文字问两次允许同名（内容本来就一样），但不同段落必须能区分开
    assert.ok(unique.size >= 2, `所有标题都一样，分不清是哪段: ${JSON.stringify(titles)}`);
    return `${titles.length} 条，${unique.size} 种标题`;
  });
} finally {
  if (context) await context.close();
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${'='.repeat(50)}`);
console.log(`按钮行为矩阵：${passed} 通过 / ${failed} 失败 / 共 ${results.length} 项`);
console.log('='.repeat(50));
if (failed > 0) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}\n      ${r.detail}`);
  process.exitCode = 1;
}
