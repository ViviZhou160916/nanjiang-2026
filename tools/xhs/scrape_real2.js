// 小红书专辑笔记抓取 v8：真实 Chrome + 修正弹窗误判（基线标签页集合）
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, 'notes');
const BOARDS = [
  { id: '6a2253b900000000320337c9', name: '塔县' },
  { id: '6a1c36080000000036010c0c', name: '喀什' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_TITLE = /无法浏览|加载中|笔记已删除|不见了|404/;

(async () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const baseline = new Set(ctx.pages());          // 已有标签页（含初始空白页）不算弹窗
  const page = await ctx.newPage();
  baseline.add(page);
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.bringToFront().catch(() => {});

  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(5000);
  const isLoggedOut = () => page.evaluate(() =>
    !!document.querySelector('.login-btn') || /^\s*登录\s*$/m.test(document.body.innerText));
  if (await isLoggedOut()) {
    console.log('[LOGIN] 请在 Chrome 窗口里扫码登录…');
    let ok = false;
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      try { ok = !(await isLoggedOut()); } catch (e) { ok = false; }
      if (ok) { await sleep(2500); try { ok = !(await isLoggedOut()); } catch (e) { ok = false; } }
      if (ok) break;
      if (i > 0 && i % 30 === 0) console.log('[LOGIN] 仍在等待扫码…');
    }
    if (!ok) { console.log('[LOGIN] TIMEOUT'); process.exit(2); }
  }
  console.log('[LOGIN] 登录确认');

  const extractFromPage = (pg) => pg.evaluate(() => {
    const t = document.querySelector('#detail-title') || document.querySelector('.title');
    const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
    const dt = document.querySelector('.date');
    const author = document.querySelector('.username, .author .name');
    const tags = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent.trim()).filter(Boolean);
    return {
      t: t ? t.textContent.trim() : '',
      c: c ? c.textContent.trim() : '',
      dt: dt ? dt.textContent.trim() : '',
      author: author ? author.textContent.trim() : '',
      tags,
    };
  });

  const noteOpen = () => page.evaluate(() =>
    !!document.querySelector('#detail-title') ||
    !!document.querySelector('.note-detail-mask') ||
    !!document.querySelector('.note-detail')).catch(() => false);
  const popups = () => ctx.pages().filter((p) => !baseline.has(p));

  for (const b of BOARDS) {
    const boardUrl = `https://www.xiaohongshu.com/board/${b.id}`;
    const openBoard = async () => {
      for (let a = 1; a <= 6; a++) {
        await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(4000);
        const t = await page.evaluate(() => document.body.innerText).catch(() => '');
        const n = await page.$$eval('a[href*="/explore/"]', (as) => as.length).catch(() => 0);
        if (!t.includes('未连接到服务器') && n > 0) return true;
        console.log(`[BOARD] 《${b.name}》加载异常(卡片${n})，第 ${a} 次重试…`);
      }
      return false;
    };
    if (!(await openBoard())) { console.log(`[BOARD] 《${b.name}》页面打不开，跳过`); continue; }

    const clicked = new Set();
    let fails = 0, stable = 0, lastCount = -1;
    for (let round = 0; round < 80 && stable < 5 && fails < 20; round++) {
      const cards = await page.$$('a[href*="/explore/"]');
      for (const card of cards) {
        const href = await card.getAttribute('href').catch(() => null);
        if (!href) continue;
        const full = new URL(href, 'https://www.xiaohongshu.com').href.split('#')[0];
        const id = (full.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/) || [])[1];
        if (!id || clicked.has(id)) continue;
        const outFile = path.join(NOTES_DIR, id + '.json');
        if (fs.existsSync(outFile)) { clicked.add(id); continue; }

        let handled = false, how = '';
        try { await card.evaluate((el) => el.click()); } catch (e) {}
        for (let w = 0; w < 10 && !handled; w++) {
          await sleep(700);
          const ps = popups();
          if (ps.length) {
            const np = ps[ps.length - 1];
            await np.waitForLoadState('domcontentloaded', { timeout: 12000 }).catch(() => {});
            await sleep(1800);
            const d = await extractFromPage(np).catch(() => ({ t: '', c: '' }));
            if ((d.t || d.c) && !BAD_TITLE.test(d.t)) {
              fs.writeFileSync(outFile, JSON.stringify({ board: b.name, url: full, title: d.t, text: d.c, tags: d.tags, author: d.author }, null, 2));
              handled = true; how = 'newtab';
            }
            await np.close().catch(() => {});
            break;
          }
          if (await noteOpen()) {
            await sleep(1500);
            const d = await extractFromPage(page).catch(() => ({ t: '', c: '' }));
            if ((d.t || d.c) && !BAD_TITLE.test(d.t)) {
              fs.writeFileSync(outFile, JSON.stringify({ board: b.name, url: full, title: d.t, text: d.c, tags: d.tags, author: d.author, date: d.dt }, null, 2));
              handled = true; how = 'modal';
            } else if (d.t && BAD_TITLE.test(d.t)) {
              console.log(`[NOTE] 被拦(${d.t.slice(0, 16)}) ${full.slice(0, 70)}`);
              break;
            }
          }
        }
        if (handled) {
          clicked.add(id); fails = 0;
          const saved = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          console.log(`[NOTE] ${clicked.size}(${how}) ${saved.title.slice(0, 42)}`);
        } else {
          fails++;
          console.log(`[NOTE] FAIL(${fails}) ${full.slice(0, 80)}`);
        }
        // 关弹层
        try { const cb = await page.$('.close-circle'); if (cb) await cb.evaluate((el) => el.click()); } catch (e) {}
        try { await page.keyboard.press('Escape'); } catch (e) {}
        for (const p of popups()) await p.close().catch(() => {});
        await sleep(800);
        // 被带离专辑页则回去
        try {
          const u = page.url();
          if (!u.includes('/board/')) await openBoard();
        } catch (e) { await openBoard(); }
        await sleep(500 + Math.random() * 600);
      }
      // 滚动加载更多
      const before = await page.$$eval('a[href*="/explore/"]', (as) => as.length);
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 2);
        document.querySelectorAll('div').forEach((d) => {
          const s = getComputedStyle(d);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 200) d.scrollTop += 1500;
        });
      });
      await sleep(1800);
      const after = await page.$$eval('a[href*="/explore/"]', (as) => as.length);
      if (after === before && lastCount === after) stable++; else stable = 0;
      lastCount = after;
    }
    console.log(`[BOARD] 《${b.name}》完成，本轮新增 ${clicked.size} 篇`);
  }
  const total = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.json')).length;
  console.log(`ALL_DONE notes_saved=${total}`);
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
