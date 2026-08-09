/**
 * Layout integrity, across viewports and accessibility modes.
 *
 * The play screen is a three-row grid whose middle row is the puzzle, so every
 * pixel the chrome gains the lot loses — and `.app` hides overflow, which means
 * a HUD that outgrows its row does not break visibly, it just silently clips.
 * This asserts what a screenshot cannot: nothing overflows, the lot never slides
 * under the HUD or the boosters, and it never gets squeezed to nothing.
 *
 * Usage: node scripts/layout.mjs [url]
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base))
    for (const c of [`${base}/${d}/chrome-linux/chrome`, `${base}/${d}/chrome-linux/headless_shell`])
      if (existsSync(c)) return c;
  return undefined;
}
const OUT = '/tmp/gridlock-shots/a11y';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
const problems = [];
for (const vp of [{ n: 'phone', w: 412, h: 892 }, { n: 'tiny', w: 320, h: 568 }, { n: 'desktop', w: 1440, h: 900 }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${vp.n}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${vp.n}: ${m.text()}`));
  await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(500);

  for (const mode of ['base', 'text-130', 'high-contrast', 'deuteranopia', 'left-handed', 'reduced-motion']) {
    await page.evaluate((m) => {
      const g = window.__gridlock;
      const patch = { settings: {} };
      if (m === 'text-130') patch.settings.textScale = 1.3;
      if (m === 'high-contrast') patch.settings.highContrast = true;
      if (m === 'deuteranopia') patch.settings.colorblind = 'deuteranopia';
      if (m === 'left-handed') patch.settings.leftHanded = true;
      if (m === 'reduced-motion') patch.settings.reducedMotion = true;
      g.seed(patch);
    }, mode);
    await page.evaluate(() => window.__gridlock.jumpTo(4));
    await page.waitForTimeout(650);

    const box = await page.evaluate(() => {
      const r = (sel) => { const n = document.querySelector(sel); return n ? n.getBoundingClientRect() : null; };
      const app = r('.app'), header = r('.play__header'), lot = r('.lot'), footer = r('.play__footer');
      return {
        appW: app.width, docW: document.documentElement.scrollWidth, winW: window.innerWidth,
        headerBottom: header.bottom, lotTop: lot.top, lotBottom: lot.bottom, footerTop: footer.top,
        lotH: lot.height,
        overflow: Math.max(...[...document.querySelectorAll('.play *')].map((n) => n.getBoundingClientRect().right)) - app.right,
      };
    });
    if (box.docW > box.winW + 1) problems.push(`${vp.n}/${mode}: horizontal scroll ${box.docW}>${box.winW}`);
    if (box.lotTop < box.headerBottom - 1) problems.push(`${vp.n}/${mode}: lot under HUD`);
    if (box.lotBottom > box.footerTop + 1) problems.push(`${vp.n}/${mode}: lot under footer`);
    if (box.lotH < 140) problems.push(`${vp.n}/${mode}: lot squeezed to ${Math.round(box.lotH)}px`);
    if (box.overflow > 1) problems.push(`${vp.n}/${mode}: play content overflows by ${box.overflow.toFixed(0)}px`);
    await page.screenshot({ path: `${OUT}/${vp.n}-${mode}.png` });
    // reset
    await page.evaluate(() => window.__gridlock.seed({ settings: { textScale: 1, highContrast: false, colorblind: 'off', leftHanded: false, reducedMotion: false } }));
    await page.waitForTimeout(200);
  }
  await ctx.close();
}
await browser.close();
if (problems.length) {
  console.log(`${problems.length} problem(s):`);
  for (const p of problems) console.log(` - ${p}`);
  process.exitCode = 1;
} else {
  console.log('clean: no overflow, no overlap, no console errors');
  console.log(`shots in ${OUT}`);
}
