import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
function findChromium() {
  const base = '/opt/pw-browsers';
  for (const d of readdirSync(base))
    for (const c of [`${base}/${d}/chrome-linux/chrome`, `${base}/${d}/chrome-linux/headless_shell`])
      if (existsSync(c)) return c;
}
const level = Number(process.argv[2] ?? 200);
const b = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'], timeout: 30000 });
const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
p.setDefaultTimeout(10000);
await p.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.lot__canvas');
await p.waitForTimeout(500);
await p.evaluate((n) => window.__gridlock.jumpTo(n), level);
await p.waitForTimeout(900);
const info = await p.evaluate(() => {
  const g = window.__gridlock;
  const s = g.lotView.state;
  return {
    camera: g.lotView.camera,
    rect: g.canvas.getBoundingClientRect().toJSON(),
    grid: { w: s.level.w, h: s.level.h },
    vehicles: Array.from({ length: s.x.length }, (_, i) => ({
      i, kind: s.level.vehicles[i].kind, x: s.x[i], y: s.y[i], f: s.facing[i], len: s.len[i], gone: s.gone[i],
    })),
  };
});
console.log(JSON.stringify(info, null, 1));
await p.screenshot({ path: `/tmp/gridlock-shots/zoom-L${level}.png`, clip: { x: 0, y: info.rect.y, width: 412, height: Math.min(500, info.rect.height) } });
await b.close();
