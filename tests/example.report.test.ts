/**
 * A worked example, printed.
 *
 * "The levels are harder now" is a claim, not evidence. This prints one
 * generated lot in full — the board, the dependency graph, where a thoughtless
 * player gets stuck, the solution it was built from, and the measurements — so
 * the claim can be checked rather than believed.
 *
 * Run: npx vitest run tests/example.report.test.ts
 * Pick a level: EXAMPLE_LEVEL=200 npx vitest run tests/example.report.test.ts
 */
import { describe, it } from 'vitest';
import { getLevel } from '../src/core/campaign';
import {
  analysePuzzle,
  dependencyGraph,
  greedyOutcome,
  hasBlockingCycle,
} from '../src/core/analysis';
import { applyMove, cloneLotState, createLotState, exitableVehicles } from '../src/core/sim';
import { Band, Dir, DX, DY, LevelDef, LotState, Move, MoveKind, Terrain } from '../src/core/types';

const NAMES = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ARROW = ['^', '>', 'v', '<'];
const BAND_NAME: Record<Band, string> = {
  [Band.Easy]: 'breather',
  [Band.Medium]: 'standard',
  [Band.Hard]: 'stretch',
  [Band.Showcase]: 'showcase',
};

/** The lot as text: each car is a letter, its nose carries the facing arrow. */
function renderBoard(level: LevelDef, s: LotState): string {
  const w = level.w;
  const h = level.h;
  const cell: string[] = new Array(w * h).fill(' .');

  for (let i = 0; i < w * h; i++) {
    if (level.terrain[i] === Terrain.Blocked) cell[i] = '##';
    else if (level.terrain[i] === Terrain.Oil) cell[i] = ' ~';
    else if (level.terrain[i] === Terrain.Roundabout) cell[i] = ' @';
    if (level.arrows[i] >= 0) cell[i] = ' ' + ARROW[level.arrows[i]].toLowerCase();
  }

  for (let vi = 0; vi < s.x.length; vi++) {
    if (s.gone[vi]) continue;
    const f = s.facing[vi] as Dir;
    for (let k = 0; k < s.len[vi]; k++) {
      const cx = s.x[vi] - DX[f] * k;
      const cy = s.y[vi] - DY[f] * k;
      cell[cy * w + cx] = (k === 0 ? ARROW[f] : NAMES[vi]) + NAMES[vi];
    }
  }

  // Curb cuts drawn as a border around the grid.
  const top: string[] = new Array(w).fill('  ');
  const bottom: string[] = new Array(w).fill('  ');
  const left: string[] = new Array(h).fill(' ');
  const right: string[] = new Array(h).fill(' ');
  for (const e of level.exits) {
    if (e.dir === 0) top[e.x] = '||';
    else if (e.dir === 2) bottom[e.x] = '||';
    else if (e.dir === 3) left[e.y] = '=';
    else right[e.y] = '=';
  }

  const lines: string[] = [];
  lines.push('   ' + top.join(''));
  for (let y = 0; y < h; y++) {
    const row: string[] = [];
    for (let x = 0; x < w; x++) row.push(cell[y * w + x]);
    lines.push(` ${left[y]} ${row.join('')} ${right[y]}`);
  }
  lines.push('   ' + bottom.join(''));
  return lines.join('\n');
}

function describeMove(s: LotState, m: Move): string {
  const who = NAMES[m.vi];
  if (m.kind === MoveKind.Exit) return `${who} EXITS ${ARROW[m.dir]}`;
  const dist = Math.abs(m.toX - s.x[m.vi]) + Math.abs(m.toY - s.y[m.vi]);
  const dir = ['up', 'right', 'down', 'left'][m.dir];
  return `${who} shifts ${dir} ${dist}  (makes room — clears nobody)`;
}

describe('worked example', () => {
  it('prints one generated lot in full', () => {
    const env = (globalThis as { process?: { env?: Record<string, string> } }).process?.env;
    const index = Number(env?.EXAMPLE_LEVEL ?? 120);
    const level = getLevel(index);
    const state = createLotState(level);
    const graph = dependencyGraph(state);
    const greedy = greedyOutcome(state);
    const metrics = analysePuzzle(level, level.solution);

    const out: string[] = [];
    const say = (line = '') => out.push(line);

    say(`================ LEVEL ${index} — ${BAND_NAME[level.band]} ================`);
    say(`${level.w}x${level.h} lot · ${level.vehicles.length} cars · pattern ${level.patternTags.join(', ')}`);
    say();
    say(renderBoard(level, state));
    say();
    say('  arrow = the nose, and the only direction that car can travel');
    say('  || and =  are curb cuts (the way out)   ## wall   ~ oil   @ turntable');
    say();

    say('---------------- DEPENDENCY GRAPH ----------------');
    say('A car only ever leaves straight along its facing, so "X is parked on');
    say('Y\'s route" is an absolute ordering: X must go before Y, always.');
    say();
    for (let vi = 0; vi < state.x.length; vi++) {
      const blockedBy = graph.blockedBy[vi].map((b) => NAMES[b]);
      const blocks = graph.blocks[vi].map((b) => NAMES[b]);
      say(
        `  ${NAMES[vi]}  waits on: ${(blockedBy.join(' ') || '—').padEnd(14)}` +
          `holds up: ${blocks.join(' ') || '—'}`,
      );
    }
    say();
    say(`  longest chain of dependencies : ${graph.depth}`);
    say(`  cars in nobody's way and free : ${graph.isolated.length} of ${state.x.length}`);
    say(`  mutual-blocking ring present  : ${hasBlockingCycle(state) ? 'YES' : 'no'}`);
    say();

    say('---------------- WHY TAPPING DOES NOT WORK ----------------');
    say('A player who ignores the puzzle and just taps whatever currently has a');
    say('clear lane is running the "greedy" strategy. Because driving a car off');
    say('only ever frees cells, greedy can never spoil its own position — so if');
    say('it can finish at all, it finishes from any order. One run decides it.');
    say();
    if (greedy.solves) {
      say(`  greedy CLEARS THE WHOLE LOT (${greedy.cleared}/${greedy.total}) — this lot is too easy.`);
    } else {
      const order = greedy.order.map((v) => NAMES[v]).join(' ');
      say(`  greedy clears ${greedy.cleared} of ${greedy.total} cars${order ? ` (${order})` : ''}, then STALLS.`);
      say('  At that point no car has a clear route, and nothing can be tapped.');
      say('  The remaining cars can only be freed by moving a car *without*');
      say('  clearing it — which is the read the puzzle is actually about.');
      const stuck = cloneLotState(state);
      for (const vi of greedy.order) {
        const f = stuck.facing[vi] as Dir;
        const p = exitableVehicles(stuck).includes(vi);
        if (!p) continue;
        applyMove(stuck, {
          kind: MoveKind.Exit,
          vi,
          dir: f,
          distance: 0,
          toX: stuck.x[vi],
          toY: stuck.y[vi],
          slidExtra: 0,
        });
      }
      say();
      say('  the position where tapping runs out:');
      say(renderBoard(level, stuck));
    }
    say();

    say('---------------- A SOLUTION ----------------');
    const solution = level.solution ?? [];
    say(`${solution.length} moves, of which ${metrics.repositionMoves} clear nobody.`);
    say('(This is the line the generator proved while building the lot. It is a');
    say('guaranteed clear, not necessarily the shortest one.)');
    say();
    const replay = cloneLotState(state);
    solution.forEach((m, i) => {
      say(`  ${String(i + 1).padStart(3)}. ${describeMove(replay, m)}`);
      applyMove(replay, m);
    });
    say();
    say(`  board cleared: ${replay.remaining === 0 ? 'YES' : 'NO — BUG'}`);
    say();

    say('---------------- MEASUREMENTS ----------------');
    say(`  cars                              ${metrics.vehicles}`);
    say(`  solution length                   ${metrics.solutionMoves}`);
    say(`  of which repositioning            ${metrics.repositionMoves}`);
    say(`  cars that must move more than once ${metrics.repositionedCars}`);
    say(`  moves before anything can leave   ${metrics.firstExitAt}`);
    say(`  can leave on move one             ${metrics.initialExits} (${(metrics.initialExitShare * 100).toFixed(0)}%)`);
    say(`  cleared by thoughtless tapping    ${metrics.greedyCleared} (${(metrics.greedyShare * 100).toFixed(0)}%)`);
    say(`  dependency depth                  ${metrics.dependencyDepth}`);
    say(`  cars in nobody's way              ${metrics.isolatedCars}`);
    say(`  contested cells (bottlenecks)     ${metrics.bottleneckCells}`);
    say(`  decision points in the solution   ${metrics.decisionPoints}`);
    say(`  mean legal moves per turn         ${metrics.branchingFactor.toFixed(1)}`);
    say('='.repeat(58));

    console.log('\n' + out.join('\n'));
  }, 600_000);
});
