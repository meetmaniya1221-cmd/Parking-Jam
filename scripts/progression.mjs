/**
 * The progression, seen rather than measured.
 *
 * Screenshots the milestone jams at three screen sizes and prints what the
 * camera actually did with each — grid, cars, cell size, and whether the lot
 * needed to pan. A curve that reads correctly in the test output can still look
 * wrong; this is the check that it does not.
 *
 * Usage: node scripts/progression.mjs [url]
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

const OUT = '/tmp/gridlock-shots/progression';
mkdirSync(OUT, { recursive: true });

const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const LEVELS = [1, 5, 10, 15, 20, 24];
const DEVICES = [
  { name: 'phone-small', width: 360, height: 640, scale: 2, mobile: true },
  { name: 'phone', width: 412, height: 892, scale: 3, mobile: true },
  { name: 'tablet', width: 834, height: 1112, scale: 2, mobile: false },
];

const problems = [];
const browser = await chromium.launch({
  executablePath: findChromium(),
  args: ['--no-sandbox'],
  timeout: 30_000,
});

for (const device of DEVICES) {
  const context = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.scale,
    hasTouch: device.mobile,
    isMobile: device.mobile,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on('pageerror', (e) => problems.push(`${device.name}: pageerror ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`${device.name}: ${m.text()}`));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lot__canvas');
  await page.waitForTimeout(500);

  console.log(`\n${device.name} (${device.width}×${device.height})`);
  console.log('  lvl   grid  cells  cars  cell px  car px  board px      lot px  pan');

  for (const level of LEVELS) {
    await page.evaluate((n) => window.__gridlock.jumpTo(n), level);
    await page.waitForTimeout(700);

    const info = await page.evaluate(() => {
      const g = window.__gridlock;
      const view = g.lotView;
      const cam = view.camera;
      const lot = document.querySelector('.lot').getBoundingClientRect();
      const header = document.querySelector('.play__header').getBoundingClientRect();
      const footer = document.querySelector('.play__footer').getBoundingClientRect();
      return {
        w: view.state.level.w,
        h: view.state.level.h,
        cars: view.state.x.length,
        cw: cam.cw,
        ch: cam.ch,
        ox: cam.ox,
        oy: cam.oy,
        canPan: view.canPan,
        lotW: lot.width,
        lotH: lot.height,
        lotTop: lot.top,
        lotBottom: lot.bottom,
        headerBottom: header.bottom,
        footerTop: footer.top,
      };
    });

    const boardW = info.w * info.cw;
    const boardH = info.h * info.ch;
    console.log(
      [
        String(level).padStart(5),
        `${info.w}x${info.h}`.padStart(6),
        String(info.w * info.h).padStart(6),
        String(info.cars).padStart(5),
        info.cw.toFixed(1).padStart(8),
        (info.cw * 2).toFixed(0).padStart(7),
        `${boardW.toFixed(0)}x${boardH.toFixed(0)}`.padStart(9),
        `${info.lotW.toFixed(0)}x${info.lotH.toFixed(0)}`.padStart(11),
        (info.canPan ? 'yes' : 'no').padStart(4),
      ].join(' '),
    );

    // The board lives between the HUD and the boosters — never under them.
    if (info.lotTop < info.headerBottom - 1) {
      problems.push(`${device.name} L${level}: lot overlaps the HUD`);
    }
    if (info.lotBottom > info.footerTop + 1) {
      problems.push(`${device.name} L${level}: lot overlaps the boosters`);
    }
    // Nothing drawn may spill outside the canvas unless the lot is pannable.
    if (!info.canPan && (info.ox < -1 || info.oy < -1)) {
      problems.push(`${device.name} L${level}: board overflows a lot that claims to fit`);
    }
    if (info.cw < 18) {
      problems.push(`${device.name} L${level}: cells down to ${info.cw.toFixed(1)}px`);
    }

    await page.screenshot({ path: `${OUT}/${device.name}-L${String(level).padStart(2, '0')}.png` });
  }

  await context.close();
}

await browser.close();

if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(` - ${p}`);
  process.exitCode = 1;
} else {
  console.log(`\nclean: every lot sits between the HUD and the boosters, at a touchable size`);
  console.log(`shots in ${OUT}`);
}
