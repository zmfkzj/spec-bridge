// Formal verification: executes EXPLICIT Alloy models (config alloy.models) and deterministic
// architecture projections; maps counterexamples back to IR entities and requirements.
// Bounded results: "no counterexample" means only "none within the stated scope".
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { alloyAvailable, alloyExec, reproduceCommand } from '../adapters/alloy.ts'
import type { AlloyProjection, SpecBridgeConfig } from '../config.ts'
import type { SemanticIR } from '../ir/types.ts'
import { IR_DIR } from '../ir/build.ts'
import { fileSha, fingerprint, rel } from '../util.ts'
import { facts } from '../link/derive.ts'

export type FormalOutcome = 'COUNTEREXAMPLE' | 'NO_COUNTEREXAMPLE_IN_SCOPE' | 'INSTANCE_FOUND' | 'NO_INSTANCE_IN_SCOPE' | 'ERROR'

export interface AtomMapping { atom: string; sig: string; entity: string | null; via: string }

export interface FormalResult {
  commandId: string
  label: string
  check: boolean
  target: string | null
  text: string
  scopes: { sig: string; exact: boolean; start: number; end: number }[]
  overall: number
  steps: number
  expects: number
  outcome: FormalOutcome
  /** check: SAT = counterexample; run: SAT = instance (NOT a violation). */
  satisfiable: boolean | null
  durationMs: number | null
  error?: string
  counterexample?: { states: any[]; skolems: Record<string, unknown>; atoms: AtomMapping[]; relatedRequirements: string[] }
  reproduce: string
  boundedNote: string
}

export interface FormalRun {
  kind: 'explicit' | 'projection'
  projection?: string
  model: string               // workspace-relative path of the executed model
  sourceModel: string         // explicit model it derives from
  modelSha256: string
  executedModelSha256: string
  alloyVersion: string | null
  solver: string | null
  status: 'EXECUTED' | 'ERROR' | 'SKIPPED'
  error?: string
  results: FormalResult[]
}

export interface FormalEvidence {
  executedAt: string
  /** Hash over models + approved VERIFIES/CORRESPONDS_TO mappings + projection config: evidence is stale when it changes. */
  inputsHash: string
  runs: FormalRun[]
}

export function formalInputsHash(ir: SemanticIR, config: SpecBridgeConfig): string {
  const models = ir.sources.find(s => s.tool === 'alloy')?.files ?? []
  const maps = ir.relations.filter(r => r.mappingId && (r.type === 'VERIFIES' || r.type === 'CORRESPONDS_TO')).map(r => [r.id, r.stale ?? false])
  const c4 = config.alloyProjections.length ? ir.relations.filter(r => r.type === 'DEPENDS_ON' && r.from.startsWith('likec4:')).map(r => r.id) : []
  const c4e = config.alloyProjections.length ? ir.entities.filter(e => e.tool === 'likec4' && e.type !== 'Flow').map(e => e.id + ':' + e.attrs.kind) : []
  return fingerprint({ models, maps, projections: config.alloyProjections, c4, c4e })
}

const outcomeOf = (check: boolean, sat: boolean): FormalOutcome => check ? (sat ? 'COUNTEREXAMPLE' : 'NO_COUNTEREXAMPLE_IN_SCOPE') : (sat ? 'INSTANCE_FOUND' : 'NO_INSTANCE_IN_SCOPE')

function scopeText(r: any): string {
  const c = r.command
  const parts = [`overall ${c.overall < 0 ? 'default(3)' : c.overall}`]
  for (const s of c.scopes) parts.push(`${s.exact ? 'exactly ' : ''}${s.end} ${s.sig}`)
  if (c.maxprefix > 0) parts.push(`${c.maxprefix} steps`)
  return parts.join(', ')
}

export function runFormal(ir: SemanticIR, config: SpecBridgeConfig): FormalEvidence {
  const ev: FormalEvidence = { executedAt: new Date().toISOString(), inputsHash: formalInputsHash(ir, config), runs: [] }
  const alloySrc = ir.sources.find(s => s.tool === 'alloy')
  const models = alloySrc?.files.map(f => f.path) ?? []
  const avail = alloyAvailable()
  for (const m of models) {
    const abs = resolve(config.workspace, m)
    const sha = fileSha(abs)
    const run: FormalRun = { kind: 'explicit', model: m, sourceModel: m, modelSha256: sha, executedModelSha256: sha, alloyVersion: null, solver: null, status: 'EXECUTED', results: [] }
    if (!avail.ok) { run.status = 'SKIPPED'; run.error = avail.reason; ev.runs.push(run); continue }
    if (readFileSync(abs, 'utf8').includes('SPECBRIDGE-DRAFT')) { run.status = 'SKIPPED'; run.error = 'model still carries the SPECBRIDGE-DRAFT marker: unapproved draft, not executed as evidence'; ev.runs.push(run); continue }
    execInto(run, abs, [], ir, m, null)
    ev.runs.push(run)
  }
  for (const p of config.alloyProjections) ev.runs.push(runProjection(p, ir, config, avail.ok ? null : avail.reason!))
  return ev
}

function execInto(run: FormalRun, abs: string, labels: string[], ir: SemanticIR, modelRel: string, atomMap: Map<string, string> | null) {
  let d: any
  try { d = alloyExec(abs, labels) } catch (e) { run.status = 'ERROR'; run.error = (e as Error).message; return }
  if (!d.ok) { run.status = 'ERROR'; run.error = `${d.phase} error: ${d.error}`; return }
  run.alloyVersion = d.alloyVersion
  run.solver = d.solver
  const counts = new Map<string, number>()
  for (const r of d.results) {
    const c = r.command
    if (c.label === 'Default' && (!c.target || c.target === 'true') && !c.pos?.file) continue // implicit command of a model without commands
    const n = (counts.get(c.label) ?? 0) + 1
    counts.set(c.label, n)
    const commandId = `alloy:${run.sourceModel}#cmd:${n > 1 ? `${c.label}~${n}` : c.label}`
    const res: FormalResult = {
      commandId, label: c.label, check: c.check, target: c.target, text: c.text, scopes: c.scopes, overall: c.overall, steps: c.maxprefix, expects: c.expects,
      outcome: r.ok ? outcomeOf(c.check, r.satisfiable) : 'ERROR', satisfiable: r.ok ? r.satisfiable : null, durationMs: r.durationMs ?? null,
      reproduce: reproduceCommand(modelRel, c.label),
      boundedNote: c.check
        ? (r.ok && !r.satisfiable ? `No counterexample within scope [${scopeText(r)}] of model ${run.model}. This is bounded evidence about the model, not a proof of system or implementation correctness.` : `Counterexample within scope [${scopeText(r)}].`)
        : `run command: SAT means an instance exists; it is not an assertion result.`,
      ...(r.ok ? {} : { error: r.error }),
    }
    if (r.ok && r.satisfiable && c.check) {
      const atoms = mapAtoms(r.states?.[0]?.sigs ?? {}, ir, run.sourceModel, atomMap)
      const assertId = `alloy:${run.sourceModel}#assert:${c.target}`
      const relatedRequirements = facts(ir, 'VERIFIES').filter(v => v.from === assertId && v.to.startsWith('openspec:')).map(v => v.to)
      res.counterexample = { states: r.states, skolems: r.skolems ?? {}, atoms, relatedRequirements }
    }
    run.results.push(res)
  }
}

/** Map counterexample atoms (e.g. "Job$1") to IR entities via sig -> CORRESPONDS_TO, or projection atoms -> LikeC4. */
function mapAtoms(sigs: Record<string, string[][]>, ir: SemanticIR, model: string, atomMap: Map<string, string> | null): AtomMapping[] {
  const out: AtomMapping[] = []
  const corr = facts(ir, 'CORRESPONDS_TO')
  const seen = new Set<string>()
  for (const [sig, tuples] of Object.entries(sigs)) {
    for (const [atom] of tuples) {
      if (seen.has(atom)) continue
      // atoms appear under every ancestor sig; attribute to the most specific (the atom's own prefix)
      const own = atom.replace(/\$\d+$/, '')
      if (own !== sig && Object.keys(sigs).includes(own)) continue
      seen.add(atom)
      if (atomMap?.has(own)) { out.push({ atom, sig: own, entity: atomMap.get(own)!, via: 'architecture projection' }); continue }
      const sigId = `alloy:${model}#sig:${own}`
      const m = corr.find(c => c.from === sigId)?.to ?? corr.find(c => c.to === sigId)?.from ?? null
      out.push({ atom, sig: own, entity: m, via: m ? 'approved CORRESPONDS_TO mapping' : 'no mapping (Alloy-only concept)' })
    }
  }
  return out
}

const atomName = (fqn: string) => 'P_' + fqn.replace(/[^A-Za-z0-9]/g, '_')

/** Deterministic projection of the LikeC4 relation graph into the explicit model (no AI, no new semantics). */
export function generateProjection(p: AlloyProjection, ir: SemanticIR, config: SpecBridgeConfig): { file: string; atomMap: Map<string, string>; problems: string[]; text: string } {
  const src = resolve(config.workspace, p.model)
  const problems: string[] = []
  const atoms = p.atoms ?? {}
  const els = ir.entities.filter(e => e.tool === 'likec4' && (e.type === 'Component' || e.type === 'Interface') && p.elementKinds.includes(String(e.attrs.kind)))
  const fqns = new Set(els.map(e => String(e.attrs.fqn)))
  for (const [sig, fqn] of Object.entries(atoms)) if (!fqns.has(fqn)) problems.push(`projection ${p.id}: Alloy atom ${sig} maps to LikeC4 element '${fqn}' which does not exist (or is not of kinds ${p.elementKinds.join(',')})`)
  const nameOf = new Map<string, string>()
  for (const [sig, fqn] of Object.entries(atoms)) if (fqns.has(fqn)) nameOf.set(fqn, sig)
  for (const f of [...fqns].sort()) if (!nameOf.has(f)) nameOf.set(f, atomName(f))
  const edges = ir.relations.filter(r => r.type === 'DEPENDS_ON' && fqns.has(r.from.slice(7)) && fqns.has(r.to.slice(7)))
    .map(r => `${nameOf.get(r.from.slice(7))}->${nameOf.get(r.to.slice(7))}`)
  const fresh = [...nameOf.entries()].filter(([f]) => !Object.values(atoms).includes(f)).map(([, n]) => n)
  const all = [...new Set(nameOf.values())]
  const lines = [
    '', `// ---- SpecBridge architecture projection '${p.id}' (generated deterministically from LikeC4; not hand-written) ----`,
    ...(fresh.length ? [`one sig ${fresh.join(', ')} extends ${p.sig} {}`] : []),
    `fact SpecBridgeProjection_${p.id.replace(/\W/g, '_')} {`,
    `  ${p.sig} = ${all.length ? all.join(' + ') : 'none'}`,
    `  ${p.relation} = ${edges.length ? [...new Set(edges)].join(' + ') : 'none->none'}`,
    '}',
    ...p.assertions.map(a => `specbridge_${a}: check ${a} for ${Math.max(all.length, 1)}`),
  ]
  const base = existsSync(src) ? readFileSync(src, 'utf8') : ''
  if (!base) problems.push(`projection ${p.id}: model ${p.model} not found`)
  const text = base + '\n' + lines.join('\n') + '\n'
  const dir = join(config.workspace, IR_DIR, 'generated', p.id)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'projection.als')
  writeFileSync(file, text)
  return { file, atomMap: new Map([...nameOf.entries()].map(([f, n]) => [n, `likec4:${f}`])), problems, text }
}

function runProjection(p: AlloyProjection, ir: SemanticIR, config: SpecBridgeConfig, unavailable: string | null): FormalRun {
  const g = generateProjection(p, ir, config)
  const srcAbs = resolve(config.workspace, p.model)
  const run: FormalRun = {
    kind: 'projection', projection: p.id, model: rel(config.workspace, g.file), sourceModel: p.model, modelSha256: existsSync(srcAbs) ? fileSha(srcAbs) : '',
    executedModelSha256: fileSha(g.file), alloyVersion: null, solver: null, status: 'EXECUTED', results: [],
  }
  if (g.problems.length) { run.status = 'ERROR'; run.error = g.problems.join('; '); return run }
  if (unavailable) { run.status = 'SKIPPED'; run.error = unavailable; return run }
  execInto(run, g.file, p.assertions.map(a => `specbridge_${a}`), ir, run.model, g.atomMap)
  // commands of the generated file are attributed to the source model's assertions
  for (const r of run.results) r.commandId = `projection:${p.id}#${r.label}`
  return run
}

export const EVIDENCE_FILE = 'evidence/formal.json'

export function saveFormalEvidence(ws: string, ev: FormalEvidence) {
  const f = join(ws, IR_DIR, EVIDENCE_FILE)
  mkdirSync(join(ws, IR_DIR, 'evidence'), { recursive: true })
  writeFileSync(f, JSON.stringify(ev, null, 1))
}

export function loadFormalEvidence(ws: string): FormalEvidence | null {
  const f = join(ws, IR_DIR, EVIDENCE_FILE)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}
