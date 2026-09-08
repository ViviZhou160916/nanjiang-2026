// 小红书专辑笔记抓取 v5：JS 直接点击卡片（绕过可见性/滚动检查）
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const EXEC = '/Users/joy/Library/Caches/ms-playwright/chromium-1091/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const PROFILE = path.join(__dirname, 'profile');
const NOTES_DIR = path.join(__dirname, 'notes');
const BOARDS = [
  { id: '6a2253b900000000320337c9', name: '塔县' },
  { id: '6a1c36080000000036010c0c', name: '喀什' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EXEC,
    headless: false,
    viewport: { width: 1400, height: 950 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 登录确认
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);
  const isLoggedOut = () => page.evaluate(() =>
    !!document.querySelector('.login-btn') || /^\s*登录\s*$/m.test(document.body.innerText));
  if (await isLoggedOut()) {
    console.log('[LOGIN] 请扫码登录（App → 我 → ☰ → 扫一扫）…');
    let ok = false;
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      try { ok = !(await isLoggedOut()); } catch (e) { ok = false; }
      if (ok) { await sleep(2000); try { ok = !(await isLoggedOut()); } catch (e) { ok = false; } }
      if (ok) break;
    }
    if (!ok) { console.log('[LOGIN] TIMEOUT'); await ctx.close(); process.exit(2); }
  }
  console.log('[LOGIN] 登录确认');

  const modalOpen = () => page.$('#detail-title').then(Boolean).catch(() => false);

  for (const b of BOARDS) {
    const boardUrl = `https://www.xiaohongshu.com/board/${b.id}`;
    const openBoard = async () => {
      for (let a = 1; a <= 5; a++) {
        await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(4000);
        const t = await page.evaluate(() => document.body.innerText).catch(() => '');
        if (!t.includes('未连接到服务器')) return true;
        console.log(`[BOARD] 《${b.name}》加载失败，第 ${a} 次重试…`);
      }
      return false;
    };
    await openBoard();
    const clicked = new Set();
    let fails = 0;
    let stable = 0;
    for (let round = 0; round < 60 && stable < 4 && fails < 30; round++) {
      const cards = await page.$$('a[href*="/explore/"]');
      let roundClicked = 0;
      for (const card of cards) {
        const href = await card.getAttribute('href').catch(() => null);
        if (!href) continue;
        const full = new URL(href, 'https://www.xiaohongshu.com').href.split('#')[0];
        const id = (full.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/) || [])[1];
        if (!id || clicked.has(id)) continue;
        const outFile = path.join(NOTES_DIR, id + '.json');
        if (fs.existsSync(outFile)) { clicked.add(id); continue; }
        // 若上一条弹层还挂着，先关掉
        if (await modalOpen()) {
          try { await page.keyboard.press('Escape'); } catch (e) {}
          try { const cb = await page.$('.close-circle'); if (cb) await cb.evaluate((el) => el.click()); } catch (e) {}
          await sleep(800);
          if (await modalOpen()) await openBoard(); // 关不掉就整页重开
        }
        let handled = false;
        try {
          await card.evaluate((el) => el.click()); // 纯 JS 点击，不做可见性检查
          for (let w = 0; w < 12 && !handled; w++) {
            await sleep(600);
            if (ctx.pages().length > 1) {
              const np = ctx.pages()[ctx.pages().length - 1];
              await np.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
              await sleep(1500);
              const d = await np.evaluate(() => {
                const t = document.querySelector('#detail-title') || document.querySelector('.title');
                const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
                const tags = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent.trim()).filter(Boolean);
                return { t: t ? t.textContent.trim() : '', c: c ? c.textContent.trim() : '', tags };
              }).catch(() => ({ t: '', c: '', tags: [] }));
              if (d.t || d.c) {
                fs.writeFileSync(outFile, JSON.stringify({ board: b.name, url: full, title: d.t, text: d.c, tags: d.tags }, null, 2));
                handled = true;
              }
              await np.close().catch(() => {});
            } else {
              const has = await page.$('#detail-title');
              if (has) {
                await sleep(1200);
                const d = await page.evaluate(() => {
                  const t = document.querySelector('#detail-title') || document.querySelector('.title');
                  const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
                  const dt = document.querySelector('.date');
                  const tags = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent.trim()).filter(Boolean);
                  return { t: t ? t.textContent.trim() : '', c: c ? c.textContent.trim() : '', dt: dt ? dt.textContent.trim() : '', tags };
                });
                if (d.t || d.c) {
                  fs.writeFileSync(outFile, JSON.stringify({ board: b.name, url: full, title: d.t, text: d.c, tags: d.tags, date: d.dt }, null, 2));
                  handled = true;
                }
              }
            }
          }
        } catch (e) { /* fallthrough */ }
        if (handled) {
          clicked.add(id); roundClicked++;
          console.log(`[NOTE] ${clicked.size} ${(JSON.parse(fs.readFileSync(outFile, 'utf8')).title || '').slice(0, 42)}`);
          fails = 0;
        } else {
          fails++;
          console.log(`[NOTE] FAIL(${fails}) ${full.slice(0, 90)}`);
          if (fails >= 10) { console.log('[NOTE] 连续失败过多，重开专辑页…'); await openBoard(); fails = 0; }
        }
        // 关弹层
        try { await page.keyboard.press('Escape'); } catch (e) {}
        try { const cb = await page.$('.close-circle'); if (cb) await cb.evaluate((el) => el.click()); } catch (e) {}
        try { if (ctx.pages().length > 1) for (const p of ctx.pages().slice(1)) await p.close(); } catch (e) {}
        await sleep(700 + Math.random() * 700);
      }
      // 下滚加载更多
      const before = await page.$$eval('a[href*="/explore/"]', (as) => as.length);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await sleep(1600);
      const after = await page.$$eval('a[href*="/explore/"]', (as) => as.length);
      stable = after === before ? stable + 1 : 0;
    }
    console.log(`[BOARD] 《${b.name}》完成，共 ${clicked.size} 篇`);
  }
  console.log('ALL_DONE');
  console.log('浏览器 10 秒后自动关闭…');
  await sleep(10000);
  await ctx.close();
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
