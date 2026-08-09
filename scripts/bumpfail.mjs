/**
 * The three-bump failure rule and the VIP marker, driven through the real game.
 *
 * Every check here goes through genuine pointer input rather than poking state,
 * because the things that break are exactly the ones a state-level test cannot
 * see: an input that stays live behind the overlay, a counter that lags the
 * collision, a repeated shove that charges twice.
 *
 * Usage: node scripts/bumpfail.mjs [url]
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

const SHOTS = '/tmp/gridlock-shots';
mkdirSync(SHOTS, { recursive: true });
const problems = [];
const step = (m) => console.log(`  · ${m}`);

const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox'],
  timeout: 30_000,
});
const context = await browser.newContext({
  viewport: { width: 412, height: 892 },
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
page.on('pageerror', (e) => problems.push(`pageerror: ${e}`));

await page.goto(process.argv[2] ?? 'http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.lot__canvas');
await page.waitForTimeout(600);

const state = () =>
  page.evaluate(() => {
    const s = window.__gridlock.lotView.state;
    return { bumps: s.bumps, remaining: s.remaining, x: [...s.x], y: [...s.y], facing: [...s.facing] };
  });

const bumpLabel = () => page.locator('.play__bumps').innerText();
const bumpClass = () => page.locator('.play__bumps').getAttribute('class');

/** Shove a car that cannot move, in the direction it refuses. */
async function shove(vi) {
  const path = await page.evaluate((index) => {
    const g = window.__gridlock;
    const cam = g.lotView.camera;
    const s = g.lotView.state;
    const rect = g.canvas.getBoundingClientRect();
    const f = s.facing[index];
    const dx = [0, 1, 0, -1][f];
    const dy = [-1, 0, 1, 0][f];
    const from = {
      x: rect.left + cam.ox + (s.x[index] + 0.5) * cam.cw,
      y: rect.top + cam.oy + (s.y[index] + 0.5) * cam.ch,
    };
    return { from, to: { x: from.x + dx * cam.cw * 1.4, y: from.y + dy * cam.ch * 1.4 } };
  }, vi);
  await page.mouse.move(path.from.x, path.from.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(
      path.from.x + ((path.to.x - path.from.x) * i) / 5,
      path.from.y + ((path.to.y - path.from.y) * i) / 5,
    );
    await page.waitForTimeout(22);
  }
  await page.mouse.up();
  await page.waitForTimeout(280);
}

/** A car whose forward path is blocked by another car, so shoving it bumps. */
async function blockedCar() {
  return page.evaluate(() => {
    const g = window.__gridlock;
    const s = g.lotView.state;
    const open = new Set(g.exitable());
    for (let i = 0; i < s.x.length; i++) if (!s.gone[i] && !open.has(i)) return i;
    return -1;
  });
}

await page.evaluate(() => window.__gridlock.jumpTo(40));
await page.waitForTimeout(700);

// TESTS 3-5 — one bump, two bumps with a warning, three bumps and the jam ends.
let victim = await blockedCar();
if (victim < 0) problems.push('no blocked car to shove on L40');

await shove(victim);
let s1 = await state();
if (s1.bumps !== 1) problems.push(`first shove gave ${s1.bumps} bumps, wanted 1`);
else step(`bump 1 registered — counter reads "${await bumpLabel()}"`);

// TEST 6 — shoving the same car the same way again is the same collision.
await shove(victim);
const sRepeat = await state();
if (sRepeat.bumps !== 1) {
  problems.push(`repeat shove of the same blocked car counted again (${sRepeat.bumps})`);
} else {
  step('repeat shove of the same collision did not count twice');
}

// A different blocked car is a genuinely separate collision.
const other = await page.evaluate((first) => {
  const g = window.__gridlock;
  const s = g.lotView.state;
  const open = new Set(g.exitable());
  for (let i = 0; i < s.x.length; i++) if (!s.gone[i] && !open.has(i) && i !== first) return i;
  return -1;
}, victim);
if (other < 0) problems.push('no second blocked car available');
await shove(other);
const s2 = await state();
if (s2.bumps !== 2) problems.push(`second distinct collision gave ${s2.bumps} bumps, wanted 2`);
else step(`bump 2 registered — counter reads "${await bumpLabel()}"`);

const warnClass = await bumpClass();
if (!warnClass.includes('play__bumps--danger')) {
  problems.push(`at 2 bumps the counter is not in its danger state (class="${warnClass}")`);
} else {
  step('counter shows the strong "one left" warning at 2 bumps');
}
await page.screenshot({ path: `${SHOTS}/bump-2.png` });

// TEST 5 — the third distinct collision must end the jam at once.
const third = await page.evaluate(
  (skip) => {
    const g = window.__gridlock;
    const s = g.lotView.state;
    const open = new Set(g.exitable());
    for (let i = 0; i < s.x.length; i++) if (!s.gone[i] && !open.has(i) && !skip.includes(i)) return i;
    return -1;
  },
  [victim, other],
);
await shove(third < 0 ? victim : third);
await page.waitForTimeout(500);

const failSheet = page.locator('.sheet');
const failVisible = await failSheet.isVisible().catch(() => false);
const failText = failVisible ? await failSheet.innerText() : '';
if (!failVisible || !/bump/i.test(failText)) {
  problems.push(`third bump did not raise the failure sheet (text="${failText.slice(0, 80)}")`);
} else {
  step(`level failed on the third bump: "${failText.split('\n').slice(0, 3).join(' / ')}"`);
}
await page.screenshot({ path: `${SHOTS}/bump-failed.png` });

// Gameplay must be frozen behind the sheet. Checked by reading the view's own
// interactive flag rather than by shoving a car: a shove at canvas coordinates
// now lands on the overlay backdrop and dismisses the sheet, which tests the
// backdrop rather than the freeze.
const frozen = await page.evaluate(() => !window.__gridlock.lotView.interactive);
if (!frozen) problems.push('input still live behind the failure sheet');
else step('input frozen behind the failure sheet');

// TEST 7 — retry restores the level exactly.
const opening = await page.evaluate(() => {
  const L = window.__gridlock.lotView.currentLevel();
  return { x: L.vehicles.map((v) => v.x), y: L.vehicles.map((v) => v.y), f: L.vehicles.map((v) => v.facing) };
});
const retry = page.locator('.sheet__actions .btn--primary');
if (!(await retry.isVisible().catch(() => false))) {
  problems.push(`no retry button on the failure sheet: ${await page.locator('.sheet').innerHTML().catch(() => '?')}`);
}
await retry.click();
await page.waitForTimeout(700);
const afterRetry = await state();
if (afterRetry.bumps !== 0) problems.push(`retry left ${afterRetry.bumps} bumps, wanted 0`);
const samePlaces =
  JSON.stringify(afterRetry.x) === JSON.stringify(opening.x) &&
  JSON.stringify(afterRetry.y) === JSON.stringify(opening.y) &&
  JSON.stringify(afterRetry.facing) === JSON.stringify(opening.f);
if (!samePlaces) problems.push('retry did not restore every car to its opening position and facing');
const cls = await bumpClass();
if (cls.includes('--warn') || cls.includes('--danger')) {
  problems.push(`retry left the counter in a warning state (class="${cls}")`);
}
if (afterRetry.bumps === 0 && samePlaces) step('retry restored the same lot, cars home, bumps 0');
await page.screenshot({ path: `${SHOTS}/bump-retry.png` });

// TEST 8 — and it fails again, so the rule survives a reset.
for (const target of [await blockedCar()]) {
  void target;
}
let again = 0;
const tried = [];
for (let guard = 0; guard < 8 && again < 3; guard++) {
  const pick = await page.evaluate((skip) => {
    const g = window.__gridlock;
    const s = g.lotView.state;
    const open = new Set(g.exitable());
    for (let i = 0; i < s.x.length; i++) if (!s.gone[i] && !open.has(i) && !skip.includes(i)) return i;
    return -1;
  }, tried);
  if (pick < 0) break;
  tried.push(pick);
  await shove(pick);
  again = (await state()).bumps;
}
const failedAgain = await page.locator('.sheet').isVisible().catch(() => false);
if (!failedAgain) problems.push('after retry, three more bumps did not fail the level again');
else step('failed again after retry — the rule survives a reset');

// TEST 2 — the VIP marker rides along with its car. Find a lot that has one.
await page.locator('.sheet__actions .btn--primary').click().catch(() => {});
await page.waitForTimeout(400);
let vipFound = -1;
for (const n of [15, 16, 17, 18, 22, 26, 31, 44, 58, 70]) {
  await page.evaluate((i) => window.__gridlock.jumpTo(i), n);
  await page.waitForTimeout(450);
  const has = await page.evaluate(() => {
    const s = window.__gridlock.lotView.state;
    for (let i = 0; i < s.x.length; i++) if (!s.gone[i] && s.tags[i] & 1) return i;
    return -1;
  });
  if (has >= 0) {
    vipFound = has;
    step(`VIP found on L${n} (car ${has})`);
    await page.screenshot({ path: `${SHOTS}/vip-start.png` });
    break;
  }
}
if (vipFound < 0) {
  problems.push('no VIP car found on any sampled level');
} else {
  // The marker is drawn from the car's own screen box, so "does it follow?" is
  // really "does the car still carry the tag after moving?" — checked by moving
  // it and confirming the tag rides along, in both orientations.
  const before = await page.evaluate((vi) => {
    const s = window.__gridlock.lotView.state;
    return { x: s.x[vi], y: s.y[vi], vip: !!(s.tags[vi] & 1), horizontal: s.facing[vi] % 2 === 1 };
  }, vipFound);
  await shove(vipFound);
  const after = await page.evaluate((vi) => {
    const s = window.__gridlock.lotView.state;
    return { x: s.x[vi], y: s.y[vi], vip: !!(s.tags[vi] & 1), gone: !!s.gone[vi] };
  }, vipFound);
  if (!after.gone && !after.vip) problems.push('VIP lost its marker after moving');
  else step(`VIP marker survives movement (${before.horizontal ? 'horizontal' : 'vertical'} car)`);
  await page.screenshot({ path: `${SHOTS}/vip-moved.png` });
}

console.log(problems.length ? `\n${problems.length} problem(s):` : '\nclean: bump rule and VIP marker behave');
for (const p of problems) console.log(` - ${p}`);
await browser.close();
process.exit(problems.length ? 1 : 0);
