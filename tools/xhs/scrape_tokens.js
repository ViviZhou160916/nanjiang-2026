// 最终版：从专辑页状态提取 xsec_token → 带令牌直达笔记页抓正文
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, 'notes');
const BOARDS = [
  { id: '6a2253b900000000320337c9', name: '塔县' },
  { id: '6a1c36080000000036010c0c', name: '喀什' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_TITLE = /无法浏览|加载中|笔记已删除|不见了|404|出错了/;

(async () => {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.bringToFront().catch(() => {});
  await page.setViewportSize({ width: 1400, height: 950 });

  // 已知专辑成员 id（来自此前抓到的 boards.json）
  let memberIds = new Set();
  try {
    const bj = JSON.parse(fs.readFileSync(path.join(__dirname, 'boards.json'), 'utf8'));
    for (const b of bj) for (const n of b.notes) {
      const m = n.href.match(/\/(?:explore|search_result)\/([0-9a-zA-Z]+)/);
      if (m) memberIds.add(m[1]);
    }
  } catch (e) {}
  console.log('已知专辑成员数:', memberIds.size);

  // 1) 提取两个专辑的 id+token
  const all = [];
  for (const b of BOARDS) {
    await page.goto(`https://www.xiaohongshu.com/board/${b.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
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
    console.log(`《${b.name}》状态内 token: ${found.length}`);
    for (const f of found) all.push({ ...f, board: b.name });
  }
  // 去重（同 id 保留第一个）
  const byId = new Map();
  for (const n of all) if (!byId.has(n.id)) byId.set(n.id, n);
  const members = [], extras = [];
  for (const n of byId.values()) (memberIds.has(n.id) ? members : extras).push(n);
  const queue = [...members, ...extras.slice(0, 20)];
  fs.writeFileSync(path.join(__dirname, 'token_queue.json'), JSON.stringify(queue, null, 2));
  console.log(`待抓: 成员 ${members.length} + 附加 ${Math.min(extras.length, 20)} = ${queue.length}`);

  // 2) 逐篇直达抓取
  let done = 0, fail = 0;
  for (const n of queue) {
    const outFile = path.join(NOTES_DIR, n.id + '.json');
    if (fs.existsSync(outFile)) { done++; continue; }
    const url = `https://www.xiaohongshu.com/explore/${n.id}?xsec_token=${n.token}&xsec_source=pc_user`;
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
        fs.writeFileSync(outFile, JSON.stringify({ board: n.board, url, title: d.t, text: d.c, tags: d.tags, author: d.author, date: d.dt }, null, 2));
        done++;
        console.log(`[NOTE] ${done}/${queue.length} (${n.board}) ${(d.t || '').slice(0, 42)}`);
      } else {
        fail++;
        console.log(`[NOTE] BAD(${(d.t || '空').slice(0, 16)}) ${n.id}`);
      }
    } catch (e) {
      fail++;
      console.log(`[NOTE] FAIL ${n.id} :: ${String(e.message).split('\n')[0].slice(0, 50)}`);
    }
    await sleep(1500 + Math.random() * 1500);
  }
  const total = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.json')).length;
  console.log(`ALL_DONE saved_total=${total} this_run=${done} bad_or_fail=${fail}`);
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
