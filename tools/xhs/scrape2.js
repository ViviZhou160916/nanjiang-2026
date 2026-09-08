// 小红书专辑抓取 v2：反检测 + 失败自动重试 + 接口数据截获
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
  // 反检测：去掉自动化指纹
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });
  const page = ctx.pages()[0] || (await ctx.newPage());

  // 截获 board 相关接口的 JSON 响应（DOM 拿不到时用它兜底）
  const apiDumps = [];
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (u.includes('/api/') && u.includes('board') && (res.headers()['content-type'] || '').includes('json')) {
        apiDumps.push({ url: u, body: await res.text() });
      }
    } catch (e) { /* ignore */ }
  });

  const loggedIn = () => page.evaluate(() =>
    !!document.querySelector('a[href*="/user/profile/"]'));

  // ---- 阶段A：确认登录 ----
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  let ok = await loggedIn();
  if (ok) console.log('[LOGIN] 已是登录状态');
  else {
    console.log('[LOGIN] 请扫码登录（小红书 App → 我 → ☰ → 扫一扫），最长等 8 分钟…');
    for (let i = 0; i < 240; i++) {
      await sleep(2000);
      try { ok = await loggedIn(); } catch (e) { ok = false; }
      if (ok) break;
    }
  }
  if (!ok) { console.log('[LOGIN] TIMEOUT 未登录'); await ctx.close(); process.exit(2); }
  console.log('[LOGIN] 登录确认');
  await sleep(2000);

  // ---- 阶段B：专辑列表（带重试） ----
  const all = [];
  for (const b of BOARDS) {
    const url = `https://www.xiaohongshu.com/board/${b.id}`;
    let text = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await sleep(4000);
      text = await page.evaluate(() => document.body.innerText);
      if (!text.includes('未连接到服务器')) break;
      console.log(`[BOARD] 《${b.name}》第 ${attempt} 次加载失败（未连接到服务器），重试…`);
      await sleep(3000);
    }
    await page.screenshot({ path: path.join(__dirname, `board_${b.name}.png`) });
    const seen = new Map();
    let stable = 0;
    for (let s = 0; s < 50 && stable < 4; s++) {
      const items = await page.$$eval('a[href*="/explore/"]', (as) =>
        as.map((a) => ({
          href: a.getAttribute('href') || '',
          title: ((a.querySelector('.title') && a.querySelector('.title').textContent) ||
                  (a.querySelector('img') && a.querySelector('img').getAttribute('alt')) || '').trim(),
        }))
      );
      let added = 0;
      for (const it of items) {
        if (!it.href) continue;
        const full = new URL(it.href, 'https://www.xiaohongshu.com').href.split('#')[0];
        if (!seen.has(full)) { seen.set(full, it.title); added++; }
      }
      stable = added === 0 ? stable + 1 : 0;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await sleep(1300);
    }
    console.log(`[BOARD] 《${b.name}》收集到 ${seen.size} 篇`);
    if (seen.size === 0) console.log(`[BOARD] 页面文本片段: ${text.replace(/\n+/g, '|').slice(0, 300)}`);
    all.push({ board: b.name, url, notes: [...seen].map(([href, title]) => ({ href, title })) });
  }
  fs.writeFileSync(path.join(__dirname, 'boards.json'), JSON.stringify(all, null, 2));
  if (apiDumps.length) fs.writeFileSync(path.join(__dirname, 'board_api.json'), JSON.stringify(apiDumps, null, 2));
  console.log('[BOARD] 列表已存 boards.json');

  // ---- 阶段C：逐篇笔记正文 ----
  const notes = all.flatMap((b) => b.notes.map((n) => ({ ...n, board: b.board })));
  let done = 0, fail = 0;
  for (const n of notes) {
    const m = n.href.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/);
    const id = m ? m[1] : 'id_' + Math.random().toString(36).slice(2, 10);
    const f = path.join(NOTES_DIR, id + '.json');
    if (fs.existsSync(f)) { done++; continue; }
    let got = null;
    for (let attempt = 1; attempt <= 2 && !got; attempt++) {
      try {
        await page.goto(n.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await sleep(2400);
        got = await page.evaluate(() => {
          const t = document.querySelector('#detail-title') || document.querySelector('.title');
          const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
          const dt = document.querySelector('.date');
          return {
            t: t ? t.textContent.trim() : '',
            c: c ? c.textContent.trim() : '',
            dt: dt ? dt.textContent.trim() : '',
          };
        });
      } catch (e) { got = null; }
    }
    if (got && (got.t || got.c)) {
      fs.writeFileSync(f, JSON.stringify({ board: n.board, listTitle: n.title, title: got.t, text: got.c, date: got.dt, url: n.href }, null, 2));
      done++;
      console.log(`[NOTE] ${done}/${notes.length} ${(got.t || got.c).slice(0, 40)}`);
    } else {
      console.log(`[NOTE] EMPTY ${n.href}`);
      fail++;
    }
    await sleep(1200 + Math.random() * 1800);
  }
  console.log(`ALL_DONE done=${done} fail_or_empty=${fail} total=${notes.length}`);
  console.log('浏览器 10 秒后自动关闭…');
  await sleep(10000);
  await ctx.close();
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
