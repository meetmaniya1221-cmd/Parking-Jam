/**
 * Not an assertion — a readout.
 *
 * Difficulty here is *requested* by `specForLevel` and *delivered* by JamForge,
 * and the two are not the same number: a lot can only knot as deep as its grid
 * and frontage allow. This prints what the generator actually produced, which
 * is the only honest way to tune the curve.
 *
 * Run with: npx vitest run tests/curve.report.ts
 */
import { describe, it } from 'vitest';
import { bandForLevel, getLevel, TOTAL_LEVELS } from '../src/core/campaign';
import { analyseDifficulty, bumpLikelihood } from '../src/core/solver';
import { Band } from '../src/core/types';

const BAND_NAME: Record<Band, string> = {
  [Band.Easy]: 'breather',
  [Band.Medium]: 'standard',
  [Band.Hard]: 'stretch',
  [Band.Showcase]: 'showcase',
};

describe('difficulty curve', () => {
  it('prints the delivered curve', () => {
    const rows: string[] = [];
    rows.push('  lvl  band       grid   cars  depth  mods  bump');
    const show = (i: number) => {
      const level = getLevel(i);
      const m = analyseDifficulty(level);
      rows.push(
        [
          String(i).padStart(5),
          BAND_NAME[level.band].padEnd(10),
          `${level.w}x${level.h}`.padStart(6),
          String(level.vehicles.length).padStart(5),
          String(m.knotDepth).padStart(6),
          String(level.modifierLoad).padStart(5),
          bumpLikelihood(level).toFixed(2).padStart(6),
        ].join(' '),
      );
    };
    for (let i = 1; i <= 24; i++) show(i);
    for (const i of [30, 40, 60, 80, 120, 180, 240, 320]) show(i);
    console.log('\n' + rows.join('\n'));

    // Aggregate: what the player actually meets, band by band and era by era.
    const era = (from: number, to: number) => {
      let cars = 0;
      let depth = 0;
      let bump = 0;
      for (let i = from; i <= to; i++) {
        const level = getLevel(i);
        cars += level.vehicles.length;
        depth += analyseDifficulty(level).knotDepth;
        bump += bumpLikelihood(level);
      }
      const n = to - from + 1;
      return `L${from}-${to}: ${(cars / n).toFixed(1)} cars, depth ${(depth / n).toFixed(2)}, bump ${(bump / n).toFixed(2)}`;
    };
    console.log(
      '\n' +
        [era(1, 9), era(10, 20), era(21, 40), era(41, 80), era(81, 160), era(161, 320)].join('\n'),
    );

    // Band-isolated: breathers are deliberately shallow, so an all-bands average
    // tracks how many breathers an era happens to contain more than it tracks
    // the curve. Comparing stretch to stretch is the honest read.
    const stretchEra = (from: number, to: number) => {
      const depths: number[] = [];
      let cars = 0;
      for (let i = from; i <= to; i++) {
        const level = getLevel(i);
        if (level.band !== Band.Hard) continue;
        depths.push(analyseDifficulty(level).knotDepth);
        cars += level.vehicles.length;
      }
      if (!depths.length) return `L${from}-${to}: no stretch jams`;
      const mean = depths.reduce((a, b) => a + b, 0) / depths.length;
      return `L${from}-${to}: ${depths.length} stretch jams, depth ${mean.toFixed(2)}, ${(cars / depths.length).toFixed(1)} cars`;
    };
    console.log(
      '\nstretch only:\n' +
        [
          stretchEra(10, 20),
          stretchEra(21, 80),
          stretchEra(81, 160),
          stretchEra(161, 320),
        ].join('\n'),
    );

    const counts: Record<string, number> = {};
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const b = BAND_NAME[bandForLevel(i)];
      counts[b] = (counts[b] ?? 0) + 1;
    }
    console.log(
      '\nband mix: ' +
        Object.entries(counts)
          .map(([k, v]) => `${k} ${((v / TOTAL_LEVELS) * 100).toFixed(0)}%`)
          .join('  '),
    );
  }, 600_000);
});
