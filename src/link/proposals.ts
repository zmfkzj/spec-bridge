// Linking strategy step 5: candidate proposals (heuristic, or an optional external AI command).
// Proposals are NEVER facts: they are stored separately, carry trust "Proposed", are excluded from
// consistency, coverage and impact propagation, and become relations only via `mapping approve`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Entity, RelationType, SemanticIR } from '../ir/types.ts'
import { IR_DIR } from '../ir/build.ts'
import { fingerprint, run } from '../util.ts'
import { isFact } from './derive.ts'
import type { MappingEntry } from './mappings.ts'

export interface Proposal {
  id: string
  type: RelationType
  from: string
  to: string
  trust: 'Proposed'
  method: 'heuristic' | 'ai'
  /** Similarity score in [0,1]: a ranking signal, NOT a probability or verification result. */
  score: number
  rationale: string
  fingerprints: { from: string; to: string }
}

export interface ProposalRun { proposals: Proposal[]; ai: { provider: string | null; calls: number; tokens: number | null; errors: string[] }; generatedAt: string }

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'be', 'shall', 'must', 'system', 'when', 'at', 'in', 'on', 'for', 'with', 'by', 'it', 'its', 'this', 'that', 'no', 'not', 'one', 'time', 'api', 'service'])
export function tokens(s: string): Set<string> {
  const words = s.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w))
  return new Set(words.map(w => w.replace(/(ments|ment|ings|ing|ies|es|s|ed)$/, '')))
}
const jaccard = (a: Set<string>, b: Set<string>) => { const i = [...a].filter(x => b.has(x)).length; const u = new Set([...a, ...b]).size; return u ? i / u : 0 }

const text = (e: Entity) => [e.name, e.type === 'Requirement' ? String(e.attrs.text ?? '') : '', String(e.attrs.title ?? '')].join(' ')

export function proposeLinks(ir: SemanticIR, rejected: MappingEntry[], threshold = 0.25): Proposal[] {
  const out: Proposal[] = []
  const linked = new Set(ir.relations.filter(isFact).map(r => `${r.from}|${r.to}`))
  const isRejected = (t: string, a: string, b: string) => rejected.some(m => m.status === 'rejected' && m.type === t && m.from === a && m.to === b)
  const pairs: Array<[RelationType, (e: Entity) => boolean, (e: Entity) => boolean]> = [
    ['VERIFIES', e => e.type === 'Invariant', e => e.type === 'Requirement'],
    ['CORRESPONDS_TO', e => e.tool === 'alloy' && e.type === 'DataType', e => e.tool === 'typespec' && e.type === 'DataType'],
    ['CORRESPONDS_TO', e => e.tool === 'alloy' && e.type === 'Field', e => e.tool === 'typespec' && e.type === 'Field'],
    ['EXPOSES', e => e.tool === 'likec4' && e.type === 'Component', e => e.tool === 'typespec' && e.type === 'Interface' && e.attrs.kind === 'interface'],
    ['SATISFIES', e => e.type === 'Operation', e => e.type === 'Requirement'],
  ]
  for (const [type, fa, fb] of pairs) {
    const A = ir.entities.filter(fa), B = ir.entities.filter(fb)
    for (const a of A) for (const b of B) {
      if (linked.has(`${a.id}|${b.id}`) || linked.has(`${b.id}|${a.id}`) || isRejected(type, a.id, b.id)) continue
      const s = jaccard(tokens(text(a)), tokens(text(b)))
      if (s < threshold) continue
      out.push({ id: 'proposal:' + fingerprint([type, a.id, b.id]), type, from: a.id, to: b.id, trust: 'Proposed', method: 'heuristic', score: Math.round(s * 100) / 100, rationale: `token overlap ${[...tokens(text(a))].filter(x => tokens(text(b)).has(x)).join(', ')} (heuristic name/text similarity)`, fingerprints: { from: a.fingerprint, to: b.fingerprint } })
    }
  }
  return out.sort((x, y) => y.score - x.score)
}

/**
 * Optional AI proposal boundary: SPECBRIDGE_AI_COMMAND is executed with a JSON request on stdin and
 * must print {"proposals":[{type,from,to,rationale}], "usage":{"tokens":n}}. Output is validated
 * (endpoints must exist) and stored as Proposed only. No provider is bundled or assumed.
 */
export function aiProposals(ir: SemanticIR): ProposalRun['ai'] & { proposals: Proposal[] } {
  const cmd = process.env.SPECBRIDGE_AI_COMMAND
  if (!cmd) return { provider: null, calls: 0, tokens: null, errors: [], proposals: [] }
  const req = { task: 'propose semantic links (candidates only)', entities: ir.entities.filter(e => ['Requirement', 'Component', 'Operation', 'Invariant', 'DataType'].includes(e.type)).map(e => ({ id: e.id, type: e.type, name: e.name, text: e.type === 'Requirement' ? e.attrs.text : undefined })) }
  const r = run('sh', ['-c', `printf '%s' "$SPECBRIDGE_AI_REQUEST" | ${cmd}`], { env: { ...process.env, SPECBRIDGE_AI_REQUEST: JSON.stringify(req) } })
  const errors: string[] = []
  const proposals: Proposal[] = []
  let tokensUsed: number | null = null
  try {
    const out = JSON.parse(r.stdout)
    tokensUsed = out.usage?.tokens ?? null
    const ids = new Map(ir.entities.map(e => [e.id, e]))
    for (const p of out.proposals ?? []) {
      if (!ids.has(p.from) || !ids.has(p.to)) { errors.push(`AI proposal dropped: unknown endpoint ${p.from} / ${p.to}`); continue }
      proposals.push({ id: 'proposal:' + fingerprint([p.type, p.from, p.to, 'ai']), type: p.type, from: p.from, to: p.to, trust: 'Proposed', method: 'ai', score: 0, rationale: String(p.rationale ?? ''), fingerprints: { from: ids.get(p.from)!.fingerprint, to: ids.get(p.to)!.fingerprint } })
    }
  } catch (e) { errors.push(`AI command output not valid JSON (exit ${r.code}): ${(e as Error).message}`) }
  return { provider: cmd, calls: 1, tokens: tokensUsed, errors, proposals }
}

export const PROPOSALS_FILE = 'proposals.json'
export function saveProposals(ws: string, p: ProposalRun) { mkdirSync(join(ws, IR_DIR), { recursive: true }); writeFileSync(join(ws, IR_DIR, PROPOSALS_FILE), JSON.stringify(p, null, 1)) }
export function loadProposals(ws: string): ProposalRun | null { const f = join(ws, IR_DIR, PROPOSALS_FILE); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }
