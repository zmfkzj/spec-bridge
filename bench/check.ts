// Regression gate for CI: configuration C must keep 0 FP, 0 FN, 0 false PASS and full reproducibility
// on the benchmark (agent-authored ground truth; see bench/README.md for what this does and does not prove).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../src/util.ts'
const { summary } = JSON.parse(readFileSync(join(REPO_ROOT, 'bench/results/latest.json'), 'utf8'))
const c = summary.configurations.C
const problems = [
  c.fp !== 0 && `C false positives: ${c.fp}`, c.fn !== 0 && `C false negatives: ${c.fn}`, c.falsePass !== 0 && `C false PASS: ${c.falsePass}`,
  summary.reproducibility.casesIdenticalAcrossTwoRuns !== summary.reproducibility.cases && 'C not reproducible on every case',
].filter(Boolean)
if (problems.length) { console.error('benchmark regression:\n  ' + problems.join('\n  ')); process.exit(1) }
console.log(`benchmark gate ok: C precision ${c.precision}, recall ${c.recall}, false PASS ${c.falsePass}`)
