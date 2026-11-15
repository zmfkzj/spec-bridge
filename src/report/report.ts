// Unified report: stable JSON contract (schemas/report.schema.json) for CI and agents.
import type { SemanticIR } from '../ir/types.ts'
import type { CoverageReport } from '../analysis/coverage.ts'
import type { ExecStatus, Finding, Verdict } from '../analysis/findings.ts'
import type { ImpactResult } from '../analysis/impact.ts'
import type { FormalEvidence } from '../verify/formal.ts'
import type { ApiCompatResult } from '../verify/apicompat.ts'
import { SPECBRIDGE_VERSION } from '../util.ts'

export const REPORT_SCHEMA_VERSION = '1.0.0'

export interface Check { id: string; kind: 'tool-validation' | 'formal' | 'projection' | 'api-compatibility'; tool: string; status: ExecStatus; verdict: Verdict; detail: string; reproduce?: string }

export interface Report {
  schemaVersion: string
  generator: { name: 'specbridge'; version: string; toolVersions: Record<string, string> }
  command: string
  mode: 'analysis' | 'verification'
  generatedAt: string
  workspace: string
  git: { revision: string | null; dirty: boolean }
  change: string | null
  baseline: { ref: string | null; dir: string | null; revision: string | null } | null
  inputs: Array<{ tool: string; version: string; status: string; interface: string; files: number; errors: number; warnings: number; lossy: string[] }>
  model: { entities: Record<string, number>; relations: Record<string, number>; constraints: Record<string, number>; mappings: Record<string, number> }
  analysis: { findings: Finding[]; counts: { byVerdict: Record<string, number>; byFamily: Record<string, number>; conflictsByFamily: Record<string, number> }; introducedByChange?: string[] }
  verification: { executed: boolean; checks: Check[]; formal: FormalEvidence | null; apiCompatibility: Omit<ApiCompatResult, 'findings'> | null }
  impact: ImpactResult | null
  coverage: CoverageReport | null
  aiUsage: { provider: string | null; calls: number; tokens: number | null; note: string }
  overall: { status: ExecStatus; verdict: Verdict; exitCode: number; reasons: string[] }
  limitations: string[]
}

const count = <T>(xs: T[], key: (x: T) => string) => xs.reduce((m, x) => { const k = key(x); m[k] = (m[k] ?? 0) + 1; return m }, {} as Record<string, number>)

export const STANDING_LIMITATIONS = [
  'Bounded Alloy results ("no counterexample") hold only for the stated model and scope; they are not proofs of system or implementation correctness.',
  'Natural-language requirement text is interpreted only through SCN patterns; other normative statements are UNKNOWN.',
  'CONSISTENT means "no contradiction within the checks that ran"; unchecked aspects are listed as UNKNOWN or in coverage.uncovered.',
  'Heuristic/AI link proposals are never used as evidence until a person approves them.',
]

export function buildReport(p: {
  command: string; mode: Report['mode']; ir: SemanticIR; findings: Finding[]; checks: Check[]; formal: FormalEvidence | null; api: ApiCompatResult | null
  impact: ImpactResult | null; coverage: CoverageReport | null; change: string | null; baseline: Report['baseline']; ai?: Report['aiUsage']; introduced?: string[]; allowUnknown?: boolean
}): Report {
  const { ir, findings } = p
  const all = [...findings, ...(p.api?.findings ?? [])]
  const reasons: string[] = []
  const srcErr = ir.sources.filter(s => s.status === 'ERROR')
  const errChecks = p.checks.filter(c => c.status === 'ERROR'), skipChecks = p.checks.filter(c => c.status === 'SKIP')
  let status: ExecStatus = 'PASS'
  if (srcErr.length || errChecks.length || all.some(f => f.status === 'ERROR')) { status = 'ERROR'; reasons.push(`errors: ${[...srcErr.map(s => s.tool + ' extraction'), ...errChecks.map(c => c.id)].join(', ') || 'see findings'}`) }
  else if (all.some(f => f.status === 'FAIL') || p.checks.some(c => c.status === 'FAIL')) status = 'FAIL'
  else if (skipChecks.length || all.some(f => f.status === 'SKIP')) { status = 'SKIP'; reasons.push(`not executed: ${[...skipChecks.map(c => c.id), ...all.filter(f => f.status === 'SKIP').map(f => f.rule)].slice(0, 8).join(', ')}`) }
  let verdict: Verdict = 'NOT_APPLICABLE'
  const conflicts = all.filter(f => f.verdict === 'CONFLICT')
  if (conflicts.length) { verdict = 'CONFLICT'; reasons.push(`${conflicts.length} conflict(s): ${[...new Set(conflicts.map(f => f.rule))].join(', ')}`) }
  else if (all.some(f => f.verdict === 'UNKNOWN') || status !== 'PASS') { verdict = 'UNKNOWN'; reasons.push(`${all.filter(f => f.verdict === 'UNKNOWN').length} UNKNOWN finding(s)${status !== 'PASS' ? '; execution status ' + status : ''} — no clean PASS is claimed`) }
  else if (all.some(f => f.verdict === 'CONSISTENT')) verdict = 'CONSISTENT'
  if (p.mode === 'analysis') reasons.push('analysis mode: formal/API checks are not executed by `analyze`; use `specbridge verify` for executed evidence')
  const exitCode = verdict === 'CONFLICT' ? 1 : status === 'ERROR' ? 2 : verdict === 'UNKNOWN' || status === 'SKIP' ? (p.allowUnknown ? 0 : 3) : 0
  const { findings: _f, ...apiRest } = p.api ?? ({ findings: [] } as any)
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generator: { name: 'specbridge', version: SPECBRIDGE_VERSION, toolVersions: Object.fromEntries(ir.sources.map(s => [s.tool, s.toolVersion])) },
    command: p.command, mode: p.mode, generatedAt: new Date().toISOString(), workspace: ir.workspace, git: ir.git, change: p.change, baseline: p.baseline,
    inputs: ir.sources.map(s => ({ tool: s.tool, version: s.toolVersion, status: s.status, interface: s.interface, files: s.files.length, errors: s.diagnostics.filter(d => d.severity === 'error').length, warnings: s.diagnostics.filter(d => d.severity === 'warning').length, lossy: s.lossy })),
    model: { entities: count(ir.entities, e => e.type), relations: count(ir.relations, r => r.trust), constraints: count(ir.constraints, c => `${c.tool}:${c.interpretation}`), mappings: count(ir.mappings, m => `${m.status}:${m.validity}`) },
    analysis: { findings: all, counts: { byVerdict: count(all, f => f.verdict), byFamily: count(all, f => f.family), conflictsByFamily: count(conflicts, f => f.family) }, ...(p.introduced ? { introducedByChange: p.introduced } : {}) },
    verification: { executed: p.mode === 'verification', checks: p.checks, formal: p.formal, apiCompatibility: p.api ? apiRest : null },
    impact: p.impact, coverage: p.coverage,
    aiUsage: p.ai ?? { provider: null, calls: 0, tokens: null, note: 'no AI provider configured; no AI calls were made' },
    overall: { status, verdict, exitCode, reasons },
    limitations: [...STANDING_LIMITATIONS, ...ir.sources.flatMap(s => s.lossy.map(l => `${s.tool}: ${l}`))],
  }
}

export function renderText(r: Report): string {
  const L: string[] = []
  L.push(`SpecBridge ${r.command} (${r.mode}) — overall status ${r.overall.status}, verdict ${r.overall.verdict} (exit ${r.overall.exitCode})`)
  for (const x of r.overall.reasons) L.push(`  · ${x}`)
  L.push('Inputs: ' + r.inputs.map(i => `${i.tool}@${i.version}:${i.status}`).join('  '))
  const order = ['CONFLICT', 'UNKNOWN', 'CONSISTENT', 'NOT_APPLICABLE']
  for (const v of order) {
    const fs = r.analysis.findings.filter(f => f.verdict === v)
    if (!fs.length) continue
    L.push(`\n${v} (${fs.length})`)
    for (const f of fs.slice(0, v === 'CONSISTENT' || v === 'NOT_APPLICABLE' ? 10 : 200)) {
      L.push(`  [${f.status}] ${f.rule} (${f.family}, ${f.category}) ${f.message}`)
      for (const e of f.evidence.filter(e => e.location).slice(0, 3)) L.push(`      at ${e.location!.file}:${e.location!.line ?? '?'} — ${e.detail.slice(0, 120)}`)
    }
    if (fs.length > 10 && (v === 'CONSISTENT' || v === 'NOT_APPLICABLE')) L.push(`  ... ${fs.length - 10} more (see --format json)`)
  }
  if (r.verification.checks.length) { L.push('\nExecuted checks'); for (const c of r.verification.checks) L.push(`  [${c.status}/${c.verdict}] ${c.id}: ${c.detail.slice(0, 160)}`) }
  if (r.impact) {
    L.push(`\nImpact: ${r.impact.seeds.length} seed(s), ${r.impact.impacted.length} impacted, complete=${r.impact.complete}`)
    for (const s of r.impact.seeds.slice(0, 20)) L.push(`  seed ${s.change} ${s.entity} — ${s.detail}`)
    for (const i of r.impact.impacted.slice(0, 40)) L.push(`  ${i.kind} d${i.depth} ${i.entity} via ${i.path.map(p => p.relation).join(' > ')}`)
    for (const w of r.impact.warnings) L.push(`  ! ${w}`)
    if (r.impact.invalidatedMappings.length) L.push(`  invalidated mappings: ${r.impact.invalidatedMappings.map(m => `${m.id}(${m.validity})`).join(', ')}`)
  }
  if (r.coverage) {
    L.push('\nCoverage (linked/verified analysis targets; not a quality score)')
    for (const [k, m] of Object.entries(r.coverage)) L.push(`  ${k}: ${m.covered}/${m.total} ${m.ratio === null ? '(no targets)' : `(${Math.round(m.ratio * 100)}%)`}`)
  }
  L.push(`\nAI usage: ${r.aiUsage.calls} call(s) — ${r.aiUsage.note}`)
  return L.join('\n')
}
