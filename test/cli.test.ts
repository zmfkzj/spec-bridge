import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import Ajv2020 from 'ajv/dist/2020.js'
import { REPO_ROOT } from '../src/util.ts'
import { prepareWorkspace, runCli } from './workspace.ts'

const ajv = new (Ajv2020 as any)({ allErrors: true, strict: false })
const compiled = new Map<string, any>()
const schema = (n: string) => compiled.get(n) ?? compiled.set(n, ajv.compile(JSON.parse(readFileSync(join(REPO_ROOT, 'schemas', n), 'utf8')))).get(n)
const check = (validate: any, data: unknown) => { const ok = validate(data); assert.ok(ok, JSON.stringify(validate.errors?.slice(0, 5), null, 1)) }

test('CLI: build/analyze/verify on phase0 produce schema-valid IR and reports with documented exit codes', () => {
  const ws = prepareWorkspace('unit/cli', join(REPO_ROOT, 'examples/phase0'), null)
  const b = runCli(ws, ['build'])
  assert.equal(b.exitCode, 0)
  check(schema('ir.schema.json'), JSON.parse(readFileSync(join(ws, '.specbridge/ir.json'), 'utf8')))
  const a = runCli(ws, ['analyze', 'consistency'])
  check(schema('report.schema.json'), a.report)
  assert.equal(a.exitCode, 1, 'CONFLICT -> exit 1')
  assert.equal(a.report.mode, 'analysis')
  assert.ok(a.report.verification.checks.every((c: any) => c.kind === 'tool-validation'), 'analyze executes no formal/API checks')
  const v = runCli(ws, ['verify', '--base-ref', 'HEAD'])
  check(schema('report.schema.json'), v.report)
  assert.equal(v.report.mode, 'verification')
  assert.ok(v.report.verification.checks.some((c: any) => c.kind === 'formal' && c.status === 'PASS'))
  assert.ok(v.report.verification.checks.some((c: any) => c.kind === 'api-compatibility' && c.status === 'PASS'))
  const conflict = v.report.analysis.findings.find((f: any) => f.verdict === 'CONFLICT')
  assert.equal(conflict.rule, 'RC-REQUIRED-OPTIONAL')
  assert.ok(conflict.tools.includes('openspec') && conflict.tools.includes('typespec'), 'two tools contribute to the contradiction')
  const rep = runCli(ws, ['report'])
  assert.equal(rep.report.generatedAt, v.report.generatedAt, '`report` prints the last report')
  for (const k of ['requirementTraceability', 'apiContractLinkage', 'architectureLinkage', 'invariantVerification', 'executedVerification']) assert.ok(k in v.report.coverage)
  // analyze reuses fresh formal evidence ...
  const a2 = runCli(ws, ['analyze', 'consistency'])
  assert.equal(a2.report.analysis.findings.find((f: any) => f.rule === 'RI-ASSERTION-RESULT').verdict, 'CONSISTENT')
  // ... but never stale evidence: editing the model invalidates it
  const model = join(ws, 'formal/jobs.als')
  writeFileSync(model, readFileSync(model, 'utf8').replace('for 3 but 5 steps', 'for 2 but 5 steps'))
  const a3 = runCli(ws, ['analyze', 'consistency'])
  const ri = a3.report.analysis.findings.find((f: any) => f.rule === 'RI-ASSERTION-RESULT')
  assert.equal(ri.status, 'SKIP'); assert.equal(ri.verdict, 'UNKNOWN'); assert.match(ri.message, /STALE/)
})

test('CLI: unknown command/args fail with usage errors; verify without baseline is not a clean PASS', () => {
  const ws = prepareWorkspace('unit/cli2', join(REPO_ROOT, 'bench/base'), null)
  assert.equal(runCli(ws, ['frobnicate']).exitCode, 64)
  const v = runCli(ws, ['verify'])
  assert.equal(v.report.overall.status, 'SKIP')
  assert.equal(v.report.overall.verdict, 'UNKNOWN')
  assert.equal(v.exitCode, 3)
  assert.equal(runCli(ws, ['verify', '--allow-unknown']).exitCode, 0)
})

test('schemas: approved mapping files and benchmark ground truth are valid and never claim human review', () => {
  const m = schema('mappings.schema.json')
  for (const f of ['examples/jobs-platform/specbridge/mappings.yaml', 'examples/phase0/specbridge/mappings.yaml', 'bench/base/specbridge/mappings.yaml']) check(m, YAML.parse(readFileSync(join(REPO_ROOT, f), 'utf8')))
  const c = schema('benchmark-case.schema.json')
  const cases = readdirSync(join(REPO_ROOT, 'bench/cases'))
  assert.equal(cases.length, 15)
  for (const k of cases) {
    const def = YAML.parse(readFileSync(join(REPO_ROOT, 'bench/cases', k, 'case.yaml'), 'utf8'))
    check(c, def)
    assert.match(def.reviewStatus, /NOT reviewed by a human/)
  }
})
