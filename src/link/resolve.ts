// Deterministic cross-tool reference resolution (linking strategy steps 1 and 3):
// explicit ids first, then a unique-suffix rule. Ambiguity is never guessed.
import type { PendingRef } from '../adapters/common.ts'
import type { Entity, ReferenceRecord, Relation } from '../ir/types.ts'
import { relation } from '../adapters/common.ts'

export class EntityIndex {
  byId = new Map<string, Entity>()
  private keys = new Map<string, Map<string, Set<string>>>() // kind -> key -> ids

  constructor(entities: Entity[]) {
    for (const e of entities) {
      this.byId.set(e.id, e)
      const kind = kindOf(e)
      if (!kind) continue
      for (const k of keysOf(e)) {
        if (!this.keys.has(kind)) this.keys.set(kind, new Map())
        const m = this.keys.get(kind)!
        if (!m.has(k)) m.set(k, new Set())
        m.get(k)!.add(e.id)
      }
    }
  }

  resolve(ref: string, expect: string[]): { status: ReferenceRecord['status']; target?: string; resolution?: 'exact' | 'unique-suffix'; candidates?: string[] } {
    if (this.byId.has(ref)) return { status: 'resolved', target: ref, resolution: 'exact' }
    const kinds = expect.includes('any') ? [...this.keys.keys()] : expect
    const exact = new Set<string>(), suffix = new Set<string>()
    for (const k of kinds) {
      const m = this.keys.get(k)
      if (!m) continue
      for (const id of m.get('=' + ref) ?? []) exact.add(id)
      for (const id of m.get('~' + ref) ?? []) suffix.add(id)
    }
    if (exact.size === 1) return { status: 'resolved', target: [...exact][0], resolution: 'exact' }
    if (exact.size > 1) return { status: 'ambiguous', candidates: [...exact].sort() }
    if (suffix.size === 1) return { status: 'resolved', target: [...suffix][0], resolution: 'unique-suffix' }
    if (suffix.size > 1) return { status: 'ambiguous', candidates: [...suffix].sort() }
    return { status: 'unresolved' }
  }
}

export function kindOf(e: Entity): string | null {
  if (e.type === 'Operation') return 'operation'
  if (e.type === 'Requirement') return 'requirement'
  if (e.tool === 'likec4' && (e.type === 'Component' || e.type === 'Interface')) return 'component'
  if (e.tool === 'typespec' && e.type === 'Interface') return 'interface'
  if (e.tool === 'typespec' && e.type === 'DataType') return 'type'
  if (e.tool === 'typespec' && e.type === 'Field') return 'field'
  return null
}

/** "=" exact keys, "~" dotted-suffix keys (e.g. Jobs.claimJob for JobApi.Jobs.claimJob). */
function keysOf(e: Entity): string[] {
  const full = e.tool === 'likec4' ? String(e.attrs.fqn) : e.type === 'Requirement' ? e.id.replace(/^openspec:/, '') : e.name
  const out = ['=' + full]
  const parts = full.split('.')
  for (let i = 1; i < parts.length; i++) out.push('~' + parts.slice(i).join('.'))
  return out
}

export function resolveRefs(refs: PendingRef[], index: EntityIndex): { records: ReferenceRecord[]; relations: Relation[] } {
  const records: ReferenceRecord[] = []
  const relations: Relation[] = []
  for (const r of refs) {
    const res = index.resolve(r.ref, r.expect)
    records.push({ from: r.from, ref: r.ref, relation: r.relation, rule: r.rule, tool: r.tool, strict: r.strict, location: r.location, expect: r.expect, ...res, ...(r.via ? { via: r.via } : {}) })
    if (res.status !== 'resolved') continue
    const target = res.target!
    let type = r.relation
    const tk = kindOf(index.byId.get(target)!)
    // OpenSpec backtick references: operation -> REQUIRES, everything else -> REFERENCES
    if (r.rule === 'openspec.backtick-reference' && tk !== 'operation') type = 'REFERENCES'
    const [from, to] = r.reverse ? [target, r.from] : [r.from, target]
    const trust = res.resolution === 'exact' ? 'Explicit' : 'Derived'
    const ev = [{ kind: 'source' as const, detail: `${r.rule}: '${r.ref}' resolved ${res.resolution} to ${target}`, location: r.location }]
    const attrs = r.relation === 'REFERENCES' && r.via ? { direction: r.via } : r.relation === 'CONSUMES' && r.via ? { via: r.via } : undefined
    const rel = relation(type, from, to, trust, r.rule + (res.resolution === 'unique-suffix' ? '+unique-suffix' : ''), ev, attrs)
    if (!relations.some(x => x.id === rel.id)) relations.push(rel)
  }
  return { records, relations }
}
