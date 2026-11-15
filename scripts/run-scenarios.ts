// Executes success scenarios A–E (examples/scenarios) and stores the JSON reports as evidence.
// Usage: node scripts/run-scenarios.ts [A|B|C|D|E]
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../src/util.ts'
import { scenario } from '../test/workspace.ts'

const only = process.argv[2]
const out = join(REPO_ROOT, 'evidence/scenarios')
mkdirSync(out, { recursive: true })
const summary: any[] = []
for (const name of readdirSync(join(REPO_ROOT, 'examples/scenarios')).filter(n => /^[A-E]-/.test(n) && (!only || n.startsWith(only))).sort()) {
  const r = scenario(name)
  const rep = r.report
  writeFileSync(join(out, `${name}.json`), JSON.stringify({ scenario: name, command: ['specbridge', ...r.spec.args], exitCode: r.exitCode, wallMs: r.ms, report: rep, stderr: r.stderr.slice(0, 2000) }, null, 1))
  summary.push({
    scenario: name, title: r.spec.title, exitCode: r.exitCode, wallMs: r.ms, overall: rep?.overall,
    conflicts: rep?.analysis.findings.filter((f: any) => f.verdict === 'CONFLICT').map((f: any) => `${f.rule}: ${f.message.slice(0, 160)}`),
    impacted: rep?.impact ? rep.impact.impacted.length : null, invalidatedMappings: rep?.impact?.invalidatedMappings.map((m: any) => m.id) ?? null,
  })
  console.error(`${name}: exit ${r.exitCode} ${rep?.overall.status}/${rep?.overall.verdict} (${r.ms} ms)`)
}
writeFileSync(join(out, only ? `summary-${only}.json` : 'summary.json'), JSON.stringify(summary, null, 1))
