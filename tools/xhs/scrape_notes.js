// 小红书专辑笔记抓取 v4：在专辑页内「点击卡片 → 弹窗阅读」逐篇提取正文
// （直接 goto 笔记 URL 会报「当前笔记暂时无法浏览」，必须从专辑页上下文点进去）
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

  // ---- 登录确认（两次连续判定，防误报） ----
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

  const extractDetail = () => page.evaluate(() => {
    const t = document.querySelector('#detail-title') || document.querySelector('.title');
    const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
    const dt = document.querySelector('.date');
    const tags = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent.trim()).filter(Boolean);
    return {
      t: t ? t.textContent.trim() : '',
      c: c ? c.textContent.trim() : '',
      dt: dt ? dt.textContent.trim() : '',
      tags,
    };
  });

  for (const b of BOARDS) {
    await page.goto(`https://www.xiaohongshu.com/board/${b.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    for (let a = 1; a <= 5; a++) {
      const t = await page.evaluate(() => document.body.innerText);
      if (!t.includes('未连接到服务器')) break;
      console.log(`[BOARD] 《${b.name}》加载失败，第 ${a} 次重试…`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await sleep(4000);
    }
    const clicked = new Set();
    let stable = 0;
    for (let round = 0; round < 60 && stable < 4; round++) {
      const cards = await page.$$('a[href*="/explore/"]');
      for (const card of cards) {
        const href = await card.getAttribute('href');
        if (!href) continue;
        const full = new URL(href, 'https://www.xiaohongshu.com').href.split('#')[0];
        const id = (full.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/) || [])[1];
        if (!id || clicked.has(id)) continue;
        const outFile = path.join(NOTES_DIR, id + '.json');
        if (fs.existsSync(outFile)) { clicked.add(id); continue; }
        try {
          await card.scrollIntoViewIfNeeded({ timeout: 4000 });
          await card.click({ timeout: 5000 });
          // 等笔记弹层或新标签页
          let handled = false;
          for (let w = 0; w < 10 && !handled; w++) {
            await sleep(600);
            if (ctx.pages().length > 1) {
              // 弹出了新标签页
              const np = ctx.pages()[ctx.pages().length - 1];
              await np.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
              await sleep(1500);
              const d = await np.evaluate(() => {
                const t = document.querySelector('#detail-title') || document.querySelector('.title');
                const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
                const tags = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent.trim()).filter(Boolean);
                return { t: t ? t.textContent.trim() : '', c: c ? c.textContent.trim() : '', tags };
              });
              if (d.t || d.c) {
                fs.writeFileSync(outFile, JSON.stringify({ board: b.name, url: full, title: d.t, text: d.c, tags: d.tags }, null, 2));
                clicked.add(id);
                console.log(`[NOTE] ${clicked.size} 新标签 ${(d.t || d.c).slice(0, 40)}`);
                handled = true;
              }
              await np.close();
            } else {
              const has = await page.$('#detail-title, .note-detail-mask');
              if (has) {
                await sleep(1000);
                const d = await extractDetail();
                if (d.t || d.c) {
                  fs.writeFileSync(outFile, JSON.stringify({ board: b.name, url: full, title: d.t, text: d.c, tags: d.tags, date: d.dt }, null, 2));
                  clicked.add(id);
                  console.log(`[NOTE] ${clicked.size} ${(d.t || d.c).slice(0, 40)}`);
                  handled = true;
                }
              }
            }
          }
          if (!handled) console.log(`[NOTE] FAIL ${full.slice(0, 90)}`);
        } catch (e) {
          console.log(`[NOTE] FAIL ${full.slice(0, 90)} :: ${String(e.message).split('\n')[0].slice(0, 50)}`);
        }
        // 关闭弹层（两种方式都试）
        try { await page.keyboard.press('Escape'); } catch (e) {}
        try { const cb = await page.$('.close-circle'); if (cb) await cb.click({ timeout: 2000 }); } catch (e) {}
        try { if (ctx.pages().length > 1) for (const p of ctx.pages().slice(1)) await p.close(); } catch (e) {}
        await sleep(800 + Math.random() * 800);
      }
      // 下滚加载更多
      const before = await page.$$eval('a[href*="/explore/"]', (as) => as.length);
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await sleep(1500);
      const after = await page.$$eval('a[href*="/explore/"]', (as) => as.length);
      stable = after === before && clicked.size >= after ? stable + 1 : 0;
    }
    console.log(`[BOARD] 《${b.name}》完成，共 ${clicked.size} 篇`);
  }
  console.log('ALL_DONE');
  console.log('浏览器 10 秒后自动关闭…');
  await sleep(10000);
  await ctx.close();
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
