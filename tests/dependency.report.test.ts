/**
 * Not an assertion — a readout, in the same spirit as `curve.report.test.ts`.
 *
 * Prints one stretch jam in full: the lot, every car's role, the dependency
 * graph, the par line, and the proof that tapping cannot clear it. This is the
 * artefact to look at when tuning the generator, because the metrics alone will
 * not tell you whether a jam is *interesting*.
 *
 * Run with: npx vitest run tests/dependency.report.test.ts
 */
import { describe, it } from 'vitest';
import { getLevel, specForLevel, TOTAL_LEVELS } from '../src/core/campaign';
import { dependencyDiagram, explainLevel, judgeLevel, renderLevel } from '../src/core/generator';
import {
  analyseDifficulty,
  cascadeExits,
  deadlockRisk,
  dependencyGraph,
  greedyClearance,
} from '../src/core/solver';
import { createLotState } from '../src/core/sim';
import { Band, LevelDef, MoveKind } from '../src/core/types';

const name = (vi: number) => String.fromCharCode(65 + (vi % 26));

function solutionLines(level: LevelDef): string[] {
  const line = level.parSolution ?? [];
  const out: string[] = [];
  const arrow = ['north', 'east', 'south', 'west'];
  let step = 0;
  for (const m of line) {
    step++;
    out.push(
      m.kind === MoveKind.Exit
        ? `${String(step).padStart(2)}. ${name(m.vi)} drives off ${arrow[m.dir]}`
        : `${String(step).padStart(2)}. ${name(m.vi)} shunts ${m.distance} ${arrow[m.dir]} — makes room, gets no closer to its own way out`,
    );
  }
  return out;
}

function report(level: LevelDef, label: string): void {
  const m = analyseDifficulty(level, level.parSolution);
  const graph = dependencyGraph(level);
  const greedy = greedyClearance(level);

  const stalled = createLotState(level);
  cascadeExits(stalled);
  const stuck: string[] = [];
  for (let vi = 0; vi < stalled.x.length; vi++) if (!stalled.gone[vi]) stuck.push(name(vi));

  console.log(`\n${'='.repeat(72)}\n${label}\n${'='.repeat(72)}\n`);
  console.log(renderLevel(level));
  console.log('\n' + explainLevel(level));

  console.log('\n--- dependency graph (mermaid; <==> marks a loop) ---\n');
  console.log(dependencyDiagram(level));

  console.log('\n--- par line ---\n');
  console.log(solutionLines(level).join('\n'));

  console.log('\n--- why tapping does not clear it ---\n');
  console.log(
    `Tapping every car that can drive off, over and over, removes ${greedy.cleared} of ` +
      `${greedy.total} and then runs out of moves. Still standing: ${stuck.join(', ')}.\n` +
      `Those cars are in a loop — each one is parked across the next one's lane — so no ` +
      `order of exits reaches them. Someone has to be shunted sideways first.`,
  );

  console.log('\n--- metrics ---\n');
  console.log(
    [
      `cars                 ${m.vehicleCount}`,
      `par                  ${m.parSlides} moves (${m.repositionMoves} of them repositions)`,
      `dependency depth     ${m.knotDepth}`,
      `free on move one     ${m.openExits} (${(m.openShare * 100).toFixed(0)}%)`,
      `greedy stall         ${m.greedyStall} cars (${(m.greedyStallShare * 100).toFixed(0)}%) — tapping alone leaves these`,
      `independent cars     ${m.independentCars}`,
      `participation        ${(m.participation * 100).toFixed(0)}% of cars blocked, blocking, or both`,
      `bottleneck cells     ${m.bottleneckCells} (mean ${m.bottleneckPressure.toFixed(1)} cars per contested cell)`,
      `decision points      ${m.decisionPoints}`,
      `branching factor     ${m.branchingFactor.toFixed(1)} options per step`,
      `forced steps         ${m.forcedSteps}`,
      `deadlock risk        ${(deadlockRisk(level) * 100).toFixed(0)}% of opening slides strand the lot`,
      `graph edges          ${graph.edges.length}`,
      `gate verdict         ${judgeLevel(level, specForLevel(level.index)).failed.join(', ') || 'clears every target'}`,
    ].join('\n'),
  );
}

describe('dependency report', () => {
  it('shows a stretch jam in full', () => {
    // The first showcase past the hand-over, and a plain stretch jam for contrast.
    report(getLevel(20), 'JAM 20 — showcase, the first chapter finale');
    report(getLevel(103), 'JAM 103 — a mid-campaign stretch jam');
  }, 300_000);

  it('summarises what the campaign now asks of the player', () => {
    const rows: string[] = [];
    rows.push('  lvl  band       cars  depth  par  slides  open  stall  neck');
    const show = (i: number) => {
      const level = getLevel(i);
      const m = analyseDifficulty(level, level.parSolution);
      rows.push(
        [
          String(i).padStart(5),
          level.band.padEnd(10),
          String(m.vehicleCount).padStart(5),
          String(m.knotDepth).padStart(6),
          String(m.parSlides).padStart(4),
          String(m.repositionMoves).padStart(7),
          String(m.openExits).padStart(5),
          `${(m.greedyStallShare * 100).toFixed(0)}%`.padStart(6),
          String(m.bottleneckCells).padStart(5),
        ].join(' '),
      );
    };
    for (let i = 1; i <= 22; i++) show(i);
    for (const i of [40, 60, 100, 160, 220, 280, 320]) show(i);
    console.log('\n' + rows.join('\n'));

    const bands: Record<string, number[][]> = {};
    for (let i = 5; i <= TOTAL_LEVELS; i++) {
      const level = getLevel(i);
      const m = analyseDifficulty(level, level.parSolution);
      (bands[level.band] ??= []).push([
        m.vehicleCount,
        m.knotDepth,
        m.parSlides,
        m.repositionMoves,
        m.greedyStallShare,
      ]);
    }
    const col = (rowsIn: number[][], j: number) =>
      rowsIn.reduce((a, r) => a + r[j], 0) / rowsIn.length;
    console.log('\nby band (levels 5+):');
    for (const band of [Band.Easy, Band.Medium, Band.Hard, Band.Showcase]) {
      const r = bands[band];
      console.log(
        `  ${band.padEnd(9)} ${r.length} jams · ${col(r, 0).toFixed(1)} cars · ` +
          `depth ${col(r, 1).toFixed(1)} · par ${col(r, 2).toFixed(1)} · ` +
          `${col(r, 3).toFixed(1)} repositions · ${(col(r, 4) * 100).toFixed(0)}% held back from tapping`,
      );
    }
  }, 300_000);
});
