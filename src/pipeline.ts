// Orchestration of build -> link -> analyze -> verify. `analyze*` never executes Alloy/oasdiff;
// `verify*` executes them and records evidence. Source specs are never modified.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { analyzeConsistency } from './analysis/consistency.ts'
import { computeCoverage } from './analysis/coverage.ts'
import type { Finding } from './analysis/findings.ts'
import { analyzeImpact, diffIR, type ImpactResult, type Seed } from './analysis/impact.ts'
import { loadChange } from './adapters/openspec.ts'
import { reqId } from './adapters/openspec.ts'
import { buildIR, IR_DIR, saveIR, loadIR } from './ir/build.ts'
import type { SemanticIR } from './ir/types.ts'
import { type Check, type Report, buildReport } from './report/report.ts'
import { checkApiCompat, type ApiCompatResult } from './verify/apicompat.ts'
import { type FormalEvidence, loadFormalEvidence, runFormal, saveFormalEvidence } from './verify/formal.ts'
import { materializeChangeApplied, materializeGitBaseline } from './workspace/materialize.ts'
import type { SpecBridgeConfig } from './config.ts'

export interface PipelineOptions {
  workspace: string
  change?: string | null
  baseRef?: string | null
  baselineDir?: string | null
  entities?: string[]
  rule?: string | null
  allowUnknown?: boolean
}

export function toolChecks(ir: SemanticIR): Check[] {
  return ir.sources.filter(s => s.status !== 'SKIPPED' || s.diagnostics.some(d => d.severity === 'error')).map(s => ({
    id: `tool:${s.tool}`, kind: 'tool-validation' as const, tool: s.tool, status: s.status === 'OK' ? 'PASS' as const : s.status === 'SKIPPED' ? 'SKIP' as const : 'ERROR' as const,
    verdict: s.status === 'OK' ? 'NOT_APPLICABLE' as const : 'UNKNOWN' as const,
    detail: `${s.interface}; ${s.files.length} file(s); ${s.diagnostics.filter(d => d.severity === 'error').length} error(s), ${s.diagnostics.filter(d => d.severity === 'warning').length} warning(s)`,
  }))
}

export function formalChecks(ev: FormalEvidence | null): Check[] {
  const out: Check[] = []
  for (const run of ev?.runs ?? []) {
    if (run.status !== 'EXECUTED') { out.push({ id: `${run.kind}:${run.projection ?? run.model}`, kind: run.kind === 'projection' ? 'projection' : 'formal', tool: 'alloy', status: run.status === 'SKIPPED' ? 'SKIP' : 'ERROR', verdict: 'UNKNOWN', detail: run.error ?? run.status }); continue }
    for (const r of run.results) out.push({
      id: r.commandId, kind: run.kind === 'projection' ? 'projection' : 'formal', tool: `alloy ${run.alloyVersion}/${run.solver}`,
      status: r.outcome === 'ERROR' ? 'ERROR' : r.outcome === 'COUNTEREXAMPLE' ? 'FAIL' : 'PASS',
      verdict: r.outcome === 'COUNTEREXAMPLE' ? 'CONFLICT' : r.outcome === 'NO_COUNTEREXAMPLE_IN_SCOPE' ? 'CONSISTENT' : r.outcome === 'ERROR' ? 'UNKNOWN' : 'NOT_APPLICABLE',
      detail: `${r.text}: ${r.outcome} (${r.durationMs ?? '?'} ms). ${r.boundedNote}`, reproduce: r.reproduce,
    })
  }
  return out
}

export function apiCheck(api: ApiCompatResult | null): Check[] {
  if (!api) return []
  const breaking = api.findings.filter(f => f.verdict === 'CONFLICT').length
  return [{ id: 'oasdiff:breaking', kind: 'api-compatibility', tool: `oasdiff ${api.oasdiffVersion ?? ''}`.trim(), status: api.status === 'EXECUTED' ? (breaking ? 'FAIL' : 'PASS') : api.status === 'SKIPPED' ? 'SKIP' : 'ERROR', verdict: api.status !== 'EXECUTED' ? 'UNKNOWN' : breaking ? 'CONFLICT' : 'CONSISTENT', detail: api.status === 'EXECUTED' ? `${api.changelog.length} change(s), ${breaking} breaking (ERR level)` : api.reason ?? api.status }]
}

async function baselineIR(o: PipelineOptions, config: SpecBridgeConfig): Promise<{ ir: SemanticIR | null; dir: string | null; revision: string | null }> {
  if (o.baselineDir) return { ir: (await buildIR(resolve(o.baselineDir), { git: { revision: null, dirty: false } })).ir, dir: resolve(o.baselineDir), revision: null }
  if (o.baseRef) {
    const m = materializeGitBaseline(config.workspace, o.baseRef)
    return { ir: (await buildIR(m.dir, { git: { revision: m.revision, dirty: false } })).ir, dir: m.dir, revision: m.revision }
  }
  return { ir: null, dir: null, revision: null }
}

/** Seeds from an OpenSpec change's deltas (before -> after requirement state). */
export function changeSeeds(root: string, change: string): Seed[] {
  const c = loadChange(root, change)
  return c.deltas.map(d => d.operation === 'RENAMED'
    ? { entity: reqId(d.spec, d.rename!.from), change: 'RENAMED' as const, renamedTo: reqId(d.spec, d.rename!.to), source: 'openspec-change' as const, detail: `${change}: RENAMED "${d.rename!.from}" -> "${d.rename!.to}"` }
    : { entity: reqId(d.spec, d.requirement!.name), change: d.operation === 'ADDED' ? 'ADDED' as const : d.operation === 'REMOVED' ? 'REMOVED' as const : 'MODIFIED' as const, source: 'openspec-change' as const, detail: `${change}: ${d.operation} "${d.requirement!.name}"` })
}

export interface PipelineResult { report: Report; ir: SemanticIR; config: SpecBridgeConfig; timings: Record<string, number> }

export async function runPipeline(command: 'analyze consistency' | 'analyze impact' | 'analyze coverage' | 'verify formal' | 'verify' | 'build', o: PipelineOptions): Promise<PipelineResult> {
  const t0 = performance.now()
  const ws = resolve(o.workspace)
  const before = await buildIR(ws)
  saveIR(ws, before.ir, { timings: before.timings })
  let { ir, config } = before
  const timings: Record<string, number> = { ...before.timings }
  let introduced: string[] | undefined
  let seeds: Seed[] = []
  let changeView: SemanticIR | null = null
  if (o.change) {
    if (!config.openspec) throw new Error('--change requires an OpenSpec workspace')
    seeds.push(...changeSeeds(join(ws, config.openspec.root), o.change))
    const view = materializeChangeApplied(ws, o.change)
    changeView = (await buildIR(view.dir, { git: before.ir.git })).ir
    changeView.workspace = `${before.ir.workspace} (+ change ${o.change} applied on a copy)`
    for (const s of diffIR(before.ir, changeView)) if (!seeds.some(x => x.entity === s.entity)) seeds.push(s)
    ir = changeView
  }
  const verifying = command === 'verify' || command === 'verify formal'
  let formal: FormalEvidence | null = null
  if (verifying) {
    const t = performance.now()
    formal = runFormal(ir, { ...config, workspace: o.change ? join(ws, IR_DIR, 'cache', `change-${o.change}`) : ws })
    timings.formal = Math.round(performance.now() - t)
    if (!o.change) saveFormalEvidence(ws, formal)
  } else formal = o.change ? null : loadFormalEvidence(ws)

  let api: ApiCompatResult | null = null
  let impact: ImpactResult | null = null
  let baseline: Report['baseline'] = null
  if (command === 'verify' || command === 'analyze impact') {
    const b = await baselineIR(o, config)
    if (b.ir) {
      baseline = { ref: o.baseRef ?? null, dir: o.baselineDir ?? null, revision: b.revision }
      for (const s of diffIR(b.ir, ir)) if (!seeds.some(x => x.entity === s.entity)) seeds.push(s)
      if (command === 'verify') {
        const t = performance.now()
        api = await checkApiCompat({ config: o.change ? { ...config, workspace: join(ws, IR_DIR, 'cache', `change-${o.change}`) } : config, current: ir, baseline: b.ir, baselineWorkspace: b.dir })
        timings.oasdiff = Math.round(performance.now() - t)
        for (const s of api.seeds) if (!seeds.some(x => x.entity === s.entity)) seeds.push(s)
      }
    } else if (command === 'verify' && config.typespec) api = { status: 'SKIPPED', reason: 'no baseline given (--base-ref/--baseline-dir): API compatibility not checked', breaking: [], changelog: [], mapped: [], lossy: [], findings: [], seeds: [] }
    for (const e of o.entities ?? []) seeds.push({ entity: e, change: 'MODIFIED', source: 'explicit', detail: 'requested with --entity' })
    if (seeds.length || command === 'analyze impact') impact = analyzeImpact({ current: ir, baseline: o.change ? before.ir : b.ir, seeds, config })
  }
  let findings: Finding[] = []
  if (command !== 'build') {
    const t = performance.now()
    findings = analyzeConsistency({ ir, config, formal })
    if (changeView) {
      const beforeIds = new Set(analyzeConsistency({ ir: before.ir, config, formal: null }).map(f => f.id))
      introduced = findings.filter(f => !beforeIds.has(f.id) && f.verdict !== 'CONSISTENT').map(f => f.id)
    }
    if (o.rule) findings = findings.filter(f => f.rule === o.rule || f.rule.startsWith(o.rule!))
    if (command === 'verify formal') findings = findings.filter(f => f.family === 'requirement-invariant' || f.family === 'architecture-invariant' || f.family === 'tool')
    timings.analysis = Math.round(performance.now() - t)
  }
  const checks = verifying ? [...toolChecks(ir), ...formalChecks(formal), ...apiCheck(api)] : toolChecks(ir)
  const coverage = command === 'build' ? null : computeCoverage(ir, config, formal, verifying ? apiCheckFindings(api) : [])
  timings.total = Math.round(performance.now() - t0)
  const report = buildReport({ command: `specbridge ${command}`, mode: verifying ? 'verification' : 'analysis', ir, findings, checks, formal, api, impact, coverage, change: o.change ?? null, baseline, introduced, allowUnknown: o.allowUnknown })
  ;(report as any).timingsMs = timings
  mkdirSync(join(ws, IR_DIR), { recursive: true })
  writeFileSync(join(ws, IR_DIR, 'report.json'), JSON.stringify(report, null, 1))
  return { report, ir, config, timings }
}

function apiCheckFindings(api: ApiCompatResult | null): Finding[] {
  if (!api) return []
  return [{ id: 'oasdiff:breaking', rule: 'API-COMPAT', family: 'api-compatibility', status: api.status === 'EXECUTED' ? 'PASS' : api.status === 'SKIPPED' ? 'SKIP' : 'ERROR', verdict: 'NOT_APPLICABLE', category: 'CHECK', message: '', subjects: [], tools: ['oasdiff'], evidence: [], reproduce: '' }]
}

export { loadIR, existsSync }
