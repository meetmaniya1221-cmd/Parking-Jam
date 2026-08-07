import { clearLevelCache, getLevel, TOTAL_LEVELS } from '../src/core/campaign';
clearLevelCache();
const times: number[] = [];
for (let i = 1; i <= TOTAL_LEVELS; i++) {
  const t = performance.now();
  getLevel(i);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
const q = (p: number) => times[Math.floor(times.length * p)].toFixed(1);
console.log(`generation ms: p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${times[times.length-1].toFixed(1)}`);
