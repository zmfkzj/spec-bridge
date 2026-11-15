// Semantic Change Impact Analysis (spec 8): typed propagation over the baseline AND current graphs.
import type { SpecBridgeConfig } from '../config.ts'
import type { Entity, EntityType, MappingStatusRecord, RelationType, SemanticIR } from '../ir/types.ts'
import { isFact } from '../link/derive.ts'
import { fingerprint } from '../util.ts'
import type { PathStep } from './findings.ts'

export type ChangeKind = 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED' | 'MOVED'
export interface Seed { entity: string; change: ChangeKind; source: 'baseline-diff' | 'openspec-change' | 'oasdiff' | 'explicit'; detail: string; renamedTo?: string }
export interface Impacted { entity: string; type: string; tool: string; name: string; depth: number; kind: 'direct' | 'indirect'; graph: 'current' | 'baseline'; path: PathStep[]; seed: string }
export interface ImpactResult {
  seeds: Seed[]
  impacted: Impacted[]
  invalidatedMappings: Array<MappingStatusRecord & { baselineValidity: string | null }>
  revalidation: { alloyCommands: string[]; operations: string[]; requirements: string[]; components: string[]; invariants: string[] }
  possiblyImpactedUnverified: { entity: string; via: string }[]
  warnings: string[]
  complete: boolean
  rules: typeof PROPAGATION
}

/**
 * Typed propagation rules. 'fwd' = from->to, 'rev' = to->from. `from` restricts the entity type the
 * impact is coming FROM; `terminal` marks the reached entity as impacted but does not expand it further
 * (e.g. a component reached as provider of an impacted operation must be re-checked, but its unrelated
 * dependents are not automatically impacted).
 */
export interface PropagationRule { rel: RelationType; dir: 'fwd' | 'rev'; from?: EntityType[]; terminal?: boolean | EntityType[]; why: string }
const REQ: EntityType[] = ['Requirement', 'Scenario']
export const PROPAGATION: PropagationRule[] = [
  { rel: 'REQUIRES', dir: 'fwd', from: REQ, why: 'changed requirement -> operations it requires' },
  { rel: 'REQUIRES', dir: 'rev', terminal: true, why: 'changed operation -> requirements that require it (re-check)' },
  { rel: 'SATISFIES', dir: 'fwd', terminal: true, why: 'changed component/operation -> requirements it satisfies (re-check)' },
  { rel: 'SATISFIES', dir: 'rev', from: REQ, terminal: ['Component'], why: 'changed requirement -> components/operations claimed to satisfy it' },
  { rel: 'EXPOSES', dir: 'fwd', from: ['Component', 'Interface'], why: 'changed provider -> operations it exposes' },
  { rel: 'EXPOSES', dir: 'rev', terminal: true, why: 'changed operation -> providing component' },
  { rel: 'IMPLEMENTS', dir: 'fwd', terminal: true, why: 'changed component -> interface it realises' },
  { rel: 'IMPLEMENTS', dir: 'rev', terminal: true, why: 'changed interface -> realising component' },
  { rel: 'CONSUMES', dir: 'rev', terminal: true, why: 'changed operation -> consuming components' },
  { rel: 'DEPENDS_ON', dir: 'rev', from: ['Component', 'Interface'], terminal: true, why: 'changed component -> components depending on it' },
  { rel: 'OWNS', dir: 'fwd', from: ['Component'], terminal: true, why: 'changed component -> owned data types' },
  { rel: 'OWNS', dir: 'rev', terminal: true, why: 'changed data type -> owning component' },
  { rel: 'CONSTRAINS', dir: 'fwd', from: REQ, why: 'changed requirement -> constrained contract elements' },
  { rel: 'CONSTRAINS', dir: 'rev', terminal: ['Requirement', 'Scenario'], why: 'changed element -> requirements (re-check) / invariants constraining it' },
  { rel: 'VERIFIES', dir: 'rev', why: 'changed requirement -> verifying assertions -> their check commands' },
  { rel: 'VERIFIES', dir: 'fwd', terminal: true, why: 'changed assertion -> requirement it verifies' },
  { rel: 'CORRESPONDS_TO', dir: 'fwd', why: 'formal concept <-> contract concept' },
  { rel: 'CORRESPONDS_TO', dir: 'rev', why: 'formal concept <-> contract concept' },
  { rel: 'REFERENCES', dir: 'rev', why: 'changed type/field/component -> operations/requirements referencing it' },
  { rel: 'REFERENCES', dir: 'fwd', from: REQ, terminal: true, why: 'changed requirement -> elements it mentions' },
  { rel: 'EXTENDS', dir: 'rev', why: 'changed base -> derived types/sigs' },
  { rel: 'CONTAINS', dir: 'rev', terminal: ['Component', 'DeploymentNode', 'Interface'], why: 'changed member -> its container (model, interface, system)' },
  { rel: 'DEPLOYS', dir: 'rev', terminal: true, why: 'changed component -> deployment instances' },
  { rel: 'TRANSITIONS_TO', dir: 'fwd', terminal: true, why: 'state graph' },
  { rel: 'TRANSITIONS_TO', dir: 'rev', terminal: true, why: 'state graph' },
]

const contentKey = (e: Entity) => fingerprint({ type: e.type, tool: e.tool, attrs: Object.fromEntries(Object.entries(e.attrs).filter(([k]) => !['fqn', 'name', 'title', 'parent', 'model', 'concept', 'field', 'spec', 'scenarios', 'requirement'].includes(k))) })

export function diffIR(base: SemanticIR, cur: SemanticIR): Seed[] {
  const b = new Map(base.entities.map(e => [e.id, e])), c = new Map(cur.entities.map(e => [e.id, e]))
  const seeds: Seed[] = []
  const removed = base.entities.filter(e => !c.has(e.id)), added = cur.entities.filter(e => !b.has(e.id))
  const renamedFrom = new Set<string>(), renamedTo = new Set<string>()
  for (const r of removed) {
    const cands = added.filter(a => a.type === r.type && a.tool === r.tool && !renamedTo.has(a.id) && contentKey(a) === contentKey(r))
    if (cands.length === 1) { seeds.push({ entity: r.id, change: 'RENAMED', renamedTo: cands[0].id, source: 'baseline-diff', detail: `identical content now at ${cands[0].id} (rename/move candidate; not auto-applied to mappings)` }); renamedFrom.add(r.id); renamedTo.add(cands[0].id) }
  }
  // OpenSpec Change entities describe the edit itself, not design elements
  const design = (e: Entity) => e.type !== 'Change'
  for (const r of removed) if (!renamedFrom.has(r.id) && design(r)) seeds.push({ entity: r.id, change: 'REMOVED', source: 'baseline-diff', detail: `${r.type} ${r.name} removed (was ${r.source.file}:${r.source.line ?? '?'})` })
  for (const a of added) if (!renamedTo.has(a.id) && design(a)) seeds.push({ entity: a.id, change: 'ADDED', source: 'baseline-diff', detail: `${a.type} ${a.name} added at ${a.source.file}:${a.source.line ?? '?'}` })
  for (const e of cur.entities) {
    const o = b.get(e.id)
    if (!o) continue
    if (o.fingerprint !== e.fingerprint) seeds.push({ entity: e.id, change: 'MODIFIED', source: 'baseline-diff', detail: `${e.type} ${e.name} content changed (${o.fingerprint} -> ${e.fingerprint})` })
    else if (o.source.file !== e.source.file) seeds.push({ entity: e.id, change: 'MOVED', source: 'baseline-diff', detail: `moved ${o.source.file} -> ${e.source.file} (same semantics)` })
  }
  // relation-level edits (e.g. a new LikeC4 relationship) seed both endpoints; derived relations follow from facts
  const relKey = (r: SemanticIR['relations'][number]) => `${r.type}|${r.from}|${r.to}`
  const isSourceFact = (r: SemanticIR['relations'][number]) => r.trust === 'Explicit' && r.type !== 'CHANGES'
  const bRel = new Set(base.relations.filter(isSourceFact).map(relKey)), cRel = new Set(cur.relations.filter(isSourceFact).map(relKey))
  const touch = (id: string, detail: string) => { if (!seeds.some(s => s.entity === id)) seeds.push({ entity: id, change: 'MODIFIED', source: 'baseline-diff', detail }) }
  for (const r of cur.relations.filter(isSourceFact)) if (!bRel.has(relKey(r)) && b.has(r.from) && b.has(r.to)) { touch(r.from, `relation added: ${r.from} ${r.type} ${r.to}`); touch(r.to, `relation added: ${r.from} ${r.type} ${r.to}`) }
  for (const r of base.relations.filter(isSourceFact)) if (!cRel.has(relKey(r)) && c.has(r.from) && c.has(r.to)) { touch(r.from, `relation removed: ${r.from} ${r.type} ${r.to}`); touch(r.to, `relation removed: ${r.from} ${r.type} ${r.to}`) }
  return seeds
}

export function analyzeImpact(p: { current: SemanticIR; baseline?: SemanticIR | null; seeds: Seed[]; config: SpecBridgeConfig }): ImpactResult {
  const { current, baseline, config } = p
  const warnings: string[] = []
  const graphs: Array<['current' | 'baseline', SemanticIR]> = [['current', current], ...(baseline ? [['baseline', baseline] as ['baseline', SemanticIR]] : [])]
  const adj = new Map<string, Array<{ step: PathStep; next: string; graph: 'current' | 'baseline'; rule: PropagationRule }>>()
  const entityOf = new Map<string, Entity>()
  for (const [g, ir] of graphs) {
    for (const e of ir.entities) if (!entityOf.has(e.id) || g === 'current') entityOf.set(e.id, e)
    for (const r of ir.relations) {
      if (!isFact(r) && !r.stale) continue // Proposed/Rejected never propagate; stale approved mappings still do (flagged)
      for (const rule of PROPAGATION.filter(x => x.rel === r.type)) {
        const dir = rule.dir
        const [a, b] = dir === 'fwd' ? [r.from, r.to] : [r.to, r.from]
        const step = { from: r.from, relation: r.type + (r.stale ? '(stale)' : ''), to: r.to, trust: r.trust, rule: r.rule }
        if (!adj.has(a)) adj.set(a, [])
        if (!adj.get(a)!.some(x => x.next === b && x.step.relation === step.relation && x.rule === rule)) adj.get(a)!.push({ step, next: b, graph: g, rule })
      }
    }
  }
  if (!p.seeds.length) warnings.push('no change seeds (no --change, baseline difference, oasdiff change or --entity): nothing was propagated; this is not evidence of "no impact"')
  const impacted = new Map<string, Impacted>()
  let truncated = false
  for (const s of p.seeds) {
    if (!entityOf.has(s.entity)) { warnings.push(`seed ${s.entity} is not present in the current or baseline IR; its impact cannot be traced`); continue }
    if (!(adj.get(s.entity)?.length)) warnings.push(`seed ${s.entity} (${s.change}) has no traced relations: impact is UNKNOWN, not "none" (it may simply be unlinked)`)
    const seen = new Set([s.entity])
    let frontier: Array<{ id: string; path: PathStep[]; graph: 'current' | 'baseline'; via?: PropagationRule }> = [{ id: s.entity, path: [], graph: s.change === 'REMOVED' ? 'baseline' : 'current' }]
    for (let depth = 1; depth <= config.policies.impactMaxDepth && frontier.length; depth++) {
      const next: typeof frontier = []
      for (const f of frontier) for (const edge of adj.get(f.id) ?? []) {
        const fromType = entityOf.get(f.id)?.type
        if (edge.rule.from && fromType && !edge.rule.from.includes(fromType)) continue
        // rule NO-SIBLING: do not traverse back through the same relation type in the opposite direction
        // (e.g. op -EXPOSES^-1-> component -EXPOSES-> other ops); this bounds fan-out to typed chains.
        if (f.via && f.via.rel === edge.rule.rel && f.via.dir !== edge.rule.dir) continue
        if (seen.has(edge.next)) continue // cycle / already reached by a shorter path
        seen.add(edge.next)
        if (impacted.size >= config.policies.impactMaxNodes) { truncated = true; break }
        const e = entityOf.get(edge.next)!
        const path = [...f.path, edge.step]
        const prev = impacted.get(edge.next)
        if (!prev || prev.depth > depth) impacted.set(edge.next, { entity: edge.next, type: e.type, tool: e.tool, name: e.name, depth, kind: depth === 1 ? 'direct' : 'indirect', graph: edge.graph, path, seed: s.entity })
        const t = edge.rule.terminal
        const stop = t === true || (Array.isArray(t) && t.includes(e.type))
        if (!stop) next.push({ id: edge.next, path, graph: edge.graph, via: edge.rule })
      }
      frontier = next
      if (depth === config.policies.impactMaxDepth && frontier.some(f => (adj.get(f.id) ?? []).some(x => !seen.has(x.next) && !(f.via && f.via.rel === x.rule.rel && f.via.dir !== x.rule.dir) && (!x.rule.from || x.rule.from.includes(entityOf.get(f.id)!.type))))) { truncated = true; warnings.push(`propagation from ${s.entity} stopped at max depth ${config.policies.impactMaxDepth}; further indirect impact not analysed`) }
    }
  }
  if (truncated) warnings.push(`impact propagation truncated (maxDepth ${config.policies.impactMaxDepth}, maxNodes ${config.policies.impactMaxNodes}); results are incomplete`)
  for (const s of current.sources) if (s.status !== 'OK' && s.status !== 'SKIPPED') warnings.push(`${s.tool} extraction status ${s.status}: impact through ${s.tool} entities is incomplete`)
  for (const s of baseline?.sources ?? []) if (s.status === 'ERROR') warnings.push(`baseline ${s.tool} extraction failed: deletions/changes in ${s.tool} may be missed`)

  // mappings valid at baseline but invalid/stale now
  const baseValidity = new Map((baseline?.mappings ?? []).map(m => [m.id, m.validity]))
  const invalidatedMappings = current.mappings.filter(m => m.status === 'approved' && m.validity !== 'VALID').map(m => ({ ...m, baselineValidity: baseValidity.get(m.id) ?? null }))
  // also mappings touching a seed (e.g. a modified requirement) even if fingerprints were not recorded
  const seedIds = new Set(p.seeds.map(s => s.entity))
  for (const m of current.mappings.filter(m => m.status === 'approved' && m.validity === 'VALID' && (seedIds.has(m.from) || seedIds.has(m.to))))
    invalidatedMappings.push({ ...m, validity: 'STALE', reasons: [...m.reasons, 'an endpoint is a change seed: approved meaning must be re-reviewed'], baselineValidity: baseValidity.get(m.id) ?? null })

  const all = [...impacted.values()]
  const ids = new Set([...all.map(i => i.entity), ...p.seeds.map(s => s.entity)])
  const typeOf = (id: string) => entityOf.get(id)?.type
  const cmds = current.relations.filter(r => r.type === 'VERIFIES' && typeOf(r.from) === 'Command' && ids.has(r.to)).map(r => r.from)
  const possible = current.relations.filter(r => r.trust === 'Proposed' && (ids.has(r.from) || ids.has(r.to))).map(r => ({ entity: ids.has(r.from) ? r.to : r.from, via: `proposed ${r.type} (unverified, not propagated)` }))
  return {
    seeds: p.seeds, impacted: all.sort((a, b) => a.depth - b.depth || a.entity.localeCompare(b.entity)), invalidatedMappings,
    revalidation: {
      alloyCommands: [...new Set(cmds)].sort(),
      operations: [...ids].filter(i => typeOf(i) === 'Operation').sort(),
      requirements: [...ids].filter(i => typeOf(i) === 'Requirement').sort(),
      components: [...ids].filter(i => typeOf(i) === 'Component').sort(),
      invariants: [...ids].filter(i => typeOf(i) === 'Invariant').sort(),
    },
    possiblyImpactedUnverified: possible, warnings: [...new Set(warnings)], complete: !truncated && p.seeds.length > 0 && !warnings.some(w => /incomplete|cannot be traced|failed/.test(w)), rules: PROPAGATION,
  }
}

