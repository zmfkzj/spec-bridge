// Deterministic semantic rules (linking strategy step 4). Every derived relation names its rule
// and the facts it was derived from. Only Explicit/Derived, non-stale inputs are used.
import { relation } from '../adapters/common.ts'
import type { Constraint, Entity, ReferenceRecord, Relation, SemanticIR } from '../ir/types.ts'
import { EntityIndex } from './resolve.ts'

const fact = (r: Relation) => (r.trust === 'Explicit' || r.trust === 'Derived') && !r.stale

export function deriveRelations(ir: Pick<SemanticIR, 'entities' | 'relations' | 'constraints'>, index: EntityIndex): Relation[] {
  const out: Relation[] = []
  const rels = ir.relations.filter(fact)
  const add = (r: Relation) => { if (!rels.some(x => x.id === r.id) && !out.some(x => x.id === r.id)) out.push(r) }
  const by = (type: string) => rels.filter(r => r.type === type)

  // D-INTERFACE-EXPOSES: component exposes a TypeSpec interface -> it exposes each operation of it
  for (const ex of [...by('EXPOSES'), ...by('IMPLEMENTS')]) {
    if (index.byId.get(ex.to)?.type !== 'Interface' || index.byId.get(ex.to)?.tool !== 'typespec') continue
    for (const c of by('CONTAINS').filter(c => c.from === ex.to && index.byId.get(c.to)?.type === 'Operation'))
      add(relation('EXPOSES', ex.from, c.to, 'Derived', 'derive.interface-exposes-operations', [{ kind: 'rule', rule: 'D-INTERFACE-EXPOSES', detail: `${ex.from} ${ex.type} ${ex.to}; ${ex.to} contains ${c.to}` }]))
  }
  const exposes = [...by('EXPOSES'), ...out.filter(r => r.type === 'EXPOSES')]
  // D-PROVIDER-SATISFIES: requirement requires operation O and component C exposes O -> C satisfies requirement (derived, not approved)
  for (const rq of by('REQUIRES').filter(r => index.byId.get(r.to)?.type === 'Operation')) {
    for (const ex of exposes.filter(e => e.to === rq.to))
      add(relation('SATISFIES', ex.from, rq.from, 'Derived', 'derive.provider-of-required-operation', [{ kind: 'rule', rule: 'D-PROVIDER-SATISFIES', detail: `${rq.from} REQUIRES ${rq.to}; ${ex.from} EXPOSES ${rq.to}` }]))
  }
  // D-CORRESPONDS-CONSTRAINS: Alloy formula constrains sig/field S and S CORRESPONDS_TO TypeSpec T (approved) -> constrains T
  const corr = by('CORRESPONDS_TO')
  const corrOf = (id: string) => corr.filter(c => c.from === id).map(c => c.to).concat(corr.filter(c => c.to === id).map(c => c.from))
  for (const c of by('CONSTRAINS').filter(r => index.byId.get(r.from)?.tool === 'alloy')) {
    for (const t of corrOf(c.to).filter(t => index.byId.get(t)?.tool === 'typespec'))
      add(relation('CONSTRAINS', c.from, t, 'Derived', 'derive.alloy-constrains-corresponding-contract', [{ kind: 'rule', rule: 'D-CORRESPONDS-CONSTRAINS', detail: `${c.from} constrains ${c.to}; ${c.to} CORRESPONDS_TO ${t}` }]))
  }
  // D-REQ-CONSTRAINS: requirement constraint whose subject resolved to a contract field/type
  for (const k of ir.constraints.filter(k => k.tool === 'openspec')) {
    const target = k.subject.fieldKey ?? k.subject.operation
    if (target && index.byId.has(target)) {
      const origin = index.byId.get(k.origin)?.type === 'Scenario' ? String(index.byId.get(k.origin)!.attrs.requirement) : k.origin
      add(relation('CONSTRAINS', origin, target, 'Derived', 'derive.scn-constraint-subject', [{ kind: 'rule', rule: k.evidence[0]?.rule ?? 'SCN', detail: k.text, location: k.source }]))
    }
  }
  return out
}

/** Resolve constraint subjects to canonical concept/field identities. */
export function resolveConstraintSubjects(constraints: Constraint[], index: EntityIndex, relations: Relation[], refs: ReferenceRecord[]): string[] {
  const notes: string[] = []
  const corr = relations.filter(r => r.type === 'CORRESPONDS_TO' && fact(r))
  const mapped = (id: string) => corr.filter(c => c.from === id && index.byId.get(c.to)?.tool === 'typespec').map(c => c.to)
    .concat(corr.filter(c => c.to === id && index.byId.get(c.from)?.tool === 'typespec').map(c => c.from))
  for (const k of constraints) {
    if (k.tool === 'typespec' && k.subject.entity) {
      const f = index.byId.get(k.subject.entity)
      if (f?.type === 'Field') { k.subject.fieldKey = f.id; k.subject.conceptKey = String(f.attrs.model) }
      else if (f) k.subject.conceptKey = f.id
    } else if (k.tool === 'openspec') {
      if (k.kind === 'ErrorResponse' || k.kind === 'Ownership') {
        const r = index.resolve(k.subject.operation!, ['operation', 'interface'])
        if (r.status === 'resolved') k.subject.operation = r.target
        if (k.kind === 'Ownership' && k.params.target) { const c = index.resolve(k.params.target, ['component']); if (c.status === 'resolved') k.params.owner = c.target }
      } else if (k.kind === 'DependencyRestriction') {
        const a = index.resolve(k.text.match(/`([^`]+)`/)?.[1] ?? '', ['component'])
        const b = index.resolve(k.params.target ?? '', ['component'])
        if (a.status === 'resolved') k.subject.entity = a.target
        if (b.status === 'resolved') k.params.target = b.target
      } else if (k.subject.concept && k.subject.field) {
        const r = index.resolve(`${k.subject.concept}.${k.subject.field}`, ['field'])
        if (r.status === 'resolved') {
          const f = index.byId.get(r.target!)!
          k.subject.fieldKey = f.id; k.subject.conceptKey = String(f.attrs.model); k.subject.entity = f.id
        } else {
          const t = index.resolve(k.subject.concept, ['type'])
          if (t.status === 'resolved') k.subject.conceptKey = t.target // concept exists, field missing in contract
          else {
            // no contract concept: an explicit identifier may name an Alloy field (exact, unique match only)
            const af = [...index.byId.values()].filter(e => e.tool === 'alloy' && e.type === 'Field' && e.name === `${k.subject.concept}.${k.subject.field}`)
            if (af.length === 1) {
              k.subject.entity = af[0].id; k.subject.fieldKey = af[0].id; k.subject.conceptKey = af[0].id.replace(/#field:([^.]+)\..*$/, '#sig:$1')
              continue
            }
          }
          notes.push(`${k.id}: subject ${k.subject.concept}.${k.subject.field} ${r.status}${r.candidates ? ' ' + r.candidates.join(',') : ''}`)
        }
      }
    } else if (k.tool === 'alloy' && k.subject.entity) {
      const f = index.byId.get(k.subject.entity)!
      const sigId = k.subject.entity.replace(/#field:([^.]+)\..*$/, '#sig:$1')
      // field-level mapping first, then concept mapping + same field name (rule D-FIELD-IN-MAPPED-CONCEPT)
      const fm = mapped(f.id).filter(id => index.byId.get(id)?.type === 'Field')
      const cm = mapped(sigId).filter(id => index.byId.get(id)?.type === 'DataType')
      if (fm.length === 1) { k.subject.fieldKey = fm[0]; k.subject.conceptKey = String(index.byId.get(fm[0])!.attrs.model) }
      else if (cm.length === 1) {
        k.subject.conceptKey = cm[0]
        const tf = `typespec:field:${index.byId.get(cm[0])!.name}.${k.subject.field}`
        k.subject.fieldKey = index.byId.has(tf) ? tf : f.id
      } else { k.subject.conceptKey = sigId; k.subject.fieldKey = f.id } // tool-local identity: never unified by name
    } else if (k.tool === 'likec4' && k.kind === 'DependencyRestriction' && k.params.target) {
      const b = index.resolve(k.params.target, ['component'])
      if (b.status === 'resolved') k.params.target = b.target
      else notes.push(`${k.id}: forbidden dependency target '${k.params.target}' ${b.status}`)
    }
  }
  void refs
  return notes
}

/** Typed facts used by analyses (Explicit/Derived, non-stale relations). */
export function facts(ir: SemanticIR, type?: string) {
  return ir.relations.filter(r => fact(r) && (!type || r.type === type))
}

export function isFact(r: Relation) { return fact(r) }

export function entityMap(entities: Entity[]) { return new Map(entities.map(e => [e.id, e])) }
