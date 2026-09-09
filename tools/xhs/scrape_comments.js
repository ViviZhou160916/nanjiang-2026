// 小红书笔记评论抓取 v1：复用登录态真实 Chrome（CDP 9222）
// 思路：逐篇打开笔记 URL（带 xsec_token）→ 滚动触发评论分页 → 拦截 comment/page 接口响应 → 合并写回 notes/*.json
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const NOTES_DIR = path.join(__dirname, 'notes');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BAD_TITLE = /无法浏览|加载中|笔记已删除|不见了|404|登录/;

// 从评论接口响应中提取结构化评论
function parseComments(j) {
  const out = [];
  const list = (j && j.data && j.data.comments) || [];
  for (const c of list) {
    out.push({
      id: c.id,
      user: (c.author_info && c.author_info.nickname) || '',
      content: c.content || '',
      likes: c.like_count || 0,
      ip: c.ip_location || '',
      time: c.create_time ? new Date(c.create_time * 1000).toISOString().slice(0, 10) : '',
      sub_count: c.sub_comment_count || 0,
      sub: (c.sub_comments || []).map((s) => ({
        id: s.id,
        user: (s.author_info && s.author_info.nickname) || '',
        content: s.content || '',
        likes: s.like_count || 0,
        ip: s.ip_location || '',
      })),
    });
  }
  return out;
}

(async () => {
  const files = fs.readdirSync(NOTES_DIR).filter((f) => f.endsWith('.json')).sort();
  console.log(`[START] 待处理 ${files.length} 篇`);

  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.bringToFront().catch(() => {});

  // 登录检查
  await page.goto('https://www.xiaohongshu.com', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);
  const loggedOut = await page.evaluate(() =>
    !!document.querySelector('.login-btn') || /^\s*登录\s*$/m.test(document.body.innerText)).catch(() => false);
  if (loggedOut) {
    console.log('[LOGIN] 请在 Chrome 窗口扫码登录…（脚本等待）');
    for (let i = 0; i < 240; i++) {
      await sleep(3000);
      const ok = await page.evaluate(() =>
        !document.querySelector('.login-btn') && !/^\s*登录\s*$/m.test(document.body.innerText)).catch(() => false);
      if (ok) { await sleep(3000); break; }
      if (i === 239) { console.log('[LOGIN] TIMEOUT'); process.exit(2); }
    }
  }
  console.log('[LOGIN] 登录确认');

  const captured = [];
  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (u.includes('/api/sns/web/v') && u.includes('/comment/page')) {
        const j = await resp.json().catch(() => null);
        if (j) captured.push({ u, j });
      }
    } catch (e) { /* 忽略 */ }
  });

  let done = 0, fail = 0;
  for (const f of files) {
    const p = path.join(NOTES_DIR, f);
    let note;
    try { note = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { continue; }
    if (Array.isArray(note.comments) && note.comments.length) { done++; continue; }
    captured.length = 0;

    // ── 打开笔记 ──
    let opened = false;
    for (let a = 1; a <= 3 && !opened; a++) {
      try {
        await page.goto(note.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);
        try { await page.keyboard.press('Escape'); } catch (e) {}
        const t = await page.evaluate(() => {
          const el = document.querySelector('#detail-title') || document.querySelector('.title');
          return el ? el.textContent.trim() : document.title;
        }).catch(() => '');
        if (t && !BAD_TITLE.test(t)) opened = true;
        else console.log(`[OPEN] 异常(${String(t).slice(0, 20)}) 重试${a}`);
      } catch (e) { console.log(`[OPEN] 出错 重试${a}: ${e.message}`); }
      if (!opened) await sleep(4000);
    }
    if (!opened) { fail++; console.log(`[FAIL] ${f} ${note.title || ''}`); continue; }

    // ── 滚动翻页加载评论 + 展开子评论 ──
    let lastN = -1, stable = 0;
    for (let r = 0; r < 30 && stable < 3; r++) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
        document.querySelectorAll('div').forEach((d) => {
          const s = getComputedStyle(d);
          if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && d.scrollHeight > d.clientHeight + 200) d.scrollTop = d.scrollHeight;
        });
        document.querySelectorAll('div,span').forEach((el) => {
          const tx = el.textContent || '';
          if (/^(展开|展开更多回复|查看更多回复|共\s*\d+\s*条回复)/.test(tx.trim()) && el.children.length === 0) el.click();
        });
      }).catch(() => {});
      await sleep(2300);
      if (captured.length === lastN) stable++; else { stable = 0; lastN = captured.length; }
    }

    // ── 合并：顶层评论按 id 去重；子评论按 root 挂载 ──
    const tops = new Map();
    const subMap = new Map();
    for (const { u, j } of captured) {
      const root = (u.match(/root_comment_id=([^&]+)/) || [])[1] || null;
      for (const c of parseComments(j)) {
        if (root) {
          const arr = subMap.get(root) || [];
          arr.push({ user: c.user, content: c.content, likes: c.likes, ip: c.ip });
          subMap.set(root, arr);
        } else if (!tops.has(c.id)) {
          tops.set(c.id, c);
        }
        if (c.sub && c.sub.length) {
          const arr = subMap.get(c.id) || [];
          for (const s of c.sub) arr.push({ user: s.user, content: s.content, likes: s.likes, ip: s.ip });
          subMap.set(c.id, arr);
        }
      }
    }
    let comments = [...tops.values()].map((c) => {
      const raw = subMap.get(c.id) || [];
      const seen = new Set(); const subs = [];
      for (const s of raw) {
        const k = s.user + '|' + s.content;
        if (!seen.has(k)) { seen.add(k); subs.push(s); }
      }
      return { user: c.user, content: c.content, likes: c.likes, ip: c.ip, time: c.time, sub_count: c.sub_count, subs };
    }).sort((a, b) => b.likes - a.likes);

    // ── DOM 兜底（接口没抓到时）──
    if (!comments.length) {
      const dom = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('.comment-item').forEach((it) => {
          const content = (it.querySelector('.content') || {}).textContent || '';
          const user = ((it.querySelector('.author .name') || it.querySelector('.username') || {}).textContent || '').trim();
          if (content.trim()) out.push({ user: user.trim(), content: content.trim(), likes: 0, ip: '', time: '', sub_count: 0, subs: [] });
        });
        return out;
      }).catch(() => []);
      if (dom.length) comments = dom;
    }

    note.comments = comments;
    note.comment_count = comments.length;
    note.comments_scraped_at = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(p, JSON.stringify(note, null, 2));
    done++;
    const nSub = comments.reduce((a, c) => a + c.subs.length, 0);
    console.log(`[OK ${done}/${files.length}] ${comments.length}条(+${nSub}子) 《${(note.title || '').slice(0, 30)}》`);
    await sleep(5000 + Math.random() * 5000); // 篇间隔，降风控
  }
  console.log(`ALL_DONE notes=${done} fail=${fail}`);
  process.exit(0);
})().catch((e) => { console.error('FATAL', e && e.message); process.exit(1); });
