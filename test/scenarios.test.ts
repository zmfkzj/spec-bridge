// Success scenarios A–E (spec section 19), executed through the real CLI on copies of
// examples/jobs-platform (baseline committed in a scratch git repo under .work/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scenario } from './workspace.ts'

const conflicts = (r: any) => r.analysis.findings.filter((f: any) => f.verdict === 'CONFLICT')
const has = (r: any, rule: string, pred: (f: any) => boolean = () => true) => conflicts(r).some((f: any) => f.rule === rule && pred(f))

test('Scenario A: requirement change identifies components, API, invariants and invalidated verification', () => {
  const { report: r, exitCode } = scenario('A-requirement-change')
  assert.ok(r, 'report produced')
  assert.equal(exitCode, 1)
  const ids = new Set(r.impact.impacted.map((i: any) => i.entity))
  for (const id of ['likec4:jobs.jobService', 'typespec:op:JobApi.Jobs.claimJob', 'alloy:formal/jobs.als#assert:NoDoubleAssignment', 'alloy:formal/jobs.als#assert:ClaimedHasOwner']) assert.ok(ids.has(id), `impact includes ${id}`)
  assert.ok(r.impact.seeds.some((s: any) => s.change === 'MODIFIED' && s.entity === 'openspec:job-claim/exclusive-job-claim' && s.source === 'openspec-change'))
  assert.ok(r.impact.seeds.some((s: any) => s.change === 'ADDED' && s.entity === 'openspec:job-claim/lease-expiry-visibility'))
  assert.deepEqual(r.impact.invalidatedMappings.map((m: any) => m.validity).sort(), ['STALE', 'STALE'], 'VERIFIES mappings of the modified requirement need re-review')
  assert.ok(has(r, 'RC-REQUIRED-OPTIONAL', f => f.subjects.includes('typespec:field:JobApi.ClaimRequest.leaseSeconds')))
  assert.ok(has(r, 'RC-FIELD-MISSING', f => f.message.includes('leaseExpiresAt')))
  assert.ok(r.analysis.introducedByChange.length >= 2, 'conflicts introduced by the change are separated')
  assert.ok(r.impact.revalidation.alloyCommands.includes('alloy:formal/jobs.als#cmd:NoDoubleAssignment'))
})

test('Scenario B: API change -> oasdiff compatibility + architecture/requirement trace + explicit constraint conflicts', () => {
  const { report: r } = scenario('B-api-change')
  const api = r.verification.apiCompatibility
  assert.equal(api.status, 'EXECUTED')
  const br = conflicts(r).find((f: any) => f.rule === 'API-BREAKING-CHANGE')
  assert.ok(br, 'breaking change reported')
  assert.ok(br.subjects.includes('typespec:op:JobApi.Jobs.submitJob'))
  assert.ok(br.details.consumers.includes('likec4:jobs.webApp'))
  assert.ok(br.details.requirements.includes('openspec:job-submission/job-submission'))
  assert.ok(has(r, 'RC-ERROR-RESPONSE', f => f.message.includes('409')), 'removed 409 violates the requirement')
  assert.ok(has(r, 'RC-REQUIRED-OPTIONAL', f => f.subjects.includes('typespec:field:JobApi.ClaimRequest.workerId')), 'non-breaking for oasdiff, but contradicts the requirement')
  const ids = new Set(r.impact.impacted.map((i: any) => i.entity))
  assert.ok(ids.has('likec4:worker') && ids.has('likec4:jobs.jobService') && ids.has('openspec:job-claim/exclusive-job-claim'))
})

test('Scenario C: architecture change -> affected API/requirements + architecture invariant violation', () => {
  const { report: r } = scenario('C-architecture-change')
  assert.ok(has(r, 'XS-FORBIDDEN-DEPENDENCY'))
  const ce = conflicts(r).filter((f: any) => f.rule === 'AI-PROJECTION-COUNTEREXAMPLE')
  assert.ok(ce.some((f: any) => f.message.includes('QueueIsolation') && f.message.includes('likec4:jobs.webApp -> likec4:jobs.jobQueue')))
  assert.ok(ce.some((f: any) => f.message.includes('NoCycles')))
  assert.ok(has(r, 'AA-PROVIDER-CONFLICT') && has(r, 'XS-OWNERSHIP'))
  const ids = new Set(r.impact.impacted.map((i: any) => i.entity))
  assert.ok(ids.has('typespec:op:JobApi.Jobs.claimJob') && ids.has('openspec:platform-architecture/queue-isolation'))
})

test('Scenario D: Alloy counterexample linked to design elements and requirement with scope', () => {
  const { report: r } = scenario('D-logical-error')
  const f = conflicts(r).find((f: any) => f.rule === 'RI-COUNTEREXAMPLE' && f.subjects.includes('alloy:formal/jobs.als#assert:NoDoubleAssignment'))
  assert.ok(f)
  assert.ok(f.subjects.includes('openspec:job-claim/exclusive-job-claim'))
  assert.ok(f.details.counterexample.atoms.some((a: any) => a.entity === 'typespec:type:JobApi.Job'), 'Job atoms mapped to the contract through the approved CORRESPONDS_TO mapping')
  assert.ok(f.details.scope.length >= 0 && f.reproduce.includes('SpecBridgeAlloy exec'))
  const check = r.verification.checks.find((c: any) => c.id === 'alloy:formal/jobs.als#cmd:NoDoubleAssignment')
  assert.equal(check.status, 'FAIL'); assert.equal(check.verdict, 'CONFLICT')
  const run = r.verification.checks.find((c: any) => c.id === 'alloy:formal/jobs.als#cmd:claim')
  assert.equal(run.verdict, 'NOT_APPLICABLE', 'run SAT is an instance, not a violation')
})

test('Scenario E: requirement/contract contradiction identified as structured constraint violation with locations', () => {
  const { report: r } = scenario('E-spec-contradiction')
  const req = conflicts(r).find((f: any) => f.rule === 'RC-REQUIRED-OPTIONAL')
  assert.ok(req)
  const locs = req.evidence.map((e: any) => `${e.location.file}:${e.location.line}`)
  assert.ok(locs.some((l: string) => l.startsWith('openspec/specs/job-claim/spec.md:')) && locs.some((l: string) => l.startsWith('api/main.tsp:')))
  assert.ok(req.constraints.length === 2 && req.evidence.some((e: any) => e.rule === 'SCN-REQUIRED'))
  const range = conflicts(r).find((f: any) => f.rule === 'RC-RANGE-RANGE')
  assert.equal(range.category, 'CONTRACT_PERMITS_VIOLATION')
  assert.equal(r.mode, 'analysis', 'analyze does not execute verification')
  assert.ok(!r.verification.executed)
})
