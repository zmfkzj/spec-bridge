// Semantic benchmark runner. Executes every case under each configuration INDEPENDENTLY:
//   A  individual tool checks only (OpenSpec validate, LikeC4 diagnostics, TypeSpec compile,
//      oasdiff breaking, raw Alloy commands) — no cross-tool model
//   B  explicit-reference integration (IR + reference/mapping checks; Explicit links only) + A
//   C  Semantic IR + deterministic rules (the full `specbridge verify` CLI)
//   D  Semantic IR + AI-assisted mapping — UNSUPPORTED here: no AI provider is configured
//   D' heuristic proposals auto-accepted (NOT AI; shows the cost of trusting unreviewed candidates)
// Usage: node bench/run.ts [caseFilter]    -> bench/results/latest.json + bench/results/summary.md
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import YAML from 'yaml'
import { REPO_ROOT, run, sha256, stableStringify } from '../src/util.ts'
import { prepareWorkspace, runCli } from '../test/workspace.ts'
import { buildIR } from '../src/ir/build.ts'
import { analyzeConsistency } from '../src/analysis/consistency.ts'
import { openspecCli } from '../src/adapters/openspec.ts'
import { alloyExec } from '../src/adapters/alloy.ts'
import { emitOpenAPI, OASDIFF } from '../src/verify/apicompat.ts'
import { materializeGitBaseline } from '../src/workspace/materialize.ts'
import { loadConfig } from '../src/config.ts'
import { proposeLinks } from '../src/link/proposals.ts'
import { loadMappings, saveMappings } from '../src/link/mappings.ts'
import { createRequire } from 'node:module'

const require = createRequire(join(REPO_ROOT, 'package.json'))
const BENCH = join(REPO_ROOT, 'bench')
type F = { rule: string; verdict: string; category?: string; subjects: string[]; details?: any }
interface Outcome { findings: F[]; overall: string; links: Set<string>; impact?: any; ms: number; status?: string; note?: string }

async function toolsOnly(ws: string): Promise<Outcome> {
  const t = performance.now()
  const cfg = loadConfig(ws)
  const findings: F[] = []
  const env = { ...process.env, OPENSPEC_TELEMETRY: '0' }
  void env
  try {
    const v = openspecCli(ws, ['validate', '--all', '--json'])
    for (const it of v.items ?? []) if (!it.valid) findings.push({ rule: 'TOOL-VALIDATION-ERROR', verdict: 'CONFLICT', subjects: [`openspec:${it.id}`] })
  } catch (e) { findings.push({ rule: 'TOOL-ERROR', verdict: 'UNKNOWN', subjects: ['openspec'] }) }
  const { LikeC4 } = await import(require.resolve('likec4'))
  const l = await LikeC4.fromWorkspace(join(ws, cfg.likec4!.root), { printErrors: false, logger: false })
  for (const d of l.getErrors()) findings.push({ rule: 'TOOL-VALIDATION-ERROR', verdict: 'CONFLICT', subjects: ['likec4', d.message] })
  const tsp = await import(require.resolve('@typespec/compiler'))
  const p = await tsp.compile(tsp.NodeHost, join(ws, cfg.typespec!.main), { noEmit: true })
  for (const d of p.diagnostics.filter((d: any) => d.severity === 'error')) findings.push({ rule: 'TOOL-VALIDATION-ERROR', verdict: 'CONFLICT', subjects: ['typespec', d.message] })
  // oasdiff on the two OpenAPI documents (baseline = HEAD)
  try {
    const b = materializeGitBaseline(ws, 'HEAD')
    const cur = await emitOpenAPI(ws, cfg.typespec!.main, join(ws, '.specbridge/bench-A/current'))
    const base = await emitOpenAPI(b.dir, cfg.typespec!.main, join(ws, '.specbridge/bench-A/base'))
    const r = run(OASDIFF, ['breaking', base.file!, cur.file!, '--format', 'json'])
    for (const c of JSON.parse(r.stdout || '[]') ?? []) if (c.level >= 3) findings.push({ rule: 'TOOL-OASDIFF-BREAKING', verdict: 'CONFLICT', subjects: [`${c.operation} ${c.path}`, c.id] })
  } catch (e) { findings.push({ rule: 'TOOL-ERROR', verdict: 'UNKNOWN', subjects: ['oasdiff', String(e)] }) }
  for (const m of cfg.alloy?.models ?? []) {
    const d = alloyExec(join(ws, m))
    if (!d.ok) { findings.push({ rule: 'TOOL-ERROR', verdict: 'UNKNOWN', subjects: [m] }); continue }
    for (const r of d.results) if (r.command.check && r.ok && r.satisfiable) findings.push({ rule: 'TOOL-ALLOY-COUNTEREXAMPLE', verdict: 'CONFLICT', subjects: [`alloy:${m}#assert:${r.command.target}`] })
  }
  const overall = findings.some(f => f.verdict === 'CONFLICT') ? 'CONFLICT' : findings.some(f => f.verdict === 'UNKNOWN') ? 'UNKNOWN' : 'CONSISTENT'
  return { findings, overall, links: new Set(), ms: Math.round(performance.now() - t) }
}

async function referenceOnly(ws: string, a: Outcome): Promise<Outcome> {
  const t = performance.now()
  const { ir, config } = await buildIR(ws)
  const fs = analyzeConsistency({ ir, config, formal: null, profile: 'reference' }) as F[]
  const findings = [...a.findings, ...fs]
  const overall = findings.some(f => f.verdict === 'CONFLICT') ? 'CONFLICT' : findings.some(f => f.verdict === 'UNKNOWN') ? 'UNKNOWN' : 'CONSISTENT'
  const links = new Set(ir.relations.filter(r => r.trust === 'Explicit' && !r.stale).map(r => `${r.type}|${r.from}|${r.to}`))
  return { findings, overall, links, ms: Math.round(performance.now() - t) + a.ms }
}

function factLinks(ws: string): Set<string> {
  const f = join(ws, '.specbridge/ir.json')
  if (!existsSync(f)) return new Set()
  const ir = JSON.parse(readFileSync(f, 'utf8'))
  return new Set(ir.relations.filter((r: any) => (r.trust === 'Explicit' || r.trust === 'Derived') && !r.stale).map((r: any) => `${r.type}|${r.from}|${r.to}`))
}

function normalizeReport(r: any): string {
  const strip = (o: any): any => Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).filter(([k]) => !['generatedAt', 'timingsMs', 'durationMs', 'executedAt', 'approvedAt'].includes(k)).map(([k, v]) => [k, strip(v)]))
    : typeof o === 'string' ? o.replace(/\(\d+ ms\)/g, '(? ms)').replace(/\d+ ms/g, '? ms') : o
  return sha256(stableStringify(strip(r))).slice(0, 16)
}

function full(ws: string, c: any, env: Record<string, string>): Outcome & { hash: string; exitCode: number | null; report: any } {
  for (const pre of c.pre ?? []) runCli(ws, pre, env)
  const t = performance.now()
  const r = runCli(ws, c.command, env)
  const ms = Math.round(performance.now() - t)
  if (!r.report) return { findings: [], overall: 'ERROR', links: new Set(), ms, hash: '', exitCode: r.exitCode, report: null, note: r.stderr.slice(0, 500) }
  return { findings: r.report.analysis.findings, overall: r.report.overall.verdict, status: r.report.overall.status, links: factLinks(ws), impact: r.report.impact, ms, hash: normalizeReport(r.report), exitCode: r.exitCode, report: r.report }
}

function score(exp: any, o: Outcome) {
  const conflicts = o.findings.filter(f => f.verdict === 'CONFLICT')
  const hit = (d: any, f: F) => d.rules.includes(f.rule) && f.subjects.some(s => d.anchors.includes(s))
  const defects = (exp.conflicts ?? []).map((d: any) => {
    const m = conflicts.find(f => hit(d, f))
    const traced = !d.traceRequirement ? null : !!m && (m.subjects.includes(d.traceRequirement) || (m.details?.requirements ?? []).includes(d.traceRequirement))
    return { defect: d.defect, detected: !!m, by: m?.rule ?? null, traced }
  })
  const fp = conflicts.filter(f => !(exp.conflicts ?? []).some((d: any) => hit(d, f)))
  const negatives = (exp.mustNotConflict ?? []).map((n: any) => ({ anchors: n.anchors, flagged: conflicts.some(f => f.subjects.some(s => n.anchors.includes(s))) }))
  const unknowns = (exp.unknowns ?? []).map((u: any) => ({ rules: u.rules, anchors: u.anchors, reported: o.findings.some(f => f.verdict === 'UNKNOWN' && u.rules.includes(f.rule) && f.subjects.some(s => u.anchors.includes(s)) && (!u.category || f.category === u.category)) }))
  const key = (m: any) => `${m.type}|${m.from}|${m.to}`
  const maps = [...(exp.mappings?.present ?? []).map((m: any) => ({ link: key(m), expected: true, ok: o.links.has(key(m)) })), ...(exp.mappings?.absent ?? []).map((m: any) => ({ link: key(m), expected: false, ok: !o.links.has(key(m)) }))]
  const impactIds = new Set([...(o.impact?.impacted ?? []).map((i: any) => i.entity), ...(o.impact?.seeds ?? []).map((s: any) => s.entity)])
  const impact = exp.impact ? {
    mustInclude: (exp.impact.mustInclude ?? []).map((id: string) => ({ id, ok: impactIds.has(id) })),
    invalidatedMappings: (exp.impact.invalidatedMappings ?? []).map((id: string) => ({ id, ok: (o.impact?.invalidatedMappings ?? []).some((m: any) => m.id === id && m.baselineValidity === 'VALID') })),
  } : null
  return {
    overall: { expected: exp.overallVerdict, reported: o.overall, ok: exp.overallVerdict === o.overall, falsePass: exp.overallVerdict !== 'CONSISTENT' && o.overall === 'CONSISTENT' },
    tp: defects.filter((d: any) => d.detected).length, fn: defects.filter((d: any) => !d.detected).length, fp: fp.length, fpFindings: fp.map(f => `${f.rule} ${f.subjects.join(' ')}`),
    tn: negatives.filter((n: any) => !n.flagged).length, negativesFlagged: negatives.filter((n: any) => n.flagged).length,
    defects, unknowns, mappings: maps, impact, ms: o.ms,
  }
}

function agg(rows: any[]) {
  const s = (k: string) => rows.reduce((a, r) => a + r[k], 0)
  const tp = s('tp'), fp = s('fp'), fn = s('fn'), tn = s('tn')
  const maps = rows.flatMap(r => r.mappings), unk = rows.flatMap(r => r.unknowns), tr = rows.flatMap(r => r.defects).filter((d: any) => d.traced !== null)
  const imp = rows.flatMap(r => r.impact ? [...r.impact.mustInclude, ...r.impact.invalidatedMappings] : [])
  const r3 = (x: number) => Math.round(x * 1000) / 1000
  const lat = rows.map(r => r.ms).sort((a, b) => a - b)
  return {
    cases: rows.length, tp, fp, fn, negatives: tn + s('negativesFlagged'), tnOnNegatives: tn,
    precision: tp + fp ? r3(tp / (tp + fp)) : null, recall: tp + fn ? r3(tp / (tp + fn)) : null,
    falsePositiveRate: fp + tn ? r3(fp / (fp + tn)) : null, falseNegativeRate: tp + fn ? r3(fn / (tp + fn)) : null,
    overallVerdictAccuracy: r3(rows.filter(r => r.overall.ok).length / rows.length), falsePass: rows.filter(r => r.overall.falsePass).length,
    unknownRecall: unk.length ? r3(unk.filter((u: any) => u.reported).length / unk.length) : null,
    mappingAccuracy: maps.length ? r3(maps.filter((m: any) => m.ok).length / maps.length) : null,
    requirementTraceOfDetectedDefects: tr.length ? r3(tr.filter((d: any) => d.traced).length / tr.length) : null,
    impactExpectationsMet: imp.length ? r3(imp.filter((i: any) => i.ok).length / imp.length) : null,
    latencyMs: { mean: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length), p50: lat[Math.floor(lat.length / 2)], max: lat.at(-1) },
  }
}

async function autoAcceptHeuristics(ws: string) {
  const { ir, config } = await buildIR(ws)
  const file = join(ws, config.mappings)
  const mf = loadMappings(file).data
  const props = proposeLinks(ir, mf.mappings).filter(p => p.score >= 0.5)
  for (const p of props) mf.mappings.push({ id: `auto-${p.id.slice(9)}`, type: p.type, from: p.from, to: p.to, status: 'approved', approvedBy: "bench-auto-accept (simulated blind trust in heuristic proposals; NOT a human approval)", fingerprints: p.fingerprints })
  saveMappings(file, mf)
  return props.length
}

const filter = process.argv[2]
const cases = readdirSync(join(BENCH, 'cases')).filter(c => !filter || c.includes(filter)).sort()
const results: any[] = []
for (const c of cases) {
  const def = YAML.parse(readFileSync(join(BENCH, 'cases', c, 'case.yaml'), 'utf8'))
  const env = Object.fromEntries(Object.entries(def.env ?? {}).map(([k, v]) => [k, String(v).replace('{repo}', REPO_ROOT)])) as Record<string, string>
  const overlay = join(BENCH, 'cases', c, 'overlay')
  process.stderr.write(`case ${c} ...`)
  const ws = prepareWorkspace(`bench/${c}`, join(BENCH, 'base'), overlay)
  const A = await toolsOnly(ws)
  const B = await referenceOnly(ws, A)
  const C1 = full(ws, def, env)
  const C2 = full(ws, { ...def, pre: [] }, env)
  const wsD = prepareWorkspace(`bench/${c}-dprime`, join(BENCH, 'base'), overlay)
  const accepted = await autoAcceptHeuristics(wsD)
  const D = full(wsD, def, env)
  const row = {
    case: c, class: def.class, reviewStatus: def.reviewStatus, command: def.command,
    A: score(def.expected, A), B: score(def.expected, B), C: score(def.expected, C1), Dprime: { ...score(def.expected, D), acceptedHeuristicLinks: accepted },
    reproducible: C1.hash === C2.hash && !!C1.hash, hashes: [C1.hash, C2.hash], exitCode: C1.exitCode, status: C1.status,
    coverage: C1.report?.coverage ? Object.fromEntries(Object.entries(C1.report.coverage).map(([k, v]: any) => [k, { covered: v.covered, total: v.total, ratio: v.ratio }])) : null,
    aiUsage: C1.report?.aiUsage ?? null, note: C1.note,
  }
  results.push(row)
  process.stderr.write(` C=${row.C.overall.reported} tp=${row.C.tp} fp=${row.C.fp} fn=${row.C.fn} repro=${row.reproducible}\n`)
}
const summary = {
  generatedAt: new Date().toISOString(),
  groundTruth: 'agent-authored by the implementing agent; NOT reviewed by a human (no human review occurred)',
  environment: { node: process.version, platform: process.platform },
  configurations: {
    A: agg(results.map(r => r.A)), B: agg(results.map(r => r.B)), C: agg(results.map(r => r.C)),
    D: { status: 'UNSUPPORTED / NOT MEASURED', reason: 'no AI provider is configured in this environment; SPECBRIDGE_AI_COMMAND boundary exists but no model was called' },
    Dprime_heuristic_auto_accept: agg(results.map(r => r.Dprime)),
  },
  reproducibility: { casesIdenticalAcrossTwoRuns: results.filter(r => r.reproducible).length, cases: results.length },
  tokens: { A: 0, B: 0, C: 0, Dprime: 0, D: 'not measured (no provider)', note: 'no AI calls were made by A/B/C/Dprime; the case-10 stub fixture is a shell script, not a model' },
  cost: 'no paid services used; cost = local CPU time only (see latencyMs)',
}
mkdirSync(join(BENCH, 'results'), { recursive: true })
writeFileSync(join(BENCH, 'results', filter ? `partial-${filter}.json` : 'latest.json'), JSON.stringify({ summary, results }, null, 1))
if (!filter) writeFileSync(join(BENCH, 'results', 'summary.md'), renderMd(summary, results))
console.log(JSON.stringify(summary, null, 1))

function renderMd(s: any, rows: any[]): string {
  const L = ['# SpecBridge semantic benchmark — results', '', `Generated ${s.generatedAt} (${s.environment.node}). Ground truth: **${s.groundTruth}**.`, '', '## Configurations', '', '| metric | A tools only | B explicit refs | C IR + rules | D AI mapping | D′ heuristic auto-accept |', '|---|---|---|---|---|---|']
  const C = s.configurations
  for (const k of ['tp', 'fp', 'fn', 'precision', 'recall', 'falsePositiveRate', 'falseNegativeRate', 'overallVerdictAccuracy', 'falsePass', 'unknownRecall', 'mappingAccuracy', 'requirementTraceOfDetectedDefects', 'impactExpectationsMet'])
    L.push(`| ${k} | ${C.A[k]} | ${C.B[k]} | ${C.C[k]} | n/a | ${C.Dprime_heuristic_auto_accept[k]} |`)
  L.push(`| latency mean/max ms | ${C.A.latencyMs.mean}/${C.A.latencyMs.max} | ${C.B.latencyMs.mean}/${C.B.latencyMs.max} | ${C.C.latencyMs.mean}/${C.C.latencyMs.max} | n/a | ${C.Dprime_heuristic_auto_accept.latencyMs.mean}/${C.Dprime_heuristic_auto_accept.latencyMs.max} |`)
  L.push(`| tokens | 0 | 0 | 0 | not measured | 0 |`, '', `D: ${C.D.status} — ${C.D.reason}.`, '', `Reproducibility (C run twice, normalized report hash): ${s.reproducibility.casesIdenticalAcrossTwoRuns}/${s.reproducibility.cases} identical.`, '', '## Cases', '', '| case | expected | A | B | C | D′ | C TP/FP/FN | C false PASS | repro |', '|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) L.push(`| ${r.case} | ${r.C.overall.expected} | ${r.A.overall.reported} | ${r.B.overall.reported} | ${r.C.overall.reported} | ${r.Dprime.overall.reported} | ${r.C.tp}/${r.C.fp}/${r.C.fn} | ${r.C.overall.falsePass} | ${r.reproducible} |`)
  L.push('', '## False positives / false negatives (C)', '')
  for (const r of rows) {
    if (r.C.fp) L.push(`- ${r.case}: FP ${r.C.fpFindings.join('; ')}`)
    for (const d of r.C.defects.filter((d: any) => !d.detected)) L.push(`- ${r.case}: FN ${d.defect}`)
    for (const u of r.C.unknowns.filter((u: any) => !u.reported)) L.push(`- ${r.case}: expected UNKNOWN not reported (${u.rules.join('/')})`)
    for (const m of r.C.mappings.filter((m: any) => !m.ok)) L.push(`- ${r.case}: mapping ${m.expected ? 'missing' : 'unexpected'} ${m.link}`)
  }
  L.push('', '## False positives / false negatives (D′ heuristic auto-accept)', '')
  for (const r of rows) { if (r.Dprime.fp) L.push(`- ${r.case}: FP ${r.Dprime.fpFindings.join('; ')}`); for (const m of r.Dprime.mappings.filter((m: any) => !m.ok)) L.push(`- ${r.case}: mapping ${m.expected ? 'missing' : 'unexpected'} ${m.link}`); if (r.Dprime.overall.falsePass) L.push(`- ${r.case}: FALSE PASS`) }
  return L.join('\n') + '\n'
}
