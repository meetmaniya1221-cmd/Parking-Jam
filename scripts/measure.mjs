import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
function findChromium() {
  const base = '/opt/pw-browsers';
  for (const dir of readdirSync(base)) {
    for (const c of [`${base}/${dir}/chrome-linux/chrome`, `${base}/${dir}/chrome-linux/headless_shell`]) {
      if (existsSync(c)) return c;
    }
  }
}
const b = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'], timeout: 30000 });
const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
p.setDefaultTimeout(10000);
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.lot__canvas');
await p.waitForTimeout(900);
console.log(JSON.stringify(await p.evaluate(() => {
  const g = window.__gridlock;
  const c = g.canvas;
  const r = c.getBoundingClientRect();
  const lot = document.querySelector('.lot').getBoundingClientRect();
  return {
    dpr: devicePixelRatio,
    canvasCss: { w: r.width, h: r.height, x: r.x, y: r.y },
    canvasPx: { w: c.width, h: c.height },
    lotCss: { w: lot.width, h: lot.height, x: lot.x, y: lot.y },
    camera: g.lotView.camera,
    level: { w: g.lotView.state.level.w, h: g.lotView.state.level.h },
  };
}), null, 2));
await b.close();
