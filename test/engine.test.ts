import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeImpact, diffIR } from '../src/analysis/impact.ts'
import { buildReport } from '../src/report/report.ts'
import { computeCoverage } from '../src/analysis/coverage.ts'
import { loadConfig } from '../src/config.ts'
import type { Entity, Relation, SemanticIR } from '../src/ir/types.ts'
import { alloyExec, alloyParse } from '../src/adapters/alloy.ts'
import { WORK } from './workspace.ts'
import { finding } from '../src/analysis/findings.ts'

const ent = (id: string, type: Entity['type'], fp = 'f', attrs: Record<string, unknown> = {}): Entity => ({ id, type, name: id, tool: id.split(':')[0] as any, source: { file: 'x' }, version: { tool: 'specbridge', toolVersion: '0' }, extraction: { method: 'derived-rule', adapter: 't' }, validation: { status: 'unvalidated' }, trust: 'Explicit', fingerprint: fp, attrs, evidence: [] })
const rel = (type: Relation['type'], from: string, to: string, trust: Relation['trust'] = 'Explicit'): Relation => ({ id: `${type}:${from}->${to}`, type, from, to, trust, rule: 't', evidence: [] })
const ir = (entities: Entity[], relations: Relation[]): SemanticIR => ({ schemaVersion: '1', workspace: '.', git: { revision: null, dirty: false }, sources: [], entities, relations, constraints: [], mappings: [], references: [], diagnostics: [] })
const config = { ...loadConfig(WORK), policies: { formalVerificationRequired: [], singleProvider: true, impactMaxDepth: 4, impactMaxNodes: 500 } }

test('impact: typed propagation op -> provider/consumer/requirement/invariant with paths; proposals not propagated', () => {
  const g = ir(
    [ent('typespec:op:A.x', 'Operation'), ent('likec4:svc', 'Component'), ent('likec4:client', 'Component'), ent('openspec:r/one', 'Requirement'), ent('alloy:m#assert:I', 'Invariant'), ent('alloy:m#cmd:I', 'Command'), ent('typespec:op:A.y', 'Operation'), ent('likec4:other', 'Component')],
    [rel('EXPOSES', 'likec4:svc', 'typespec:op:A.x'), rel('EXPOSES', 'likec4:svc', 'typespec:op:A.y'), rel('CONSUMES', 'likec4:client', 'typespec:op:A.x'), rel('REQUIRES', 'openspec:r/one', 'typespec:op:A.x'),
      rel('VERIFIES', 'alloy:m#assert:I', 'openspec:r/one'), rel('VERIFIES', 'alloy:m#cmd:I', 'alloy:m#assert:I'), rel('DEPENDS_ON', 'likec4:other', 'likec4:svc'), rel('SATISFIES', 'typespec:op:A.x', 'openspec:r/one', 'Proposed')],
  )
  const r = analyzeImpact({ current: g, seeds: [{ entity: 'typespec:op:A.x', change: 'MODIFIED', source: 'explicit', detail: '' }], config })
  const by = new Map(r.impacted.map(i => [i.entity, i]))
  assert.equal(by.get('likec4:svc')?.kind, 'direct')
  assert.equal(by.get('likec4:client')?.kind, 'direct')
  assert.equal(by.get('openspec:r/one')?.kind, 'direct')
  assert.ok(!by.has('typespec:op:A.y'), 'no sibling expansion through the provider')
  assert.ok(!by.has('likec4:other'), 'provider reached as implementer does not propagate to its dependents')
  assert.ok(!by.has('alloy:m#assert:I'), 'requirement reached as re-check target is terminal')
  assert.equal(r.possiblyImpactedUnverified.length, 1, 'proposed relation reported separately, not propagated')
  assert.ok(by.get('openspec:r/one')!.path.length === 1 && by.get('openspec:r/one')!.path[0].relation === 'REQUIRES')
})

test('impact: requirement change reaches verifying assertions and their commands', () => {
  const g = ir([ent('openspec:r/one', 'Requirement'), ent('alloy:m#assert:I', 'Invariant'), ent('alloy:m#cmd:I', 'Command')], [rel('VERIFIES', 'alloy:m#assert:I', 'openspec:r/one'), rel('VERIFIES', 'alloy:m#cmd:I', 'alloy:m#assert:I')])
  const r = analyzeImpact({ current: g, seeds: [{ entity: 'openspec:r/one', change: 'MODIFIED', source: 'explicit', detail: '' }], config })
  assert.deepEqual(r.revalidation.alloyCommands, ['alloy:m#cmd:I'])
  assert.equal(r.impacted.find(i => i.entity === 'alloy:m#cmd:I')?.kind, 'indirect')
})

test('impact: deletions are traced on the baseline graph; unlinked seeds produce UNKNOWN warnings, not "no impact"', () => {
  const base = ir([ent('likec4:a', 'Component'), ent('typespec:op:A.x', 'Operation'), ent('likec4:c', 'Component')], [rel('EXPOSES', 'likec4:a', 'typespec:op:A.x'), rel('CONSUMES', 'likec4:c', 'typespec:op:A.x')])
  const cur = ir([ent('likec4:c', 'Component'), ent('likec4:a', 'Component'), ent('likec4:lonely', 'Component')], [])
  const seeds = diffIR(base, cur)
  assert.ok(seeds.some(s => s.entity === 'typespec:op:A.x' && s.change === 'REMOVED'))
  const r = analyzeImpact({ current: cur, baseline: base, seeds: [...seeds, { entity: 'likec4:lonely', change: 'MODIFIED', source: 'explicit', detail: '' }], config })
  const c = r.impacted.find(i => i.entity === 'likec4:c')
  assert.equal(c?.graph, 'baseline')
  assert.ok(r.warnings.some(w => w.includes('likec4:lonely') && w.includes('UNKNOWN')))
})

test('impact: rename detection, cycles terminate, depth truncation is reported', () => {
  const base = ir([ent('openspec:s/old', 'Requirement', 'f1', { text: 'same' })], [])
  const cur = ir([ent('openspec:s/new', 'Requirement', 'f2', { text: 'same' })], [])
  assert.deepEqual(diffIR(base, cur).map(s => [s.change, s.renamedTo]), [['RENAMED', 'openspec:s/new']])
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map(x => `alloy:m#sig:${x}`)
  const chain = ir(ids.map(i => ent(i, 'DataType')), [...ids.slice(1).map((x, i) => rel('EXTENDS', x, ids[i])), rel('EXTENDS', ids[0], ids[5])])
  const r = analyzeImpact({ current: chain, seeds: [{ entity: ids[0], change: 'MODIFIED', source: 'explicit', detail: '' }], config: { ...config, policies: { ...config.policies, impactMaxDepth: 2 } } })
  assert.ok(r.impacted.length <= 5)
  assert.equal(r.complete, false)
  assert.ok(r.warnings.some(w => w.includes('max depth')))
})

test('formal: check SAT = counterexample, run SAT = instance (not a violation), scopes reported', () => {
  const dir = join(WORK, 'unit/formal')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, 'm.als')
  writeFileSync(f, 'sig A { r: set A }\nassert NoSelf { no a: A | a in a.r }\ncheck NoSelf for 2\nrun {} for exactly 1 A\nassert Trivial { all a: A | a = a }\ncheck Trivial for 3 but exactly 2 A\n')
  const p = alloyParse(f)
  assert.equal(p.commands.length, 3)
  assert.deepEqual(p.commands[2].scopes, [{ sig: 'A', exact: true, start: 2, end: 2 }])
  const d = alloyExec(f)
  const [ce, inst, ok] = d.results
  assert.ok(ce.command.check && ce.satisfiable, 'counterexample for NoSelf')
  assert.ok(!inst.command.check && inst.satisfiable, 'run produced an instance')
  assert.ok(ok.command.check && !ok.satisfiable, 'no counterexample for Trivial within scope')
  assert.ok(ce.states[0].fields['A.r'].length > 0)
})

test('report: SKIP/ERROR never yield a clean PASS; empty coverage denominators are null', () => {
  const g = ir([], [])
  const consistent = finding({ rule: 'X', family: 'cross-spec', verdict: 'CONSISTENT', category: 'ALIGNED', message: '', subjects: ['a'], tools: ['openspec', 'typespec'], evidence: [], reproduce: '' })
  const ok = buildReport({ command: 't', mode: 'verification', ir: g, findings: [consistent], checks: [], formal: null, api: null, impact: null, coverage: null, change: null, baseline: null })
  assert.deepEqual([ok.overall.status, ok.overall.verdict, ok.overall.exitCode], ['PASS', 'CONSISTENT', 0])
  const skipped = buildReport({ command: 't', mode: 'verification', ir: g, findings: [consistent], checks: [{ id: 'alloy', kind: 'formal', tool: 'alloy', status: 'SKIP', verdict: 'UNKNOWN', detail: '' }], formal: null, api: null, impact: null, coverage: null, change: null, baseline: null })
  assert.deepEqual([skipped.overall.status, skipped.overall.verdict, skipped.overall.exitCode], ['SKIP', 'UNKNOWN', 3])
  const err = buildReport({ command: 't', mode: 'verification', ir: { ...g, sources: [{ tool: 'likec4', toolVersion: '1', root: '', files: [], status: 'ERROR', diagnostics: [], lossy: [], interface: '' }] }, findings: [consistent], checks: [], formal: null, api: null, impact: null, coverage: null, change: null, baseline: null })
  assert.equal(err.overall.status, 'ERROR'); assert.notEqual(err.overall.verdict, 'CONSISTENT'); assert.equal(err.overall.exitCode, 2)
  const cov = computeCoverage(g, config, null)
  for (const m of Object.values(cov)) { assert.equal(m.ratio, null); assert.equal(m.total, 0) }
})
