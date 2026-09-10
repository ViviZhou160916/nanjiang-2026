// 拦截个人主页「收藏」tab 的 board 列表接口响应
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 950 });

  const hits = [];
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (u.includes('/api/sns/web') && u.includes('board')) {
        const j = await resp.json().catch(() => null);
        if (j) hits.push({ u: u.slice(0, 140), j });
      }
    } catch (e) {}
  });

  await page.goto('https://www.xiaohongshu.com/user/profile/58ad387382ec396ee17deec1', {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await sleep(4000);
  await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('div,span,a,li'));
    const t = els.find((e) => e.children.length === 0 && /^收藏$/.test((e.textContent || '').trim()));
    if (t) t.click();
  }).catch(() => {});
  await sleep(4000);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
    await sleep(1800);
  }

  if (!hits.length) {
    console.log('[NO API HITS] 页面文本预览:');
    const t = await page.evaluate(() => document.body.innerText.replace(/\n+/g, '|').slice(0, 600)).catch(() => '');
    console.log(t);
  } else {
    for (const h of hits) {
      console.log('URL:', h.u);
      console.log(JSON.stringify(h.j, null, 2).slice(0, 3000));
      console.log('---');
    }
  }
  await page.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
