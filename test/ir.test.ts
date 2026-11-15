import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { buildIR, saveIR } from '../src/ir/build.ts'
import { ENTITY_TYPES } from '../src/ir/types.ts'
import { REPO_ROOT, stableStringify } from '../src/util.ts'
import { prepareWorkspace, runCli } from './workspace.ts'
import { proposeLinks } from '../src/link/proposals.ts'
import { analyzeConsistency } from '../src/analysis/consistency.ts'

const JOBS = join(REPO_ROOT, 'examples/jobs-platform')

test('IR: every entity carries id, type, tool, source location, version/revision, extraction, validation, trust, evidence', async () => {
  const { ir } = await buildIR(JOBS)
  assert.ok(ir.sources.every(s => s.status === 'OK'), JSON.stringify(ir.sources.map(s => [s.tool, s.status, s.diagnostics])))
  const types = new Set(ir.entities.map(e => e.type))
  for (const t of ['Requirement', 'Scenario', 'Component', 'Interface', 'Operation', 'DataType', 'Constraint', 'State', 'Transition', 'Invariant']) assert.ok(types.has(t as any), `has ${t}`)
  for (const e of ir.entities) {
    assert.ok(ENTITY_TYPES.includes(e.type))
    assert.ok(e.id && e.tool && e.source.file && e.version.toolVersion && 'gitRevision' in e.version, e.id)
    assert.ok(e.extraction.method && e.validation.status && e.trust && e.evidence.length && e.fingerprint, e.id)
  }
  // tool-reported positions for LikeC4/TypeSpec/Alloy; OpenSpec lines come from the SpecBridge locator
  const op = ir.entities.find(e => e.id === 'typespec:op:JobApi.Jobs.claimJob')!
  assert.equal(op.source.locatedBy, 'tool'); assert.equal(op.source.file, 'api/main.tsp')
  const req = ir.entities.find(e => e.id === 'openspec:job-claim/exclusive-job-claim')!
  assert.equal(req.source.locatedBy, 'source-locator'); assert.equal(req.source.line, 7)
  for (const r of ir.relations) assert.ok(r.evidence.length > 0 && r.rule, `relation ${r.id} has evidence`)
  assert.ok(ir.relations.every(r => r.trust === 'Explicit' || r.trust === 'Derived' || r.trust === 'Rejected'), 'no Proposed relation in the IR')
})

test('IR is regenerable: deleting .specbridge and rebuilding yields an identical IR', async () => {
  const ws = prepareWorkspace('unit/regen', JOBS, null, { git: false })
  const a = await buildIR(ws); saveIR(ws, a.ir)
  const first = readFileSync(join(ws, '.specbridge/ir.json'), 'utf8')
  rmSync(join(ws, '.specbridge'), { recursive: true, force: true })
  const b = await buildIR(ws); saveIR(ws, b.ir)
  assert.equal(readFileSync(join(ws, '.specbridge/ir.json'), 'utf8'), first)
})

test('Phase 0 trace: requirement -> component -> operation -> assertion is reproducible from the IR', async () => {
  const { ir } = await buildIR(join(REPO_ROOT, 'examples/phase0'))
  const has = (t: string, f: string, to: string) => ir.relations.some(r => r.type === t && r.from === f && r.to === to)
  assert.ok(has('REQUIRES', 'openspec:job-claim/exclusive-job-claim', 'typespec:op:JobApi.Jobs.claimJob'))
  assert.ok(has('EXPOSES', 'likec4:jobs.jobService', 'typespec:op:JobApi.Jobs.claimJob'))
  assert.ok(has('SATISFIES', 'likec4:jobs.jobService', 'openspec:job-claim/exclusive-job-claim'))
  assert.ok(has('VERIFIES', 'alloy:formal/jobs.als#assert:NoDoubleAssignment', 'openspec:job-claim/exclusive-job-claim'))
})

test('Proposals never become facts; rejected mappings are kept as Rejected and excluded', async () => {
  const ws = prepareWorkspace('unit/proposals', JOBS, null, { git: false })
  const { ir, config } = await buildIR(ws)
  const props = proposeLinks(ir, [])
  assert.ok(props.length > 0 && props.every(p => p.trust === 'Proposed'))
  const before = stableStringify(analyzeConsistency({ ir, config, formal: null }).map(f => [f.id, f.verdict]))
  // reject one proposal via the CLI and check it is stored as Rejected and does not alter facts
  const p = props.find(p => p.type === 'CORRESPONDS_TO')!
  mkdirSync(join(ws, '.specbridge'), { recursive: true })
  writeFileSync(join(ws, '.specbridge/proposals.json'), JSON.stringify({ proposals: [p], ai: { provider: null, calls: 0, tokens: null, errors: [] }, generatedAt: '' }))
  const r = runCli(ws, ['mapping', 'reject', p.id, '--by', 'unit-test'])
  assert.equal(r.exitCode, 0)
  const after = await buildIR(ws)
  const rel = after.ir.relations.find(x => x.from === p.from && x.to === p.to)
  assert.equal(rel?.trust, 'Rejected')
  assert.equal(stableStringify(analyzeConsistency({ ir: after.ir, config: after.config, formal: null }).map(f => [f.id, f.verdict])), before)
  assert.ok(!proposeLinks(after.ir, (await import('../src/link/mappings.ts')).loadMappings(join(ws, 'specbridge/mappings.yaml')).data.mappings).some(x => x.id === p.id), 'rejected candidate is not proposed again')
  // approvals require a named reviewer
  assert.equal(runCli(ws, ['mapping', 'approve', '--type', 'VERIFIES', '--from', 'a', '--to', 'b']).exitCode, 64)
})

test('Mapping revalidation: changed endpoint -> STALE, renamed requirement -> INVALIDATED with suggestion (never auto-applied)', async () => {
  const ws = prepareWorkspace('unit/mappings', JOBS, null, { git: false })
  const spec = join(ws, 'openspec/specs/job-claim/spec.md')
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('assign a job to at most one worker at a time', 'assign a job to at most one worker at any time'))
  let { ir } = await buildIR(ws)
  const stale = ir.mappings.filter(m => m.to === 'openspec:job-claim/exclusive-job-claim')
  assert.ok(stale.length === 2 && stale.every(m => m.validity === 'STALE'))
  assert.ok(ir.relations.filter(r => r.mappingId && r.stale).length === 2)
  // stale VERIFIES relations no longer count as facts for verification
  assert.ok(analyzeConsistency({ ir, config: (await buildIR(ws)).config, formal: null }).some(f => f.rule === 'RI-NOT-LINKED' && f.subjects[0] === 'openspec:job-claim/exclusive-job-claim'))
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('### Requirement: Exclusive job claim', '### Requirement: Single owner claim'))
  ;({ ir } = await buildIR(ws))
  const inv = ir.mappings.filter(m => m.to === 'openspec:job-claim/exclusive-job-claim')
  assert.ok(inv.every(m => m.validity === 'INVALIDATED'))
  const yaml = readFileSync(join(ws, 'specbridge/mappings.yaml'), 'utf8')
  assert.ok(yaml.includes('openspec:job-claim/exclusive-job-claim'), 'mapping file is not rewritten automatically')
})

test('Same name in different tools is not unified without an approved mapping', async () => {
  const ws = prepareWorkspace('unit/samename', JOBS, null, { git: false })
  writeFileSync(join(ws, 'specbridge/mappings.yaml'), readFileSync(join(ws, 'specbridge/mappings.yaml'), 'utf8').replace(/  - id: map-corresponds_to[\s\S]*?(?=  - id:)/, ''))
  const { ir } = await buildIR(ws)
  const alloyOwner = ir.constraints.find(c => c.id.includes('alloy:formal/jobs.als#field:Job.owner#ALLOY-MULT'))!
  assert.ok(alloyOwner.subject.fieldKey!.startsWith('alloy:'), 'Alloy Job.owner keeps a tool-local identity')
  assert.ok(!existsSync(join(ws, 'nothing')))
})
