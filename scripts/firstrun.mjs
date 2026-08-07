/** Screenshots the opening minute exactly as a new player meets it. */
import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  for (const d of readdirSync(base))
    for (const c of [`${base}/${d}/chrome-linux/chrome`, `${base}/${d}/chrome-linux/headless_shell`])
      if (existsSync(c)) return c;
}
mkdirSync('/tmp/gridlock-shots', { recursive: true });
const b = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'], timeout: 30000 });
const ctx = await b.newContext({ viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const p = await ctx.newPage();
const t0 = Date.now();
await p.goto(process.argv[2] ?? 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('.lot__canvas');
console.log(`touchable lot after ${Date.now() - t0} ms`);
// Hesitate, the way a new player does. The hand should arrive at four seconds.
await p.waitForTimeout(4600);
await p.screenshot({ path: '/tmp/gridlock-shots/first-coach.png' });
const coach = await p.locator('.coach').innerText().catch(() => '(none)');
console.log(`coach after hesitating: "${coach}"`);
const hinted = await p.evaluate(() => window.__gridlock.hintedVehicles());
console.log(`hand points at ${hinted.length} car(s)`);
await b.close();
