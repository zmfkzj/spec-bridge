// API compatibility (oasdiff as a compatibility analyzer, not an authoring source):
// TypeSpec -> OpenAPI via the official @typespec/openapi3 emitter, then `oasdiff breaking/changelog -f json`.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SpecBridgeConfig } from '../config.ts'
import type { SemanticIR } from '../ir/types.ts'
import { IR_DIR } from '../ir/build.ts'
import { REPO_ROOT, run, toolVersion } from '../util.ts'
import { type Finding, finding } from '../analysis/findings.ts'
import { facts } from '../link/derive.ts'
import type { Seed } from '../analysis/impact.ts'

const require = createRequire(join(REPO_ROOT, 'package.json'))
export const OASDIFF = process.env.SPECBRIDGE_OASDIFF ?? join(REPO_ROOT, 'tools/oasdiff')

export async function emitOpenAPI(workspace: string, main: string, outDir: string): Promise<{ file: string | null; errors: string[] }> {
  const tsp = await import(require.resolve('@typespec/compiler'))
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const p = await tsp.compile(tsp.NodeHost, resolve(workspace, main), { noEmit: false, emit: ['@typespec/openapi3'], outputDir: outDir, options: { '@typespec/openapi3': { 'emitter-output-dir': outDir, 'file-type': 'json' } } })
  const errors = p.diagnostics.filter((d: any) => d.severity === 'error').map((d: any) => `${d.code}: ${d.message}`)
  const file = join(outDir, 'openapi.json')
  return { file: existsSync(file) && !errors.length ? file : null, errors }
}

export interface ApiCompatResult {
  status: 'EXECUTED' | 'SKIPPED' | 'ERROR'
  reason?: string
  oasdiffVersion?: string
  base?: string
  revision?: string
  breaking: any[]
  changelog: any[]
  mapped: Array<{ change: any; operation: string | null; breaking: boolean }>
  lossy: string[]
  findings: Finding[]
  seeds: Seed[]
}

export async function checkApiCompat(p: { config: SpecBridgeConfig; current: SemanticIR; baseline: SemanticIR | null; baselineWorkspace: string | null }): Promise<ApiCompatResult> {
  const res: ApiCompatResult = { status: 'EXECUTED', breaking: [], changelog: [], mapped: [], lossy: [], findings: [], seeds: [] }
  const { config } = p
  if (!config.typespec) return { ...res, status: 'SKIPPED', reason: 'TypeSpec not configured' }
  if (!p.baselineWorkspace || !p.baseline) return { ...res, status: 'SKIPPED', reason: 'no baseline (use --base-ref or --baseline-dir)' }
  if (!existsSync(OASDIFF)) return { ...res, status: 'SKIPPED', reason: `oasdiff binary not found at ${OASDIFF} (run scripts/setup-tools.sh)` }
  const out = join(config.workspace, IR_DIR, 'openapi')
  const cur = await emitOpenAPI(config.workspace, config.typespec.main, join(out, 'current'))
  const baseMain = existsSync(resolve(p.baselineWorkspace, config.typespec.main)) ? config.typespec.main : null
  const base = baseMain ? await emitOpenAPI(p.baselineWorkspace, baseMain, join(out, 'baseline')) : { file: null, errors: ['baseline has no TypeSpec entry ' + config.typespec.main] }
  if (!cur.file || !base.file) return { ...res, status: 'ERROR', reason: `OpenAPI emission failed: ${[...cur.errors, ...base.errors].join('; ')}` }
  res.base = base.file; res.revision = cur.file
  res.oasdiffVersion = toolVersion(OASDIFF, ['--version'])
  const b = run(OASDIFF, ['breaking', base.file, cur.file, '--format', 'json'])
  const c = run(OASDIFF, ['changelog', base.file, cur.file, '--format', 'json'])
  if (b.code !== 0 || c.code !== 0) return { ...res, status: 'ERROR', reason: `oasdiff failed: ${b.stderr || c.stderr}` }
  res.breaking = JSON.parse(b.stdout || '[]') ?? []
  res.changelog = JSON.parse(c.stdout || '[]') ?? []
  const opFor = (method: string, path: string): string | null => {
    for (const ir of [p.current, p.baseline!]) {
      const e = ir.entities.find(e => e.type === 'Operation' && String(e.attrs.verb).toUpperCase() === method?.toUpperCase() && e.attrs.path === path)
      if (e) return e.id
    }
    return null
  }
  const breakingFp = new Set(res.breaking.map((x: any) => x.fingerprint ?? x.id + x.path + x.operation))
  for (const ch of res.changelog) {
    const op = opFor(ch.operation, ch.path)
    const isBreaking = breakingFp.has(ch.fingerprint ?? ch.id + ch.path + ch.operation) || ch.level >= 3
    res.mapped.push({ change: ch, operation: op, breaking: isBreaking })
    if (op && !res.seeds.some(s => s.entity === op)) res.seeds.push({ entity: op, change: 'MODIFIED', source: 'oasdiff', detail: `${ch.id}: ${ch.text}` })
    if (ch.level < 2) continue
    const consumers = op ? facts(p.current, 'CONSUMES').filter(r => r.to === op).map(r => r.from) : []
    const reqs = op ? facts(p.current).filter(r => (r.type === 'REQUIRES' && r.to === op) || (r.type === 'SATISFIES' && r.from === op)).map(r => r.type === 'REQUIRES' ? r.from : r.to) : []
    res.findings.push(finding({
      rule: ch.level >= 3 ? 'API-BREAKING-CHANGE' : 'API-POTENTIALLY-BREAKING', family: 'api-compatibility', verdict: ch.level >= 3 ? 'CONFLICT' : 'UNKNOWN', category: ch.level >= 3 ? 'BREAKING_CHANGE' : 'POTENTIALLY_BREAKING',
      message: `oasdiff ${ch.id}: ${ch.text} (${ch.operation} ${ch.path})${op ? ` -> ${op}` : ' (operation not mapped to TypeSpec)'}${consumers.length ? `; consumers: ${consumers.join(', ')}` : ''}${reqs.length ? `; requirements: ${[...new Set(reqs)].join(', ')}` : ''}`,
      subjects: [op ?? `${ch.operation} ${ch.path}`, ch.id], tools: ['oasdiff', 'typespec', ...(consumers.length ? ['likec4' as const] : []), ...(reqs.length ? ['openspec' as const] : [])],
      evidence: [{ kind: 'tool-output', detail: JSON.stringify({ id: ch.id, level: ch.level, text: ch.text }), reproduce: `${OASDIFF.replace(REPO_ROOT + '/', '')} changelog ${base.file} ${cur.file} --format json` }],
      reproduce: `tools/oasdiff changelog ${base.file} ${cur.file} --format json`, details: { consumers, requirements: [...new Set(reqs)], fingerprint: ch.fingerprint },
    }))
  }
  res.lossy = lossyReport(p.current, JSON.parse(readFileSync(cur.file, 'utf8')))
  return res
}

/** What TypeSpec semantics did not survive the OpenAPI conversion (checked, not assumed). */
export function lossyReport(ir: SemanticIR, oa: any): string[] {
  const out: string[] = []
  const schemas = oa.components?.schemas ?? {}
  for (const op of ir.entities.filter(e => e.type === 'Operation' && e.tool === 'typespec')) {
    const o = oa.paths?.[String(op.attrs.path)]?.[String(op.attrs.verb).toLowerCase()]
    if (!o) { out.push(`${op.name}: no OpenAPI operation at ${op.attrs.verb} ${op.attrs.path}`); continue }
    if (op.attrs.interface) out.push(`${op.name}: TypeSpec interface '${op.attrs.interface}' survives only as operationId '${o.operationId}' (grouping is not a first-class OpenAPI concept)`)
  }
  for (const f of ir.entities.filter(e => e.type === 'Field' && e.tool === 'typespec')) {
    const model = ir.entities.find(e => e.id === f.attrs.model)
    const sch = schemas[String(model?.attrs.concept)]
    if (!sch) continue
    const prop = sch.properties?.[String(f.attrs.field)]
    if (!prop) { out.push(`${f.name}: property missing in OpenAPI schema ${model?.attrs.concept}`); continue }
    const req = (sch.required ?? []).includes(f.attrs.field)
    if (req === Boolean(f.attrs.optional)) out.push(`${f.name}: optionality differs (TypeSpec optional=${f.attrs.optional}, OpenAPI required=${req})`)
    if (f.attrs.min !== null && prop.minimum === undefined && prop.exclusiveMinimum === undefined) out.push(`${f.name}: @minValue not represented in OpenAPI`)
    if (f.attrs.max !== null && prop.maximum === undefined && prop.exclusiveMaximum === undefined) out.push(`${f.name}: @maxValue not represented in OpenAPI`)
    if (f.attrs.unit && f.attrs.unitRule !== '@encode') out.push(`${f.name}: unit '${f.attrs.unit}' is SpecBridge-derived from the property name (TSP-UNIT) and is not part of either TypeSpec or OpenAPI semantics`)
  }
  for (const t of ir.entities.filter(e => e.type === 'DataType' && e.tool === 'typespec' && e.attrs.base)) out.push(`${t.name}: model inheritance from ${t.attrs.base} is emitted as allOf/flattened schema`)
  return out
}
