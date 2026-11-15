import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, copyFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildIR } from '../src/ir/build.ts'
import { draftAlloyModel, DRAFT_MARKER } from '../src/verify/draft.ts'
import { runFormal } from '../src/verify/formal.ts'
import { REPO_ROOT } from '../src/util.ts'
import { prepareWorkspace } from './workspace.ts'

test('formal draft: generated model is marked DRAFT, parsed, records correspondence/missing parts, and is refused as evidence', async () => {
  const ws = prepareWorkspace('unit/draft', join(REPO_ROOT, 'examples/jobs-platform'), null, { git: false })
  const { ir, config } = await buildIR(ws)
  const r = draftAlloyModel(ir, ws, 'openspec:job-claim/exclusive-job-claim')
  assert.ok(existsSync(r.draft) && readFileSync(r.draft, 'utf8').startsWith(`// ${DRAFT_MARKER}`))
  assert.equal(r.syntaxCheck.ok, true, String(r.syntaxCheck.error))
  assert.ok(r.correspondence.some(c => c.from.includes('#SCN-CARDINALITY')), 'assertion stub traced to the requirement constraint')
  assert.ok(r.missing.some(m => m.includes('no transitions')), 'missing behaviour is reported, not invented')
  assert.ok(existsSync(r.draft.replace(/\.als$/, '.review.json')))
  // a draft placed into the model list without review is not executed as evidence
  copyFileSync(r.draft, join(ws, 'formal/draft.als'))
  writeFileSync(join(ws, 'specbridge.yaml'), readFileSync(join(ws, 'specbridge.yaml'), 'utf8').replace('models: [formal/jobs.als, formal/architecture.als]', 'models: [formal/jobs.als, formal/architecture.als, formal/draft.als]'))
  const b = await buildIR(ws)
  const ev = runFormal(b.ir, b.config)
  const run = ev.runs.find(x => x.model === 'formal/draft.als')!
  assert.equal(run.status, 'SKIPPED')
  assert.match(run.error!, /SPECBRIDGE-DRAFT/)
  void config
})
