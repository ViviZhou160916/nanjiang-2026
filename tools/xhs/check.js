// 只读检查：当前 profile 里是否还有小红书登录 Cookie
const { chromium } = require('playwright-core');
const path = require('path');
const EXEC = '/Users/joy/Library/Caches/ms-playwright/chromium-1091/chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const PROFILE = path.join(__dirname, 'profile');
(async () => {
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EXEC, headless: true, args: ['--no-first-run'],
  });
  const cs = await ctx.cookies('https://www.xiaohongshu.com');
  console.log('cookies:', cs.map((c) => c.name).join(', ') || '(无)');
  console.log('web_session:', cs.some((c) => c.name === 'web_session') ? '存在' : '不存在');
  await ctx.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
