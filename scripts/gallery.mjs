/**
 * Visual gallery: screenshot a spread of lots so the art can be eyeballed.
 *
 * Levels are chosen to cover every vehicle class and every modifier — small
 * tutorial lots, arrows, oil, VIPs, ambulances, roundabouts and gates — plus a
 * Night Shift lot and the accessibility modes, because "looks better" has to
 * mean better in a colourblind remap and in high contrast too.
 *
 * Usage: node scripts/gallery.mjs [url]
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

const OUT = '/tmp/gridlock-shots';
mkdirSync(OUT, { recursive: true });

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
page.setDefaultTimeout(15_000);

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lot__canvas');
await page.waitForTimeout(600);

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
};

// A spread across the campaign: every mechanic gets an outing.
for (const level of [1, 18, 30, 45, 66, 96, 140, 210, 300]) {
  await page.evaluate((n) => window.__gridlock.jumpTo(n), level);
  await page.waitForTimeout(650);
  await shot(`lot-${String(level).padStart(3, '0')}`);
}

// A car mid-selection, so the preview lane and rings are captured.
await page.evaluate((n) => window.__gridlock.jumpTo(n), 96);
await page.waitForTimeout(600);
const target = await page.evaluate(() => {
  const g = window.__gridlock;
  const vi = g.exitable()[0];
  const cam = g.lotView.camera;
  const s = g.lotView.state;
  const r = g.canvas.getBoundingClientRect();
  return {
    x: r.left + cam.ox + (s.x[vi] + 0.5) * cam.cw,
    y: r.top + cam.oy + (s.y[vi] + 0.5) * cam.ch,
  };
});
await page.mouse.move(target.x, target.y);
await page.mouse.down();
await page.mouse.move(target.x + 6, target.y + 6, { steps: 4 });
await page.waitForTimeout(220);
await shot('selected');
await page.mouse.up();
await page.waitForTimeout(400);

// Accessibility modes have to survive the new art.
for (const [mode, settings] of [
  ['deuteranopia', { colorblind: 'deuteranopia' }],
  ['contrast', { highContrast: true }],
]) {
  await page.evaluate((s) => window.__gridlock.seed({ settings: s }), settings);
  await page.evaluate(() => window.__gridlock.jumpTo(140));
  await page.waitForTimeout(700);
  await shot(`mode-${mode}`);
}
await page.evaluate(() =>
  window.__gridlock.seed({ settings: { colorblind: 'off', highContrast: false } }),
);

// Night Shift is its own draw path and the hardest test of the new lighting.
await page.locator('.play__headRow .iconBtn').first().click();
await page.waitForTimeout(400);
await page.locator('.tab--events').click();
await page.waitForTimeout(400);
await page.locator('.card--night .btn').click();
await page.waitForSelector('.lot__canvas');
await page.waitForTimeout(900);
await shot('mode-night');

console.log(errors.length ? `\nconsole errors:\n${errors.join('\n')}` : '\nno console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
