// OpenSpec adapter: uses the official structured CLI output (openspec list/show/validate --json).
// OpenSpec has no requirement ids; SpecBridge ids are "<capability>/<slug(requirement name)>".
// OpenSpec's JSON carries no positions, so a source locator finds header/sentence lines (marked as such).
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseScn, type ScnConstraint } from '../constraints/scn.ts'
import type { Constraint, Entity, SourceLocation, SourceVersion } from '../ir/types.ts'
import { REPO_ROOT, fileSha, packageVersion, rel, run, slug } from '../util.ts'
import { type AdapterContext, type AdapterResult, emptyResult, entity, relation, type PendingRef } from './common.ts'

const ADAPTER = 'openspec@1'
const BIN = join(REPO_ROOT, 'node_modules/@fission-ai/openspec/bin/openspec.js')
const ENV = { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1', NO_COLOR: '1' }

export interface OsRequirement { name: string; text: string; scenarios: { name: string; rawText: string }[] }
export interface OsDelta { spec: string; operation: 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED'; requirement?: OsRequirement; requirements?: OsRequirement[]; rename?: { from: string; to: string } }

export function openspecCli(root: string, args: string[]): any {
  const noInteractive = args[0] === 'show' || args[0] === 'validate' ? ['--no-interactive'] : []
  const r = run(process.execPath, [BIN, ...args, ...noInteractive], { cwd: root, env: ENV })
  const text = r.stdout.trim()
  try {
    return JSON.parse(text.slice(text.indexOf('{')))
  } catch {
    throw new Error(`openspec ${args.join(' ')} failed (exit ${r.code}): ${(r.stderr || r.stdout).slice(0, 500)}`)
  }
}

export const reqId = (spec: string, name: string) => `openspec:${spec}/${slug(name)}`

function locate(lines: string[], header: string, from = 0): number {
  const i = lines.findIndex((l, k) => k >= from && l.trim() === header.trim())
  return i < 0 ? 0 : i + 1
}

function locateSentence(lines: string[], sentence: string, from: number): number {
  const norm = (s: string) => s.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '').trim()
  const probe = norm(sentence).slice(0, 40)
  const i = lines.findIndex((l, k) => k >= from - 1 && norm(l).includes(probe))
  return i < 0 ? from : i + 1
}

function parseSteps(raw: string) {
  return raw.split('\n').map(l => l.match(/^\s*[-*]\s+\*\*(GIVEN|WHEN|THEN|AND|BUT)\*\*\s+(.*)$/i)).filter(Boolean).map(m => ({ keyword: m![1].toUpperCase(), text: m![2] }))
}

/** Requirement + scenarios + SCN constraints + references, from one OpenSpec requirement block. */
export function requirementToIR(p: {
  spec: string; req: OsRequirement; file: string; relFile: string; version: SourceVersion; validation: Entity['validation']; changeState?: string
}): { entities: Entity[]; constraints: Constraint[]; refs: PendingRef[]; relations: AdapterResult['relations'] } {
  const { spec, req, relFile, version } = p
  const lines = existsSync(p.file) ? readFileSync(p.file, 'utf8').split('\n') : []
  const id = reqId(spec, req.name)
  const line = locate(lines, `### Requirement: ${req.name}`)
  const loc: SourceLocation = { file: relFile, line, locatedBy: 'source-locator' }
  const scn = parseScn(req.text)
  const out = { entities: [] as Entity[], constraints: [] as Constraint[], refs: [] as PendingRef[], relations: [] as AdapterResult['relations'] }
  const scenarioIds: string[] = []
  const allConstraints: { c: ScnConstraint; origin: string; base: number }[] = scn.constraints.map(c => ({ c, origin: id, base: line }))
  const uninterpreted = scn.uninterpreted.map(u => ({ text: u.text, line: locateSentence(lines, u.text, line) }))
  for (const s of req.scenarios) {
    const sid = `${id}#scenario:${slug(s.name)}`
    scenarioIds.push(sid)
    const sline = locate(lines, `#### Scenario: ${s.name}`, line)
    const sscn = parseScn(s.rawText)
    allConstraints.push(...sscn.constraints.map(c => ({ c, origin: sid, base: sline })))
    out.entities.push(entity({
      id: sid, type: 'Scenario', name: s.name, tool: 'openspec', source: { file: relFile, line: sline, locatedBy: 'source-locator' }, version,
      method: 'cli-json', adapter: ADAPTER, validation: p.validation,
      attrs: { requirement: id, steps: parseSteps(s.rawText), rawText: s.rawText, ...(p.changeState ? { changeState: p.changeState } : {}) },
    }))
    out.relations.push(relation('CONTAINS', id, sid, 'Explicit', 'openspec.requirement.scenario', [{ kind: 'source', detail: `#### Scenario: ${s.name}`, location: { file: relFile, line: sline } }]))
    for (const r of sscn.references) out.refs.push(refFor(sid, r.ref, relFile, locateSentence(lines, '`' + r.ref + '`', sline)))
  }
  for (const r of scn.references) out.refs.push(refFor(id, r.ref, relFile, locateSentence(lines, '`' + r.ref + '`', line)))
  const counts = new Map<string, number>()
  for (const { c, origin, base } of allConstraints) {
    const key = `${origin}#${c.rule}:${c.ref}`
    const n = (counts.get(key) ?? 0) + 1
    counts.set(key, n)
    const cl = locateSentence(lines, c.text, base)
    const [concept, ...fieldParts] = c.ref.split('.')
    out.constraints.push({
      id: `constraint:${key}${n > 1 ? ':' + n : ''}`,
      kind: c.kind, origin, tool: 'openspec', trust: 'Derived', interpretation: 'scn-pattern',
      subject: { concept: c.kind === 'ErrorResponse' || c.kind === 'Ownership' || c.kind === 'DependencyRestriction' ? undefined : concept, field: fieldParts.join('.') || undefined, direction: c.direction, state: c.state?.toLowerCase(), ...(c.kind === 'ErrorResponse' || c.kind === 'Ownership' ? { operation: c.ref } : {}) },
      params: { min: c.min, max: c.max, unit: c.unit, type: c.type, status: c.status, target: c.target, ...(c.from ? { value: `${c.from}->${c.to}` } : {}) },
      text: c.text, source: { file: relFile, line: cl, locatedBy: 'source-locator' },
      evidence: [{ kind: 'rule', rule: c.rule, detail: `SCN pattern ${c.rule} matched: "${c.text}"`, location: { file: relFile, line: cl } }],
    })
  }
  out.entities.unshift(entity({
    id, type: 'Requirement', name: req.name, tool: 'openspec', source: loc, version, method: 'cli-json', adapter: ADAPTER, validation: p.validation,
    attrs: { spec, text: req.text, scenarios: scenarioIds, uninterpreted, ...(p.changeState ? { changeState: p.changeState } : {}) },
    semantic: { name: req.name, text: req.text, scenarios: req.scenarios },
  }))
  return out
}

function refFor(from: string, ref: string, file: string, line: number): PendingRef {
  return { from, ref, expect: ['operation', 'component', 'field', 'type', 'interface'], relation: 'REQUIRES', rule: 'openspec.backtick-reference', location: { file, line, locatedBy: 'source-locator' }, tool: 'openspec', strict: false }
}

export function extractOpenSpec(rootRel: string, ctx: AdapterContext): AdapterResult {
  const root = join(ctx.workspace, rootRel)
  const version = packageVersion('@fission-ai/openspec')
  const res = emptyResult('openspec', version, rootRel, 'openspec list/show/validate --json (CLI ' + version + ')')
  res.source.lossy.push('OpenSpec JSON has no source positions; lines located by SpecBridge source-locator', 'Natural-language requirement text is interpreted only through SCN patterns; other normative sentences stay uninterpreted')
  let list: any
  try {
    list = openspecCli(root, ['list', '--specs', '--json'])
    // OpenSpec searches parent directories for a root; refuse to read a foreign root.
    if (!list.root?.path || resolve(list.root.path) !== resolve(root)) throw new Error(`OpenSpec root mismatch: expected ${root}, got ${list.root?.path ?? 'none'} ${JSON.stringify(list.status ?? '')}`)
  } catch (e) {
    res.source.status = 'ERROR'
    res.source.diagnostics.push({ severity: 'error', message: String((e as Error).message) })
    return res
  }
  let validation: any = { items: [] }
  try { validation = openspecCli(root, ['validate', '--all', '--json']) } catch (e) {
    res.source.diagnostics.push({ severity: 'warning', message: 'openspec validate failed: ' + (e as Error).message })
  }
  const vstatus = (id: string, type: string): Entity['validation'] => {
    const it = validation.items?.find((i: any) => i.id === id && i.type === type)
    if (!it) return { status: 'unvalidated' }
    return { status: it.valid ? 'tool-validated' : 'invalid', by: 'openspec validate', messages: it.issues?.map((x: any) => `${x.level}: ${x.message}`) }
  }
  for (const it of validation.items ?? []) {
    for (const iss of it.issues ?? []) res.source.diagnostics.push({ severity: iss.level === 'ERROR' ? 'error' : 'warning', message: `${it.type} ${it.id}: ${iss.path ?? ''} ${iss.message}` })
    if (!it.valid) res.source.status = 'ERROR'
  }
  for (const s of list.specs ?? []) {
    const file = join(root, 'openspec/specs', s.id, 'spec.md')
    const relFile = rel(ctx.workspace, file)
    res.source.files.push({ path: relFile, sha256: fileSha(file) })
    const sv: SourceVersion = { tool: 'openspec', toolVersion: version, fileSha256: fileSha(file), gitRevision: ctx.git.revision, gitDirty: ctx.git.dirty }
    const spec = openspecCli(root, ['show', s.id, '--type', 'spec', '--json'])
    for (const req of spec.requirements ?? []) {
      const r = requirementToIR({ spec: s.id, req, file, relFile, version: sv, validation: vstatus(s.id, 'spec') })
      res.entities.push(...r.entities); res.constraints.push(...r.constraints); res.refs.push(...r.refs); res.relations.push(...r.relations)
    }
  }
  // Active changes are extracted as Change entities (deltas), not merged into the main specs.
  for (const ch of listChanges(root)) {
    const c = loadChange(root, ch)
    const cid = `openspec-change:${ch}`
    const proposal = join(root, 'openspec/changes', ch, 'proposal.md')
    res.entities.push(entity({
      id: cid, type: 'Change', name: c.title ?? ch, tool: 'openspec', source: { file: rel(ctx.workspace, existsSync(proposal) ? proposal : join(root, 'openspec/changes', ch)), line: 1, locatedBy: 'source-locator' },
      version: { tool: 'openspec', toolVersion: version, gitRevision: ctx.git.revision }, method: 'cli-json', adapter: ADAPTER, validation: vstatus(ch, 'change'),
      attrs: { change: ch, deltaCount: c.deltas.length, deltas: c.deltas.map(d => ({ spec: d.spec, operation: d.operation, requirement: d.requirement?.name, rename: d.rename })) },
    }))
    for (const d of c.deltas) {
      const target = d.operation === 'RENAMED' ? reqId(d.spec, d.rename!.from) : reqId(d.spec, d.requirement!.name)
      res.relations.push(relation('CHANGES', cid, target, 'Explicit', `openspec.delta.${d.operation}`, [{ kind: 'tool-output', detail: `openspec show ${ch} --json: ${d.operation} ${d.rename ? d.rename.from + ' -> ' + d.rename.to : d.requirement?.name}` }], { operation: d.operation }))
    }
  }
  return res
}

export function listChanges(root: string): string[] {
  try {
    const l = openspecCli(root, ['list', '--json'])
    return (l.changes ?? []).map((c: any) => c.name ?? c.id).filter(Boolean)
  } catch { return [] }
}

export function loadChange(root: string, change: string): { title?: string; deltas: OsDelta[] } {
  const c = openspecCli(root, ['show', change, '--type', 'change', '--json', '--deltas-only'])
  return { title: c.title, deltas: c.deltas ?? [] }
}
