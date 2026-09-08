// 诊断：打开专辑页，截图 + 输出锚点结构（复用已登录的 profile，无需再扫码）
const { chromium } = require('playwright-core');
const path = require('path');

const EXEC = '/Users/joy/Library/Caches/ms-playwright/chromium-1091/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const PROFILE = path.join(__dirname, 'profile');

(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EXEC,
    headless: false,
    viewport: { width: 1400, height: 950 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  const url = 'https://www.xiaohongshu.com/board/6a2253b900000000320337c9';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(9000);
  console.log('URL:', page.url());
  console.log('TITLE:', await page.title());
  await page.screenshot({ path: path.join(__dirname, 'board1.png') });
  const info = await page.evaluate(() => {
    const as = Array.from(document.querySelectorAll('a'));
    return {
      anchorTotal: as.length,
      anchorExplore: as.filter((a) => (a.getAttribute('href') || '').includes('/explore/')).length,
      hrefSample: as.slice(0, 40).map((a) => a.getAttribute('href')),
      bodyText: document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 800),
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await ctx.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
