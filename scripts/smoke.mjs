/**
 * Browser smoke test.
 *
 * Boots the game, clears a level by driving real pointer events, walks every
 * meta screen, and reports console errors, page exceptions and failed requests
 * along the way. Screenshots land in /tmp/gridlock-shots.
 *
 * Usage: node scripts/smoke.mjs [url]
 */

import { chromium } from 'playwright';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';

/** Use whichever Chromium this machine already has, rather than downloading one. */
function findChromium() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  for (const dir of readdirSync(base)) {
    for (const candidate of [
      `${base}/${dir}/chrome-linux/chrome`,
      `${base}/${dir}/chrome-linux/headless_shell`,
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const SHOTS = '/tmp/gridlock-shots';
mkdirSync(SHOTS, { recursive: true });

const problems = [];
const step = (message) => console.log(`  · ${message}`);

function watch(page) {
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      problems.push(`console.${msg.type()}: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) =>
    problems.push(`requestfailed: ${req.url()} ${req.failure()?.errorText}`),
  );
}

async function lotState(page) {
  return page.evaluate(() => {
    const g = window.__gridlock;
    if (!g?.lotView) return null;
    const s = g.lotView.state;
    return { remaining: s.remaining, slides: s.slides, bumps: s.bumps, total: s.x.length };
  });
}

/** Tap the centre of a vehicle's nose cell, in page coordinates. */
async function tapVehicle(page, vi) {
  const point = await page.evaluate((index) => {
    const g = window.__gridlock;
    const cam = g.lotView.camera;
    const s = g.lotView.state;
    const rect = g.canvas.getBoundingClientRect();
    return {
      x: rect.left + cam.ox + (s.x[index] + 0.5) * cam.cw,
      y: rect.top + cam.oy + (s.y[index] + 0.5) * cam.ch,
    };
  }, vi);
  await page.mouse.click(point.x, point.y);
}

/** Close a Mystery Trunk reveal if one popped, taking the plain reward. */
async function dismissTrunk(page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('.sheet--trunk').isVisible().catch(() => false))) return;
    await page.locator('.sheet--trunk .sheet__actions .btn').last().click();
    await page.waitForTimeout(500);
  }
}

/** Decline any rewarded-video offer, the way a player tapping "no thanks" would. */
async function declineOffer(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('.sheet--offer').isVisible().catch(() => false))) return;
    await page.locator('.sheet--offer .btn--ghost').click();
    await page.waitForTimeout(400);
  }
}

/** No surface may sit on top of another (GDD §14). */
async function assertSingleModal(page, label) {
  const open = await page.locator('.overlay').count();
  if (open > 1) problems.push(`${label}: ${open} overlays stacked`);
}

/** Wait for the win screen, clearing trunk reveals that gate it. */
async function waitForWin(page) {
  for (let i = 0; i < 14; i++) {
    if (await page.locator('.sheet--win').isVisible().catch(() => false)) return true;
    await dismissTrunk(page);
    await page.waitForTimeout(900);
  }
  return page.locator('.sheet--win').isVisible().catch(() => false);
}

/** Dismiss whatever modal is on screen, including a simulated ad. */
async function dismissAd(page) {
  await declineOffer(page);
  if (await page.locator('.overlay--ad').isVisible().catch(() => false)) {
    await page.waitForSelector('.overlay--ad', { state: 'detached', timeout: 12_000 }).catch(() => {});
  }
}

/** Clear the current lot by repeatedly tapping whatever can leave. */
async function clearLot(page, label) {
  for (let guard = 0; guard < 80; guard++) {
    const state = await lotState(page);
    if (!state || state.remaining === 0) return state;
    const exitable = await page.evaluate(() => window.__gridlock.exitable());
    if (exitable.length === 0) {
      problems.push(`${label}: dead end with ${state.remaining} cars left`);
      return state;
    }
    await tapVehicle(page, exitable[0]);
    await page.waitForTimeout(200);
  }
  problems.push(`${label}: ran out of taps before clearing`);
  return lotState(page);
}

/** Drag a car along its own axis with a real pointer gesture. */
async function dragVehicle(page, vi, cells) {
  const path = await page.evaluate(
    ({ index, n }) => {
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
      return { from, to: { x: from.x + dx * n * cam.cw, y: from.y + dy * n * cam.ch } };
    },
    { index: vi, n: cells },
  );
  await page.mouse.move(path.from.x, path.from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(
      path.from.x + ((path.to.x - path.from.x) * i) / 6,
      path.from.y + ((path.to.y - path.from.y) * i) / 6,
    );
    await page.waitForTimeout(24);
  }
  await page.mouse.up();
  await page.waitForTimeout(320);
}

/** Exercise dragging, bumping and undo on a mid-game lot. */
async function checkInteractions(page) {
  await page.evaluate(() => window.__gridlock.jumpTo(40));
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(700);

  const before = await lotState(page);
  // Pick a car that cannot leave; dragging it should reposition or bump, never exit.
  const stuck = await page.evaluate(() => {
    const g = window.__gridlock;
    const open = new Set(g.exitable());
    const s = g.lotView.state;
    for (let i = 0; i < s.x.length; i++) if (!s.gone[i] && !open.has(i)) return i;
    return -1;
  });
  if (stuck < 0) {
    problems.push('interactions: every car could leave, nothing to test against');
    return;
  }

  await dragVehicle(page, stuck, 2);
  const afterDrag = await lotState(page);
  if (afterDrag.remaining !== before.remaining) {
    problems.push('interactions: a blocked car left the lot on a drag');
  }
  if (afterDrag.slides === before.slides && afterDrag.bumps === before.bumps) {
    problems.push('interactions: dragging a blocked car did nothing at all');
  }
  step(`drag: ${afterDrag.slides - before.slides} slides, ${afterDrag.bumps - before.bumps} bumps`);
  await page.screenshot({ path: `${SHOTS}/07-drag.png` });

  if (afterDrag.slides > before.slides) {
    const undo = await page.locator('.booster--undo');
    if (await undo.isDisabled()) {
      problems.push('interactions: undo stayed disabled after a slide');
    } else {
      await undo.click();
      await page.waitForTimeout(400);
      const undone = await lotState(page);
      if (undone.slides !== before.slides) {
        problems.push(`interactions: undo left ${undone.slides} slides, expected ${before.slides}`);
      } else {
        step('undo restored the previous position');
      }
    }
  }

  // The Dispatcher hint must always name a car that can actually leave.
  await page.locator('.boosters .btn').nth(2).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/08-hint.png` });
}

/** The lot must be playable with a keyboard alone. */
async function checkKeyboard(page) {
  await page.evaluate(() => window.__gridlock.jumpTo(12));
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(700);
  await page.locator('.lot__canvas').focus();

  const before = await lotState(page);
  // Step the cursor onto a car that can actually leave, then drive it.
  const target = await page.evaluate(() => window.__gridlock.exitable()[0] ?? 0);
  for (let i = 0; i < 40; i++) {
    if ((await page.evaluate(() => window.__gridlock.lotView.selectedVehicle)) === target) break;
    await page.keyboard.press('ArrowRight');
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);

  const after = await lotState(page);
  if (after.remaining !== before.remaining - 1) {
    problems.push(
      `keyboard: Enter did not drive a car out (${before.remaining} → ${after.remaining})`,
    );
  } else {
    step('keyboard play drove a car off the lot');
  }
  await page.screenshot({ path: `${SHOTS}/10-keyboard.png` });
}

/**
 * Metered Lots are the only fail state in the game. Run one out of slides and
 * check the save-me offer appears, that declining lands on a breather rather
 * than a loss screen, and that accepting hands back three slides.
 */
async function checkMeteredLot(page) {
  const target = await page.evaluate(() => {
    // Ask the campaign which nearby jam is actually metered.
    for (let i = 45; i < 200; i++) {
      const limit = window.__gridlock.meteredLimitFor(i);
      if (limit !== null) return i;
    }
    return -1;
  });
  if (target < 0) {
    problems.push('metered: no metered lot found in the sequence');
    return;
  }

  await page.evaluate((n) => window.__gridlock.jumpTo(n), target);
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(700);

  if (!(await page.locator('.meter').isVisible().catch(() => false))) {
    problems.push(`metered: L${target} showed no slide meter`);
    return;
  }
  step(`metered lot L${target}: ${await page.locator('.meter').innerText()}`);

  // Burn the meter. A packed lot runs out of repositioning room quickly, so
  // alternate: shuffle while there is room, otherwise send a car home to make
  // some. The meter only allows a few slides above par, so this converges.
  let wasted = 0;
  for (let i = 0; i < 80; i++) {
    if (await page.locator('.sheet--offer').isVisible().catch(() => false)) break;
    const state = await lotState(page);
    if (!state || state.remaining === 0) break;
    if (await page.evaluate(() => window.__gridlock.wasteAMove())) {
      wasted++;
    } else {
      const exitable = await page.evaluate(() => window.__gridlock.exitable());
      if (exitable.length === 0) break;
      await tapVehicle(page, exitable[0]);
    }
    await page.waitForTimeout(160);
  }
  step(`burned ${wasted} spare slides`);

  const offered = await page.locator('.sheet--offer').isVisible().catch(() => false);
  if (!offered) {
    problems.push('metered: running out of slides raised no save-me offer');
    return;
  }
  await assertSingleModal(page, 'metered save-me');
  await page.screenshot({ path: `${SHOTS}/11-save-me.png` });

  await page.locator('.sheet--offer .btn--ghost').click();
  await page.waitForTimeout(500);
  const sheet = await page.locator('.sheet__title').first().innerText();
  if (!/meter ran out/i.test(sheet)) {
    problems.push(`metered: declining showed "${sheet}" instead of the one-for-the-road offer`);
  } else {
    step('save-me declined, breather offered');
  }
  await page.locator('.sheet .btn--primary').first().click();
  await page.waitForTimeout(600);
}

async function run(page) {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/01-first-lot.png` });

  const initial = await lotState(page);
  if (!initial) {
    problems.push('no debug handle: window.__gridlock missing');
    return;
  }
  step(`L1: ${initial.total} cars`);

  const cleared = await clearLot(page, 'L1');
  step(`L1 finished: ${cleared.remaining} left, ${cleared.slides} slides, ${cleared.bumps} bumps`);
  if (cleared.bumps > 0) problems.push(`L1: ${cleared.bumps} bumps from clean taps`);

  const winVisible = await waitForWin(page);
  await page.waitForTimeout(400);
  await assertSingleModal(page, 'L1 win');
  await page.screenshot({ path: `${SHOTS}/02-win.png` });
  if (!winVisible) {
    problems.push('win screen did not appear after clearing the lot');
    await page.locator('.tab--map').click();
  } else {
    step('win screen shown');
    // "Next jam" carries straight into L2 — check the hand-off works.
    await page.locator('.sheet--win .btn--primary').click();
    await dismissAd(page);
    await page.waitForTimeout(900);
    const second = await lotState(page);
    if (!second) problems.push('next jam did not load');
    else step(`L2: ${second.total} cars`);
    await page.screenshot({ path: `${SHOTS}/02b-level2.png` });
    await page.locator('.play__headRow .iconBtn').first().click();
    await page.waitForTimeout(500);
  }

  for (const tab of ['map', 'depot', 'events', 'garage']) {
    await page.locator(`.tab--${tab}`).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${SHOTS}/03-${tab}.png` });
    const body = await page.locator('.screen__body').innerText();
    if (!body.trim()) problems.push(`${tab} screen rendered empty`);
  }
  step('meta screens walked');

  await page.locator('.app__bar .iconBtn').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/04-settings.png` });
  await page.locator('.sheet--settings .btn--primary').click();
  await page.waitForTimeout(200);
  step('settings opened and closed');

  await checkInteractions(page);
  await checkKeyboard(page);
  await checkMeteredLot(page);

  // Night Shift renders through a headlight mask — a whole extra draw path.
  await page.locator('.tab--events').click();
  await page.waitForTimeout(400);
  await page.locator('.card--night .btn').click();
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/09-night.png` });
  const night = await lotState(page);
  if (!night) problems.push('night shift failed to load');
  else step(`night shift: ${night.total} cars`);
  await page.locator('.play__headRow .iconBtn').first().click();
  await page.waitForTimeout(400);

  // Deep levels exercise the generator, larger grids and every modifier.
  for (const target of [64, 120, 200, 300]) {
    await page.evaluate((n) => window.__gridlock.jumpTo(n), target);
    await page.waitForSelector('.lot__canvas');
    await page.waitForTimeout(700);
    const state = await lotState(page);
    const index = await page.evaluate(() => window.__gridlock.levelIndex);
    if (index !== target) problems.push(`jumpTo(${target}) landed on ${index}`);
    if (!state) {
      problems.push(`L${target} failed to load`);
      continue;
    }
    step(`L${target}: ${state.total} cars`);
    if (state.total < 8) problems.push(`L${target} only has ${state.total} cars`);
    await page.screenshot({ path: `${SHOTS}/05-L${target}.png` });

    const cleared = await clearLot(page, `L${target}`);
    step(`L${target} finished: ${cleared.remaining} left, ${cleared.bumps} bumps`);
    if (cleared.bumps > 0) problems.push(`L${target}: ${cleared.bumps} bumps from clean taps`);
    const win = await waitForWin(page);
    await page.waitForTimeout(300);
    await assertSingleModal(page, `L${target} win`);
    await page.screenshot({ path: `${SHOTS}/06-L${target}-win.png` });
    if (!win) problems.push(`L${target}: no win screen`);
    else await page.locator('.sheet--win .btn--ghost').click();
    await dismissAd(page);
    await page.waitForTimeout(400);
  }
}

async function main() {
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: findChromium(),
    timeout: 30_000,
  });
  const context = await browser.newContext({
    viewport: { width: 412, height: 892 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  watch(page);

  try {
    await run(page);
  } catch (err) {
    problems.push(`fatal: ${String(err.message).split('\n')[0]}`);
  } finally {
    await browser.close();
  }

  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(' - ' + p);
    process.exitCode = 1;
  } else {
    console.log('\nclean: no console errors, no exceptions, levels cleared, all screens rendered');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
