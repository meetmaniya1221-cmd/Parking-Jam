import { getLevel, specForLevel, TOTAL_LEVELS, bandForLevel } from '../src/core/campaign';
import { analyseDifficulty } from '../src/core/solver';
import { Band } from '../src/core/types';

const byBand: Record<string, { n: number; carGap: number; depthGap: number; depth: number[]; open: number[] }> = {};
let worst: string[] = [];
const t0 = Date.now();
for (let i = 1; i <= TOTAL_LEVELS; i++) {
  const spec = specForLevel(i);
  const lv = getLevel(i);
  const m = analyseDifficulty(lv);
  const b = (byBand[lv.band] ??= { n: 0, carGap: 0, depthGap: 0, depth: [], open: [] });
  b.n++;
  b.carGap += spec.vehicleCount - lv.vehicles.length;
  b.depthGap += spec.knotDepth - m.knotDepth;
  b.depth.push(m.knotDepth);
  b.open.push(m.openExits);
  if (spec.vehicleCount - lv.vehicles.length > 2 || m.knotDepth < spec.knotDepth - 1)
    worst.push(`L${i} ${lv.band} ${lv.patternTags[0]} cars ${lv.vehicles.length}/${spec.vehicleCount} depth ${m.knotDepth}/${spec.knotDepth} open ${m.openExits}`);
}
const med = (a: number[]) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
for (const [band, b] of Object.entries(byBand))
  console.log(`${band.padEnd(9)} n=${String(b.n).padStart(3)}  avgCarShortfall=${(b.carGap/b.n).toFixed(2)}  avgDepthShortfall=${(b.depthGap/b.n).toFixed(2)}  medDepth=${med(b.depth)}  medOpen=${med(b.open)}`);
console.log(`\n${worst.length}/${TOTAL_LEVELS} off target  (${Date.now()-t0}ms to build all 320)`);
console.log(worst.slice(0, 12).join('\n'));
