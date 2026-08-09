/**
 * Not an assertion — a readout.
 *
 * Difficulty is *requested* by the spec and *delivered* by the generator, and
 * the two are never the same number: a lot can only knot as deep, and be
 * scrambled as hard, as its geometry allows. This prints what actually came
 * out, which is the only honest way to tune.
 *
 * The column that matters most is `greedy`: the share of the lot a player can
 * clear by tapping whatever currently has a clear lane, with no thought at all.
 * Under the old generator that number was 1.00 on all 320 levels.
 */
import { describe, it } from 'vitest';
import { bandForLevel, getLevel, TOTAL_LEVELS } from '../src/core/campaign';
import { analysePuzzle } from '../src/core/analysis';
import { solveLevel } from '../src/core/solver';
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
    rows.push('  lvl  band       grid   cars  moves  repos  depth  greedy  open  necks');
    const show = (i: number) => {
      const level = getLevel(i);
      const m = analysePuzzle(level, solveReference(i));
      rows.push(
        [
          String(i).padStart(5),
          BAND_NAME[level.band].padEnd(10),
          `${level.w}x${level.h}`.padStart(6),
          String(m.vehicles).padStart(5),
          String(m.solutionMoves).padStart(6),
          String(m.repositionMoves).padStart(6),
          String(m.dependencyDepth).padStart(6),
          m.greedyShare.toFixed(2).padStart(7),
          m.initialExitShare.toFixed(2).padStart(5),
          String(m.bottleneckCells).padStart(6),
        ].join(' '),
      );
    };
    for (let i = 1; i <= 24; i++) show(i);
    for (const i of [30, 40, 60, 80, 120, 180, 240, 320]) show(i);
    console.log('\n' + rows.join('\n'));

    const era = (from: number, to: number) => {
      let cars = 0;
      let depth = 0;
      let greedy = 0;
      let repos = 0;
      let moves = 0;
      let unbeaten = 0;
      for (let i = from; i <= to; i++) {
        const level = getLevel(i);
        const m = analysePuzzle(level, level.solution);
        cars += m.vehicles;
        depth += m.dependencyDepth;
        greedy += m.greedyShare;
        repos += m.repositionMoves;
        moves += m.solutionMoves;
        if (!m.greedySolves) unbeaten++;
      }
      const n = to - from + 1;
      return `L${from}-${to}: ${(cars / n).toFixed(1)} cars, ${(moves / n).toFixed(1)} moves (${(repos / n).toFixed(1)} repositioning), depth ${(depth / n).toFixed(2)}, greedy clears ${(greedy / n).toFixed(2)}, greedy-proof ${unbeaten}/${n}`;
    };
    console.log(
      '\n' +
        [era(1, 9), era(10, 20), era(21, 40), era(41, 80), era(81, 160), era(161, 320)].join('\n'),
    );

    let greedyProof = 0;
    let totalRepos = 0;
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const level = getLevel(i);
      const m = analysePuzzle(level, level.solution);
      if (!m.greedySolves) greedyProof++;
      totalRepos += m.repositionMoves;
    }
    console.log(
      `\ngreedy-proof levels: ${greedyProof}/${TOTAL_LEVELS}  ·  mean repositioning moves ${(totalRepos / TOTAL_LEVELS).toFixed(2)}`,
    );

    const counts: Record<string, number> = {};
    for (let i = 1; i <= TOTAL_LEVELS; i++) {
      const b = BAND_NAME[bandForLevel(i)];
      counts[b] = (counts[b] ?? 0) + 1;
    }
    console.log(
      'band mix: ' +
        Object.entries(counts)
          .map(([k, v]) => `${k} ${((v / TOTAL_LEVELS) * 100).toFixed(0)}%`)
          .join('  '),
    );
  }, 900_000);
});

/** The construction solution when the level carries one, else the solver's. */
function solveReference(i: number) {
  const level = getLevel(i);
  if (level.solution && level.solution.length) return level.solution;
  const res = solveLevel(level, { maxNodes: 200_000 });
  return res.solvable ? res.moves : undefined;
}
