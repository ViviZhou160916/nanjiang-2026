// 探针2：深度遍历 __INITIAL_STATE__（防循环）提取 noteId+xsecToken；验证带令牌直达
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.bringToFront().catch(() => {});

  let boardApi = null;
  page.on('response', async (res) => {
    try {
      const u = res.url();
      if (u.includes('board') && (res.headers()['content-type'] || '').includes('json')) {
        boardApi = await res.text();
      }
    } catch (e) {}
  });

  await page.goto('https://www.xiaohongshu.com/board/6a2253b900000000320337c9', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(6000);

  if (boardApi) {
    fs.writeFileSync(path.join(__dirname, 'board_api2.json'), boardApi);
    console.log('BOARD_API_LEN', boardApi.length, '| token数', (boardApi.match(/xsec_token|xsecToken/g) || []).length);
  } else console.log('BOARD_API 未捕获');

  const found = await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 7 || seen.has(o)) return;
      seen.add(o);
      const id = o.noteId || o.note_id || null;
      const token = o.xsecToken || o.xsec_token || null;
      if (id && token) {
        out.push({ id: String(id), token: String(token), title: o.title || o.displayTitle || (o.noteCard && o.noteCard.displayTitle) || '' });
      }
      for (const k in o) {
        try { walk(o[k], depth + 1); } catch (e) {}
      }
    };
    try { walk(window.__INITIAL_STATE__, 0); } catch (e) {}
    return out;
  });
  fs.writeFileSync(path.join(__dirname, 'tokens_taxian.json'), JSON.stringify(found, null, 2));
  console.log('STATE_TOKENS', found.length, found.slice(0, 3).map((x) => x.title.slice(0, 12) || x.id).join(' | '));

  // 验证带令牌直达（若拿到令牌用第一篇；否则用用户给的样例）
  let testUrl = 'https://www.xiaohongshu.com/explore/6a9a08b100000000280039ff?xsec_token=AB8_ohhhyJupY_EFrugNdn3bsuQTXieTme5x2yslUVxFE=&xsec_source=pc_user';
  if (found.length && found[0].id !== '6a9a08b100000000280039ff') {
    testUrl = `https://www.xiaohongshu.com/explore/${found[0].id}?xsec_token=${found[0].token}&xsec_source=pc_user`;
  }
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4500);
  const t = await page.evaluate(() => ({
    title: (document.querySelector('#detail-title') || document.querySelector('.title') || {}).textContent || '',
    desc: ((document.querySelector('#detail-desc') || {}).textContent || '').slice(0, 80),
    url: location.href.slice(0, 130),
  }));
  console.log('NOTE_TEST', JSON.stringify(t));

  await page.close();
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
