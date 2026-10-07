// Precomputes every gem expectation kernel result the website can ask for, so a first
// valuation does not have to run the solver worker on the server.
//
//   node scripts/build-gem-expectation-table.mjs
//
// The key space is small and fixed by the model: 의지력 효율 1~5 × 코어 포인트 1~5 ×
// two effect levels 1~5 (order-free) = 375 targets, times two starting grades. The table
// carries the model version; the solver ignores it when the version differs.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { solveGemExpectationKernel, GEM_EXPECTATION_MODEL } from '../src/arkgrid-gem-expectation.js';
import { GEM_PROCESSING_STARTS } from '../src/data/arkgrid-gem-processing.js';

const GRADES = ['희귀', '영웅'];
const FIELDS = ['successProbability', 'processingGoldUnits', 'processingCount', 'rerollCount', 'failedProbability', 'visitedStates'];
const entries = {};
const started = performance.now();
let count = 0;
for (const grade of GRADES) {
  const start = GEM_PROCESSING_STARTS[grade];
  for (let efficiency = 1; efficiency <= 5; efficiency++) {
    for (let core = 1; core <= 5; core++) {
      for (let low = 1; low <= 5; low++) {
        for (let high = low; high <= 5; high++) {
          const target = [efficiency, core, low, high];
          const result = solveGemExpectationKernel({ target, attempts: start.attempts, rerolls: start.rerolls, effectLevelRule: 'preserve' });
          entries[`${grade}|${target.join(',')}`] = Object.fromEntries(FIELDS.map((key) => [key, result[key]]));
          count++;
        }
      }
    }
  }
}
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'gem-expectation-table.json');
writeFileSync(output, JSON.stringify({ model: GEM_EXPECTATION_MODEL, entries }, null, 1) + '\n');
console.log(`${count} entries for ${GEM_EXPECTATION_MODEL} in ${Math.round((performance.now() - started) / 1000)}s → ${output}`);
