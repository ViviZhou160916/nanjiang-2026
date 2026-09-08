// 小红书专辑抓取：可见浏览器 → 用户扫码登录 → 读两个专辑全部笔记
// 用法：node scrape.js   (可重复运行：已抓的笔记会跳过，登录态保存在 ./profile)
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
  const page = ctx.pages()[0] || (await ctx.newPage());

  // ---- 阶段A：等待登录 ----
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('[LOGIN] 浏览器已打开。如出现二维码，请用小红书 App 扫码登录（等待最长 6 分钟）…');
  let ok = false;
  for (let i = 0; i < 180; i++) {
    const cs = await ctx.cookies('https://www.xiaohongshu.com');
    if (cs.some((c) => c.name === 'web_session')) { ok = true; break; }
    await sleep(2000);
  }
  if (!ok) { console.log('[LOGIN] TIMEOUT 未登录'); await ctx.close(); process.exit(2); }
  console.log('[LOGIN] 登录成功');

  // ---- 阶段B：两个专辑的笔记列表 ----
  const all = [];
  for (const b of BOARDS) {
    const url = `https://www.xiaohongshu.com/board/${b.id}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(3000);
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
    all.push({ board: b.name, url, notes: [...seen].map(([href, title]) => ({ href, title })) });
  }
  fs.writeFileSync(path.join(__dirname, 'boards.json'), JSON.stringify(all, null, 2));
  console.log('[BOARD] 列表已存 boards.json');

  // ---- 阶段C：逐篇打开笔记正文 ----
  const notes = all.flatMap((b) => b.notes.map((n) => ({ ...n, board: b.board })));
  let done = 0, fail = 0;
  for (const n of notes) {
    const m = n.href.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/);
    const id = m ? m[1] : 'id_' + Math.random().toString(36).slice(2, 10);
    const f = path.join(NOTES_DIR, id + '.json');
    if (fs.existsSync(f)) { done++; continue; }
    try {
      await page.goto(n.href, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2200);
      const d = await page.evaluate(() => {
        const t = document.querySelector('#detail-title') || document.querySelector('.title');
        const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
        const dt = document.querySelector('.date');
        return {
          t: t ? t.textContent.trim() : '',
          c: c ? c.textContent.trim() : '',
          dt: dt ? dt.textContent.trim() : '',
        };
      });
      if (!d.t && !d.c) {
        console.log(`[NOTE] EMPTY(可能未加载/需验证) ${n.href}`);
        fail++;
      } else {
        fs.writeFileSync(f, JSON.stringify({ board: n.board, listTitle: n.title, title: d.t, text: d.c, date: d.dt, url: n.href }, null, 2));
        done++;
        console.log(`[NOTE] ${done}/${notes.length} ${(d.t || d.c).slice(0, 40)}`);
      }
    } catch (e) {
      console.log(`[NOTE] FAIL ${n.href} :: ${String(e.message).split('\n')[0]}`);
      fail++;
    }
    await sleep(1200 + Math.random() * 1800);
  }
  console.log(`ALL_DONE done=${done} fail_or_empty=${fail} total=${notes.length}`);
  await ctx.close();
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
