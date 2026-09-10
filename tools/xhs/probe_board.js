// 对比诊断：塔县 vs 喀什 board 页（CDP Chrome，已登录）
const { chromium } = require('playwright-core');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOARDS = [
  { name: '塔县', id: '6a2253b900000000320337c9' },
  { name: '喀什', id: '6a1c36080000000036010c0c' },
];

(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 950 });

  for (const b of BOARDS) {
    await page.goto(`https://www.xiaohongshu.com/board/${b.id}`, {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await sleep(5000);
    // 滚动两轮触发懒加载
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 2);
        document.querySelectorAll('div').forEach((d) => {
          const s = getComputedStyle(d);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 200) d.scrollTop = d.scrollHeight;
        });
      }).catch(() => {});
      await sleep(2000);
    }
    const info = await page.evaluate(() => {
      const as = Array.from(document.querySelectorAll('a'));
      const hrefs = as.map((a) => a.getAttribute('href') || '');
      const noteLike = hrefs.filter((h) => /\/(explore|search_result|discovery\/item)\/[0-9a-zA-Z]{16,}/.test(h));
      const main = document.querySelector('.board-page, #boardContainer, main, .notes-container');
      return {
        url: location.href,
        title: document.title,
        noteLinks: noteLike.length,
        noteHrefSample: [...new Set(noteLike)].slice(0, 5),
        mainClass: main ? main.className.slice(0, 80) : '(no main)',
        bodyHead: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260),
      };
    }).catch((e) => ({ error: e.message }));
    console.log(`\n===== 《${b.name}》=====`);
    console.log(JSON.stringify(info, null, 2));
  }
  await page.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
