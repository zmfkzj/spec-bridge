// Approved mapping store (specbridge/mappings.yaml): source-controlled, human-reviewed data kept
// OUTSIDE the disposable IR. SpecBridge only writes it through explicit `mapping approve|reject`
// commands run by a person; it never approves or rewrites a mapping on its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import YAML from 'yaml'
import type { Entity, MappingStatusRecord, Relation, RelationType } from '../ir/types.ts'
import { RELATION_TYPES } from '../ir/types.ts'

export interface MappingEntry {
  id: string
  type: RelationType
  from: string
  to: string
  status: 'approved' | 'rejected'
  approvedBy?: string
  approvedAt?: string
  rationale?: string
  /** Entity fingerprints at approval time; a change marks the mapping STALE (needs re-review). */
  fingerprints?: { from?: string; to?: string }
  source?: string   // e.g. "proposal:abc123 (heuristic)"
}

export interface MappingFile { mappings: MappingEntry[] }

export function loadMappings(file: string): { data: MappingFile; errors: string[] } {
  if (!existsSync(file)) return { data: { mappings: [] }, errors: [] }
  const errors: string[] = []
  const raw = YAML.parse(readFileSync(file, 'utf8')) ?? {}
  const mappings: MappingEntry[] = []
  for (const [i, m] of (raw.mappings ?? []).entries()) {
    if (!m?.id || !m.from || !m.to || !m.type) { errors.push(`mappings[${i}]: id, type, from and to are required`); continue }
    if (!(RELATION_TYPES as readonly string[]).includes(m.type)) { errors.push(`mappings[${i}] ${m.id}: unknown relation type ${m.type}`); continue }
    if (m.status !== 'approved' && m.status !== 'rejected') { errors.push(`mappings[${i}] ${m.id}: status must be approved or rejected (got ${m.status}); proposals are not stored here`); continue }
    if (m.status === 'approved' && !m.approvedBy) { errors.push(`mappings[${i}] ${m.id}: approved mapping without approvedBy is ignored`); continue }
    mappings.push(m)
  }
  return { data: { mappings }, errors }
}

export function saveMappings(file: string, data: MappingFile) {
  mkdirSync(dirname(file), { recursive: true })
  const header = '# Approved/rejected semantic mappings. Human-reviewed data: edit via `specbridge mapping approve|reject`.\n'
  writeFileSync(file, header + YAML.stringify(data, { lineWidth: 0 }))
}

/** Revalidate approved mappings against the freshly built entities (spec 6.3). */
export function validateMappings(
  mappings: MappingEntry[], byId: Map<string, Entity>, renames: Map<string, string>, entities: Entity[],
): { records: MappingStatusRecord[]; relations: Relation[] } {
  const records: MappingStatusRecord[] = []
  const relations: Relation[] = []
  for (const m of mappings) {
    const rec: MappingStatusRecord = { id: m.id, type: m.type, from: m.from, to: m.to, status: m.status, validity: 'VALID', reasons: [] }
    const ends: Array<['from' | 'to', string]> = [['from', m.from], ['to', m.to]]
    for (const [side, id] of ends) {
      const e = byId.get(id)
      if (!e) {
        rec.validity = 'INVALIDATED'
        const renamed = renames.get(id)
        const fp = m.fingerprints?.[side]
        const moved = fp ? entities.filter(x => x.fingerprint === fp && x.id !== id) : []
        if (renamed) { rec.reasons.push(`${side} endpoint ${id} was renamed to ${renamed} (OpenSpec RENAMED delta)`); rec.suggestion = `re-approve with ${side}: ${renamed}` }
        else if (moved.length === 1) { rec.reasons.push(`${side} endpoint ${id} no longer exists; an entity with identical content exists as ${moved[0].id} (possible move/rename)`); rec.suggestion = `review and re-approve with ${side}: ${moved[0].id}` }
        else rec.reasons.push(`${side} endpoint ${id} does not exist in the current specifications (deleted or never existed)`)
        continue
      }
      const fp = m.fingerprints?.[side]
      if (fp && fp !== e.fingerprint) {
        if (rec.validity === 'VALID') rec.validity = 'STALE'
        rec.reasons.push(`${side} endpoint ${id} changed since approval (fingerprint ${fp} -> ${e.fingerprint}); re-review required`)
      } else if (!fp && m.status === 'approved') rec.reasons.push(`no ${side} fingerprint recorded at approval: semantic drift of ${id} cannot be detected`)
    }
    records.push(rec)
    if (rec.validity === 'INVALIDATED') continue
    const ev = [{ kind: 'mapping' as const, detail: `${m.status} mapping ${m.id}${m.approvedBy ? ' by ' + m.approvedBy : ''}${m.rationale ? ': ' + m.rationale : ''}`, location: { file: 'specbridge/mappings.yaml' } }]
    relations.push({
      id: `${m.type}:${m.from}->${m.to}#${m.id}`, type: m.type, from: m.from, to: m.to,
      trust: m.status === 'approved' ? 'Explicit' : 'Rejected', rule: 'approved-mapping', evidence: ev, mappingId: m.id,
      ...(rec.validity === 'STALE' ? { stale: true } : {}),
    })
  }
  return { records, relations }
}

export function mappingsPath(workspace: string, rel: string) { return join(workspace, rel) }
