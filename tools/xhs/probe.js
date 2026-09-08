// 探针：1) 从专辑页内部数据提取 xsec_token 2) 验证带令牌直达笔记页可行
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

  const raw = await page.evaluate(() => JSON.stringify(window.__INITIAL_STATE__ || {}));
  fs.writeFileSync(path.join(__dirname, 'state.json'), raw);
  console.log('STATE_LEN', raw.length, '| xsec_token出现次数', (raw.match(/xsec_token/g) || []).length);
  if (boardApi) {
    fs.writeFileSync(path.join(__dirname, 'board_api2.json'), boardApi);
    console.log('BOARD_API_LEN', boardApi.length, '| xsec_token出现次数', (boardApi.match(/xsec_token/g) || []).length);
  } else console.log('BOARD_API 未捕获');

  // 验证：用户提供的带令牌 URL 能否直达
  await page.goto('https://www.xiaohongshu.com/explore/6a9a08b100000000280039ff?xsec_token=AB8_ohhhyJupY_EFrugNdn3bsuQTXieTme5x2yslUVxFE=&xsec_source=pc_user', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4500);
  const t = await page.evaluate(() => ({
    title: (document.querySelector('#detail-title') || document.querySelector('.title') || {}).textContent || '',
    desc: ((document.querySelector('#detail-desc') || {}).textContent || '').slice(0, 100),
    url: location.href.slice(0, 120),
  }));
  console.log('NOTE_TEST', JSON.stringify(t, null, 2));

  await page.close();
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
