import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { type AdapterContext, type AdapterResult, entity, relation } from '../adapters/common.ts'
import { extractAlloy } from '../adapters/alloy.ts'
import { extractLikeC4 } from '../adapters/likec4.ts'
import { extractOpenSpec } from '../adapters/openspec.ts'
import { extractTypeSpec } from '../adapters/typespec.ts'
import { loadConfig, type SpecBridgeConfig } from '../config.ts'
import { deriveRelations, resolveConstraintSubjects } from '../link/derive.ts'
import { loadMappings, validateMappings } from '../link/mappings.ts'
import { EntityIndex, resolveRefs } from '../link/resolve.ts'
import { gitInfo, rel } from '../util.ts'
import { IR_SCHEMA_VERSION, type Entity, type SemanticIR, type SourceRecord, type Tool } from './types.ts'

export interface BuildOptions {
  /** Override git info (used for baselines materialised from a git ref). */
  git?: { revision: string | null; dirty: boolean }
  /** Extra renames (old requirement id -> new id), e.g. from an OpenSpec change being analysed. */
  renames?: Map<string, string>
}

export async function buildIR(workspace: string, opts: BuildOptions = {}): Promise<{ ir: SemanticIR; config: SpecBridgeConfig; timings: Record<string, number> }> {
  const config = loadConfig(workspace)
  const g = opts.git ?? gitInfo(config.workspace)
  const ctx: AdapterContext = { workspace: config.workspace, git: { revision: g.revision, dirty: g.dirty } }
  const timings: Record<string, number> = {}
  const time = async <T>(k: string, f: () => T | Promise<T>): Promise<T> => { const t = performance.now(); const r = await f(); timings[k] = Math.round(performance.now() - t); return r }
  const results: AdapterResult[] = []
  const skipped = (tool: Tool, why: string): AdapterResult => ({ source: { tool, toolVersion: 'n/a', root: '', files: [], status: 'SKIPPED', diagnostics: [{ severity: 'info', message: why }], lossy: [], interface: 'n/a' }, entities: [], relations: [], constraints: [], refs: [] })
  results.push(config.openspec ? await time('openspec', () => extractOpenSpec(config.openspec!.root, ctx)) : skipped('openspec', 'not configured / no openspec/ directory'))
  results.push(config.likec4 ? await time('likec4', () => extractLikeC4(config.likec4!.root, ctx)) : skipped('likec4', 'not configured / no architecture/ directory'))
  results.push(config.typespec ? await time('typespec', () => extractTypeSpec(config.typespec!.main, ctx)) : skipped('typespec', 'not configured / no api/main.tsp'))
  const models = config.alloy ? (config.alloy.models.length ? config.alloy.models : defaultModels(config.workspace)) : []
  results.push(config.alloy ? await time('alloy', () => extractAlloy(models, ctx)) : skipped('alloy', 'not configured / no formal/ directory'))

  const entities: Entity[] = results.flatMap(r => r.entities)
  const diagnostics: SemanticIR['diagnostics'] = []
  const dup = new Set<string>()
  for (const e of entities) { if (dup.has(e.id)) diagnostics.push({ severity: 'error', code: 'DUPLICATE_ID', message: `duplicate entity id ${e.id}`, location: e.source }); dup.add(e.id) }
  let relations = results.flatMap(r => r.relations)
  const constraints = results.flatMap(r => r.constraints)

  // Linking step 1-3: explicit ids and structurally verifiable references
  let index = new EntityIndex(entities)
  const linked = await time('link', () => resolveRefs(results.flatMap(r => r.refs), index))
  relations.push(...linked.relations)

  // SCN transitions -> State / Transition entities (rule D-SCN-TRANSITION)
  for (const k of constraints.filter(k => k.tool === 'openspec' && k.kind === 'StateInvariant' && k.params.value?.includes('->'))) {
    const [a, b] = k.params.value!.split('->')
    const subject = `${k.subject.concept}.${k.subject.field}`
    const ids = [a, b].map(v => `openspec-state:${subject}=${v}`)
    for (const [i, v] of [a, b].entries()) if (!entities.some(e => e.id === ids[i]))
      entities.push(entity({ id: ids[i], type: 'State', name: `${subject}=${v}`, tool: 'openspec', source: k.source, version: { tool: 'openspec', toolVersion: results[0].source.toolVersion, gitRevision: ctx.git.revision }, method: 'scn-pattern', adapter: 'openspec@1', trust: 'Derived', attrs: { subject, value: v, rule: 'D-SCN-TRANSITION' } }))
    relations.push(relation('TRANSITIONS_TO', ids[0], ids[1], 'Derived', 'scn.transition', [{ kind: 'rule', rule: 'SCN-TRANSITION', detail: k.text, location: k.source }]))
  }
  index = new EntityIndex(entities)

  // Approved mappings (step 2), revalidated against current entities
  const mf = loadMappings(join(config.workspace, config.mappings))
  for (const e of mf.errors) diagnostics.push({ severity: 'error', code: 'MAPPING_FILE', message: e, location: { file: config.mappings } })
  const renames = new Map(opts.renames ?? [])
  for (const r of relations.filter(r => r.type === 'CHANGES' && r.attrs?.operation === 'RENAMED')) {
    const ch = entities.find(e => e.id === r.from)
    for (const d of (ch?.attrs.deltas as any[]) ?? []) if (d.rename) renames.set(`openspec:${d.spec}/${slugify(d.rename.from)}`, `openspec:${d.spec}/${slugify(d.rename.to)}`)
  }
  const mv = validateMappings(mf.data.mappings, index.byId, renames, entities)
  relations.push(...mv.relations)

  const subjectNotes = resolveConstraintSubjects(constraints, index, relations, linked.records)
  for (const n of subjectNotes) diagnostics.push({ severity: 'info', code: 'CONSTRAINT_SUBJECT', message: n })
  relations.push(...deriveRelations({ entities, relations, constraints }, index))

  // Drop relations whose endpoints do not exist (keep the record in references/mappings for findings)
  relations = relations.filter(r => index.byId.has(r.from) && index.byId.has(r.to))
  const sources: SourceRecord[] = results.map(r => r.source)
  const ir: SemanticIR = {
    schemaVersion: IR_SCHEMA_VERSION,
    workspace: rel(process.cwd(), config.workspace) || '.',
    git: { revision: ctx.git.revision, dirty: ctx.git.dirty },
    sources,
    entities: sortById(entities),
    relations: sortById(dedupe(relations)),
    constraints: sortById(constraints),
    mappings: mv.records,
    references: linked.records.sort((a, b) => (a.from + a.ref).localeCompare(b.from + b.ref)),
    diagnostics,
  }
  return { ir, config, timings }
}

function slugify(s: string) { return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }
function sortById<T extends { id: string }>(xs: T[]): T[] { return xs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }
function dedupe<T extends { id: string }>(xs: T[]): T[] { const m = new Map<string, T>(); for (const x of xs) if (!m.has(x.id)) m.set(x.id, x); return [...m.values()] }

function defaultModels(ws: string): string[] {
  const dir = join(ws, 'formal')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(f => f.endsWith('.als')).sort().map(f => `formal/${f}`)
}

export const IR_DIR = '.specbridge'

export function saveIR(workspace: string, ir: SemanticIR, meta: Record<string, unknown> = {}) {
  const dir = join(workspace, IR_DIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ir.json'), JSON.stringify(ir, null, 1))
  writeFileSync(join(dir, 'build-meta.json'), JSON.stringify({ builtAt: new Date().toISOString(), ...meta }, null, 1))
}

export function loadIR(workspace: string): SemanticIR | null {
  const f = join(workspace, IR_DIR, 'ir.json')
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
}
