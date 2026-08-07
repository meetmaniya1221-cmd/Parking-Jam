/**
 * Frame-time probe: plays through a packed lot and reports the render budget.
 *
 * Usage: node scripts/perf.mjs [url]
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';

function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  for (const d of readdirSync(base))
    for (const c of [`${base}/${d}/chrome-linux/chrome`, `${base}/${d}/chrome-linux/headless_shell`])
      if (existsSync(c)) return c;
  return undefined;
}

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox'],
  timeout: 30_000,
});
const context = await browser.newContext({
  viewport: { width: 412, height: 892 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
page.setDefaultTimeout(10_000);
await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lot__canvas');
await page.waitForTimeout(500);

for (const level of [1, 120, 300]) {
  await page.evaluate((n) => window.__gridlock.jumpTo(n), level);
  await page.waitForTimeout(700);
  const stats = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const frames = [];
        let last = performance.now();
        const tick = (now) => {
          frames.push(now - last);
          last = now;
          if (frames.length < 150) requestAnimationFrame(tick);
          else {
            frames.sort((a, b) => a - b);
            resolve({
              p50: frames[Math.floor(frames.length * 0.5)],
              p95: frames[Math.floor(frames.length * 0.95)],
              max: frames[frames.length - 1],
              cars: window.__gridlock.lotView.state.remaining,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );
  console.log(
    `L${String(level).padEnd(3)} ${String(stats.cars).padStart(2)} cars  ` +
      `p50 ${stats.p50.toFixed(1)}ms  p95 ${stats.p95.toFixed(1)}ms  max ${stats.max.toFixed(1)}ms`,
  );
}

const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);
if (heap) console.log(`heap ${(heap / 1048576).toFixed(1)} MB`);
await browser.close();
