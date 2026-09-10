// 新专辑（6aa21172...）增量抓笔记 —— CDP Chrome + xsec_token 直达法（沿用 scrape_tokens.js）
// 打开专辑页 → 滚动加载 → 从 __INITIAL_STATE__ 提取 id+token → 带 token 直达笔记页提取正文 → 已存在 id 跳过
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BOARD = { id: '6aa21172000000002300ff40', name: '塔县' };
const NOTES_DIR = path.join(__dirname, 'notes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_TITLE = /无法浏览|加载中|笔记已删除|不见了|404|出错了/;

(async () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.bringToFront().catch(() => {});

  // 1) 打开新专辑页，滚动加载，从 __INITIAL_STATE__ 提取 id+token
  await page.goto(`https://www.xiaohongshu.com/board/${BOARD.id}`, {
    waitUntil: 'domcontentloaded', timeout: 60000,
  });
  await sleep(5000);
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      window.scrollBy(0, window.innerHeight * 2);
      document.querySelectorAll('div').forEach((d) => {
        const s = getComputedStyle(d);
        if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 200) d.scrollTop = d.scrollHeight;
      });
    }).catch(() => {});
    await sleep(1800);
  }
  const found = await page.evaluate(() => {
    const out = [];
    const seenObj = new Set();
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 7 || seenObj.has(o)) return;
      seenObj.add(o);
      const id = o.noteId || o.note_id || null;
      const token = o.xsecToken || o.xsec_token || null;
      if (id && token) out.push({ id: String(id), token: String(token), title: o.title || o.displayTitle || (o.noteCard && o.noteCard.displayTitle) || '' });
      for (const k in o) { try { walk(o[k], depth + 1); } catch (e) {} }
    };
    try { walk(window.__INITIAL_STATE__, 0); } catch (e) {}
    return out;
  }).catch(() => []);
  const byId = new Map();
  for (const n of found) if (!byId.has(n.id)) byId.set(n.id, n);
  console.log(`《${BOARD.name}》状态内 id+token: ${byId.size}`);

  // 2) 只抓 notes/ 里没有的
  const queue = [...byId.values()].filter((n) => !fs.existsSync(path.join(NOTES_DIR, n.id + '.json')));
  console.log(`待抓新增: ${queue.length}`);
  let saved = 0, fail = 0;
  for (const n of queue) {
    const url = `https://www.xiaohongshu.com/explore/${n.id}?xsec_token=${n.token}&xsec_source=pc_user&source=web_user_page`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2600);
      const d = await page.evaluate(() => {
        const t = document.querySelector('#detail-title') || document.querySelector('.title');
        const c = document.querySelector('#detail-desc') || document.querySelector('.note-text') || document.querySelector('.desc');
        const dt = document.querySelector('.date');
        const author = document.querySelector('.username, .author .name');
        const tags = Array.from(document.querySelectorAll('.tag')).map((x) => x.textContent.trim()).filter(Boolean);
        return {
          t: t ? t.textContent.trim() : '',
          c: c ? c.textContent.trim() : '',
          dt: dt ? dt.textContent.trim() : '',
          author: author ? author.textContent.trim() : '',
          tags,
        };
      });
      if ((d.t || d.c) && !BAD_TITLE.test(d.t)) {
        fs.writeFileSync(path.join(NOTES_DIR, n.id + '.json'), JSON.stringify({
          board: BOARD.name, url, title: d.t, text: d.c, tags: d.tags, author: d.author, date: d.dt,
        }, null, 2));
        saved++;
        console.log(`[NEW ${saved}/${queue.length}] ${(d.t || '').slice(0, 42)}`);
      } else {
        fail++;
        console.log(`[BAD(${(d.t || '空').slice(0, 16)})] ${n.id}`);
      }
    } catch (e) {
      fail++;
      console.log(`[FAIL] ${n.id} :: ${String(e.message).split('\n')[0].slice(0, 50)}`);
    }
    await sleep(1500 + Math.random() * 1500);
  }
  const total = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.json')).length;
  console.log(`ALL_DONE 新增=${saved} 失败=${fail} notes目录总数=${total}`);
  await page.close();
  process.exit(0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
