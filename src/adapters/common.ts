import type { Constraint, Entity, EntityType, Evidence, ExtractionMethod, Relation, RelationType, SourceLocation, SourceRecord, SourceVersion, Tool, Trust } from '../ir/types.ts'
import { fingerprint } from '../util.ts'

/** A cross-tool reference found in a source that the linker must resolve against the IR. */
export interface PendingRef {
  from: string                 // entity id holding the reference
  ref: string                  // raw identifier as written
  expect: Array<'operation' | 'interface' | 'component' | 'field' | 'type' | 'requirement' | 'any'>
  relation: RelationType       // relation to create when resolved
  reverse?: boolean            // create relation target -> from instead
  rule: string
  location: SourceLocation
  tool: Tool
  /** true: an unresolvable reference is a contradiction (e.g. metadata naming an operation). */
  strict: boolean
  /** For CONSUMES refs from LikeC4 relationships: the relationship target (expected provider side). */
  via?: string
}

export interface AdapterResult {
  source: SourceRecord
  entities: Entity[]
  relations: Relation[]
  constraints: Constraint[]
  refs: PendingRef[]
}

export interface AdapterContext {
  workspace: string
  git: { revision: string | null; dirty: boolean }
}

export function emptyResult(tool: Tool, toolVersion: string, root: string, iface: string): AdapterResult {
  return { source: { tool, toolVersion, root, files: [], status: 'OK', diagnostics: [], lossy: [], interface: iface }, entities: [], relations: [], constraints: [], refs: [] }
}

export function entity(p: {
  id: string; type: EntityType; name: string; tool: Tool; source: SourceLocation; version: SourceVersion
  method: ExtractionMethod; adapter: string; attrs: Record<string, unknown>; trust?: Trust; lossy?: string[]
  validation?: Entity['validation']; evidence?: Evidence[]; semantic?: unknown
}): Entity {
  return {
    id: p.id, type: p.type, name: p.name, tool: p.tool, source: p.source, version: p.version,
    extraction: { method: p.method, adapter: p.adapter, ...(p.lossy?.length ? { lossy: p.lossy } : {}) },
    validation: p.validation ?? { status: 'unvalidated' },
    trust: p.trust ?? 'Explicit',
    fingerprint: fingerprint(p.semantic ?? { type: p.type, name: p.name, attrs: p.attrs }),
    attrs: p.attrs,
    evidence: p.evidence ?? [{ kind: 'source', detail: `${p.tool} ${p.type} ${p.name}`, location: p.source }],
  }
}

export function relation(type: RelationType, from: string, to: string, trust: Trust, rule: string, evidence: Evidence[], attrs?: Record<string, unknown>): Relation {
  const id = `${type}:${from}->${to}` + (attrs?.direction ? `:${attrs.direction}` : '')
  return { id, type, from, to, trust, rule, evidence, ...(attrs ? { attrs } : {}) }
}
