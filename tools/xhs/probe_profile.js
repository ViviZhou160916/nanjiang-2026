// 从个人主页「收藏」tab 列出当前所有专辑（名称 + board_id + 笔记数）
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 950 });

  // 1. 从首页侧栏拿「我」的主页链接
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  const profileUrl = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/user/profile/"]'));
    const a = links.find((x) => (x.getAttribute('href') || '').match(/^\/user\/profile\/[0-9a-f]+$/));
    return a ? new URL(a.getAttribute('href'), 'https://www.xiaohongshu.com').href : null;
  }).catch(() => null);
  console.log('[PROFILE]', profileUrl);
  if (!profileUrl) { console.log('找不到主页链接'); process.exit(1); }

  // 2. 打开主页，点「收藏」tab
  await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  const clicked = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div,span,a,li'));
    const t = els.find((e) => e.children.length === 0 && /^收藏$/.test((e.textContent || '').trim()));
    if (t) { t.click(); return true; }
    return false;
  }).catch(() => false);
  console.log('[收藏 tab clicked]', clicked);
  await sleep(4000);

  // 3. 滚动加载，列出所有专辑卡
  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 2);
      document.querySelectorAll('div').forEach((d) => {
        const s = getComputedStyle(d);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 200) d.scrollTop = d.scrollHeight;
      });
    }).catch(() => {});
    await sleep(1800);
  }

  const boards = await page.evaluate(() => {
    const out = [];
    const as = Array.from(document.querySelectorAll('a[href*="/board/"]'));
    for (const a of as) {
      const href = a.getAttribute('href') || '';
      const id = (href.match(/board\/([0-9a-zA-Z]+)/) || [])[1];
      if (!id) continue;
      const card = a.closest('div[class*="board"], section') || a;
      out.push({ id, text: (card.innerText || a.innerText || '').replace(/\s+/g, ' ').slice(0, 80) });
    }
    const seen = new Set();
    return out.filter((b) => (seen.has(b.id) ? false : seen.add(b.id)));
  }).catch((e) => [{ error: e.message }]);

  console.log('[BOARDS]', JSON.stringify(boards, null, 2));
  await page.screenshot({ path: '/tmp/profile_boards.png' }).catch(() => {});
  await page.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
