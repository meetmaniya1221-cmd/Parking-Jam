/**
 * The long way round: a scripted player journey through the meta layer, plus a
 * visual matrix of every accessibility mode and the smallest supported screen.
 *
 * Usage: node scripts/journey.mjs [url]
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

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const SHOTS = '/tmp/gridlock-shots';
mkdirSync(SHOTS, { recursive: true });

const problems = [];
const step = (m) => console.log(`  · ${m}`);

function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning')
      problems.push(`console.${msg.type()}: ${msg.text()}`);
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
}

const wallet = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('gridlock-city:save:v1')).wallet);

/** Give the profile a bankroll and some progress through the app's own store. */
async function seed(page, patch) {
  await page.evaluate((p) => {
    const g = window.__gridlock;
    g.seed(p);
  }, patch);
  await page.waitForTimeout(200);
}

/**
 * Fund districts to completion and watch the timelapse fire. Two of them: the
 * first landmark hangs off Riverside, so one district is not enough to reach
 * the trophy case.
 */
async function restoreDistricts(page, count) {
  let timelapses = 0;
  for (let round = 0; round < count; round++) {
    await page.locator('.tab--map').click();
    await page.waitForTimeout(400);

    for (let i = 0; i < 12; i++) {
      const fundAll = page.locator('.district .btn', { hasText: 'Fund all' }).first();
      if (!(await fundAll.isVisible().catch(() => false))) break;
      await fundAll.click();
      await page.waitForTimeout(500);
      if (await page.locator('.timelapse').isVisible().catch(() => false)) break;
    }

    const sawTimelapse = await page
      .waitForSelector('.timelapse', { timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    if (!sawTimelapse) continue;
    timelapses++;
    await page.waitForTimeout(2600);
    if (round === 0) await page.screenshot({ path: `${SHOTS}/j1-timelapse.png` });
    await page.locator('.timelapse__skip').click();
    await page.waitForTimeout(600);
  }

  if (timelapses < count) {
    problems.push(`only ${timelapses} of ${count} district completions played a timelapse`);
    return;
  }
  step(`${timelapses} districts restored, timelapses played`);

  const after = await wallet(page);
  if (after.medallions < 20 * count)
    problems.push(`district completions paid ${after.medallions} Medallions`);
  if (after.blueprints < count) problems.push('district completion paid no Blueprint');
}

/** City Income should accrue against a restored district and be collectable. */
async function collectIncome(page) {
  await page.evaluate(() => window.__gridlock.seed({ backdateIncomeHours: 5 }));
  await page.locator('.tab--depot').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/j2-depot.png` });

  const heading = await page.locator('.card--depot .card__title').innerText();
  const waiting = Number(heading.replace(/[^\d]/g, ''));
  if (!(waiting > 0)) {
    problems.push(`no income accrued after five hours: "${heading}"`);
    return;
  }
  const before = await wallet(page);
  await page.locator('.card--depot .btn--primary').click();
  await page.waitForTimeout(500);
  const after = await wallet(page);
  if (after.coins <= before.coins) problems.push('collecting income paid nothing');
  else step(`collected ${after.coins - before.coins} Coins (capped at four hours)`);
}

/** A landmark needs its district restored and the Blueprints in hand. */
async function buildLandmark(page) {
  await page.evaluate(() => window.__gridlock.seed({ blueprints: 20 }));
  await page.locator('.tab--map').click();
  await page.waitForTimeout(500);
  const build = page.locator('.landmark .btn', { hasText: 'Build' }).first();
  if (await build.isDisabled()) {
    problems.push('landmark stayed locked with its district done and Blueprints banked');
    return;
  }
  await build.click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/j3-landmark.png` });
  const built = await page.locator('.landmark--built').count();
  if (built < 1) problems.push('landmark did not move into the trophy case');
  else step('landmark built');
}

/** A restored district must absorb surplus Coins, endlessly. */
async function beautify(page) {
  await page.evaluate(() => window.__gridlock.seed({ coins: 40000 }));
  await page.locator('.tab--map').click();
  await page.waitForTimeout(400);
  const button = page.locator('.district .btn', { hasText: 'Beautify' }).first();
  if (!(await button.isVisible().catch(() => false))) {
    problems.push('beautification: a restored district offered nothing to place');
    return;
  }
  const before = await wallet(page);
  await button.click();
  await page.waitForTimeout(500);
  const after = await wallet(page);
  if (after.coins !== before.coins - 500) {
    problems.push(`beautification: coins went ${before.coins} → ${after.coins}`);
    return;
  }
  const note = await page.locator('.district--complete .district__note').first().innerText();
  if (!/pieces placed/.test(note)) problems.push(`beautification: district reads "${note}"`);
  else step('beautification absorbed surplus and shows on the district');
  await page.screenshot({ path: `${SHOTS}/j9-beautify.png` });
}

/** Buy and equip a livery, and check the fleet actually repaints. */
async function equipLivery(page) {
  await page.evaluate(() => window.__gridlock.seed({ medallions: 5000 }));
  await page.locator('.tab--garage').click();
  await page.waitForTimeout(400);
  await page.locator('.tabs .btn', { hasText: 'Liveries' }).click();
  await page.waitForTimeout(300);

  const buy = page.locator('.item .btn--secondary').first();
  await buy.click();
  await page.waitForTimeout(300);
  const equip = page.locator('.item .btn--primary', { hasText: 'Equip' }).first();
  await equip.click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/j4-garage.png` });

  const equipped = await page.evaluate(
    () => JSON.parse(localStorage.getItem('gridlock-city:save:v1')).garage.equipped.livery,
  );
  if (equipped === 'factory') problems.push('equipping a livery did not stick');
  else step(`equipped livery ${equipped}`);

  await page.locator('.tab--play').click();
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/j5-livery-in-lot.png` });
}

/** Every accessibility mode has to survive the same lot. */
async function visualMatrix(page) {
  const modes = [
    { name: 'deuteranopia', patch: { settings: { colorblind: 'deuteranopia' } } },
    { name: 'protanopia', patch: { settings: { colorblind: 'protanopia' } } },
    { name: 'tritanopia', patch: { settings: { colorblind: 'tritanopia' } } },
    { name: 'high-contrast', patch: { settings: { colorblind: 'off', highContrast: true } } },
    { name: 'reduced-motion', patch: { settings: { highContrast: false, reducedMotion: true } } },
    { name: 'text-130', patch: { settings: { reducedMotion: false, textScale: 1.3 } } },
  ];
  for (const mode of modes) {
    await page.evaluate((p) => window.__gridlock.seed(p), mode.patch);
    await page.locator('.tab--map').click();
    await page.waitForTimeout(350);
    await page.screenshot({ path: `${SHOTS}/j6-map-${mode.name}.png` });
    await page.locator('.tab--play').click();
    await page.waitForSelector('.lot__canvas');
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${SHOTS}/j7-lot-${mode.name}.png` });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    if (overflow) problems.push(`${mode.name}: the page scrolls sideways`);
  }
  step('accessibility matrix captured');
}

async function main() {
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: findChromium(),
    timeout: 30_000,
  });

  for (const viewport of [
    { name: 'phone', width: 412, height: 892 },
    { name: 'small', width: 320, height: 568 },
    { name: 'tablet', width: 768, height: 1024 },
  ]) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 2,
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    watch(page);
    try {
      await page.goto(URL, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.lot__canvas');
      await page.waitForTimeout(400);
      await seed(page, { level: 30, coins: 40000, medallions: 2000 });

      if (viewport.name === 'phone') {
        await restoreDistricts(page, 2);
        await collectIncome(page);
        await buildLandmark(page);
        await beautify(page);
        await equipLivery(page);
        await visualMatrix(page);
      } else {
        for (const tab of ['map', 'depot', 'events', 'garage']) {
          await page.locator(`.tab--${tab}`).click();
          await page.waitForTimeout(350);
          await page.screenshot({ path: `${SHOTS}/j8-${viewport.name}-${tab}.png` });
        }
        await page.locator('.tab--play').click();
        await page.waitForSelector('.lot__canvas');
        await page.waitForTimeout(600);
        await page.screenshot({ path: `${SHOTS}/j8-${viewport.name}-lot.png` });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1,
        );
        if (overflow) problems.push(`${viewport.name}: the page scrolls sideways`);
        step(`${viewport.name} (${viewport.width}×${viewport.height}) laid out`);
      }
    } catch (err) {
      problems.push(`${viewport.name} fatal: ${String(err.message).split('\n')[0]}`);
    } finally {
      await context.close();
    }
  }

  await browser.close();
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(' - ' + p);
    process.exitCode = 1;
  } else {
    console.log('\nclean: meta journey completed, every mode and viewport laid out');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
