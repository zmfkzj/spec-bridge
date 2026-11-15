import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScn } from '../src/constraints/scn.ts'
import { compareConstraints } from '../src/constraints/compare.ts'
import type { Constraint } from '../src/ir/types.ts'

test('SCN: structured patterns, units normalized, prose kept uninterpreted', () => {
  const r = parseScn([
    'The system SHALL assign a job to at most one worker through `Jobs.claimJob`.',
    '- `ClaimRequest.workerId` MUST be present in request.',
    '- `Job.lease` MUST be between 1 and 15 minutes.',
    '- `Job.owner` MUST be present in response when `Job.status` is `claimed`.',
    '- Each `Job` in state `claimed` MUST have exactly one `owner`.',
    '- `Jobs.claimJob` MUST respond with 409 when the job is already claimed.',
    '- `jobs.webApp` MUST NOT depend on `jobs.jobQueue`.',
    '- `Job.size` MUST be at most 10 parsecs.',
  ].join('\n'))
  const kinds = r.constraints.map(c => `${c.rule}:${c.ref}`)
  assert.deepEqual(kinds, ['SCN-REQUIRED:ClaimRequest.workerId', 'SCN-RANGE-BETWEEN:Job.lease', 'SCN-REQUIRED:Job.owner', 'SCN-CARDINALITY:Job.owner', 'SCN-ERROR-RESPONSE:Jobs.claimJob', 'SCN-NO-DEPENDENCY:jobs.webApp'])
  const range = r.constraints[1]
  assert.equal(range.min, 60); assert.equal(range.max, 900); assert.equal(range.unit, 's')
  assert.equal(r.constraints[2].state, 'claimed'); assert.equal(r.constraints[2].direction, 'response')
  assert.deepEqual([r.constraints[3].min, r.constraints[3].max], [1, 1])
  // unknown unit word -> refuses to interpret; first sentence is prose
  assert.equal(r.uninterpreted.length, 2)
  assert.ok(r.uninterpreted.some(u => u.text.includes('parsecs')))
})

const C = (p: Partial<Constraint> & { kind: Constraint['kind'] }, subject: Partial<Constraint['subject']> = {}, params: Constraint['params'] = {}): Constraint => ({
  id: Math.random().toString(36), origin: 'x', tool: 'openspec', trust: 'Derived', interpretation: 'structured', text: p.kind, source: { file: 'f' }, evidence: [],
  ...p, subject: { fieldKey: 'F', direction: 'any', ...subject }, params,
})

test('compare: required vs optional on same field/direction is a CONFLICT', () => {
  const r = compareConstraints(C({ kind: 'Required' }, { direction: 'request' }), C({ kind: 'Optional', tool: 'typespec' }, { direction: 'request' }))
  assert.equal(r?.verdict, 'CONFLICT')
})

test('compare: request vs response is not compared; stored vs response is UNKNOWN (scope differs)', () => {
  assert.equal(compareConstraints(C({ kind: 'Required' }, { direction: 'request' }), C({ kind: 'Optional', tool: 'typespec' }, { direction: 'response' })), null)
  const r = compareConstraints(C({ kind: 'Cardinality' }, { direction: 'stored' }, { min: 1, max: 1 }), C({ kind: 'Optional', tool: 'typespec' }, { direction: 'response' }))
  assert.equal(r?.verdict, 'UNKNOWN'); assert.equal(r?.category, 'SCOPE_DIFFERS')
})

test('compare: state-scoped requirement vs state-less contract is UNKNOWN, not CONFLICT', () => {
  const r = compareConstraints(C({ kind: 'Required' }, { direction: 'response', state: 'released' }), C({ kind: 'Optional', tool: 'typespec' }, { direction: 'response' }))
  assert.equal(r?.verdict, 'UNKNOWN'); assert.equal(r?.category, 'STATE_DIFFERS')
})

test('compare: uniqueness and optionality are orthogonal (not a contradiction)', () => {
  assert.equal(compareConstraints(C({ kind: 'Exclusivity' }), C({ kind: 'Optional', tool: 'typespec' })), null)
})

test('compare: ranges — disjoint / looser explicit bound conflict; silent bound unknown; unit mismatch unknown', () => {
  const A = C({ kind: 'Range' }, {}, { min: 30, max: 600, unit: 's' })
  assert.equal(compareConstraints(A, C({ kind: 'Range', tool: 'typespec' }, {}, { min: 30, max: 600, unit: 's' }))?.verdict, 'CONSISTENT')
  assert.equal(compareConstraints(A, C({ kind: 'Range', tool: 'typespec' }, {}, { min: 700, max: 800, unit: 's' }))?.verdict, 'CONFLICT')
  assert.equal(compareConstraints(A, C({ kind: 'Range', tool: 'typespec' }, {}, { min: 1, max: 600, unit: 's' }))?.category, 'CONTRACT_PERMITS_VIOLATION')
  assert.equal(compareConstraints(A, C({ kind: 'Range', tool: 'typespec' }, {}, { min: 30, max: null, unit: 's' }))?.category, 'MISSING_INFORMATION')
  assert.equal(compareConstraints(A, C({ kind: 'Range', tool: 'typespec' }, {}, { min: 30, max: 600, unit: null }))?.category, 'UNIT_UNKNOWN')
})

test('compare: Alloy multiplicity wider than requirement is delegated (UNKNOWN), disjoint is CONFLICT', () => {
  const A = C({ kind: 'Cardinality' }, { direction: 'stored' }, { min: 1, max: 1 })
  assert.equal(compareConstraints(A, C({ kind: 'Cardinality', tool: 'alloy' }, { direction: 'stored' }, { min: 0, max: 1 }))?.category, 'DELEGATED_TO_ALLOY')
  assert.equal(compareConstraints(A, C({ kind: 'Cardinality', tool: 'alloy' }, { direction: 'stored' }, { min: 2, max: null }))?.verdict, 'CONFLICT')
})

test('compare: types', () => {
  assert.equal(compareConstraints(C({ kind: 'TypeCompatibility' }, {}, { type: 'integer' }), C({ kind: 'TypeCompatibility', tool: 'typespec' }, {}, { type: 'number' }))?.verdict, 'CONFLICT')
  assert.equal(compareConstraints(C({ kind: 'TypeCompatibility' }, {}, { type: 'number' }), C({ kind: 'TypeCompatibility', tool: 'typespec' }, {}, { type: 'integer' }))?.verdict, 'CONSISTENT')
})
