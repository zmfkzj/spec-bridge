// Alloy adapter: official Alloy 6 Java API through java/SpecBridgeAlloy.java (CompUtil parser).
// Alloy formulas are NOT translated into graph facts; facts/assertions are referenced
// (interpretation "alloy-reference") together with the sigs/fields they mention.
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Constraint, SourceLocation, SourceVersion } from '../ir/types.ts'
import { REPO_ROOT, fileSha, rel, run } from '../util.ts'
import { type AdapterContext, type AdapterResult, emptyResult, entity, relation } from './common.ts'

const ADAPTER = 'alloy@1'
export const ALLOY_JAR = process.env.SPECBRIDGE_ALLOY_JAR ?? join(REPO_ROOT, 'tools/org.alloytools.alloy.dist.jar')
const BUILD = join(REPO_ROOT, 'tools/java-build')
const SRC = join(REPO_ROOT, 'java/SpecBridgeAlloy.java')

export function alloyAvailable(): { ok: boolean; reason?: string } {
  if (!existsSync(ALLOY_JAR)) return { ok: false, reason: `Alloy jar not found at ${ALLOY_JAR} (run scripts/setup-tools.sh)` }
  const cls = join(BUILD, 'SpecBridgeAlloy.class')
  if (!existsSync(cls) || statSync(cls).mtimeMs < statSync(SRC).mtimeMs) {
    mkdirSync(BUILD, { recursive: true })
    const r = run('javac', ['-cp', ALLOY_JAR, '-d', BUILD, SRC])
    if (r.code !== 0) return { ok: false, reason: 'javac failed: ' + (r.stderr || r.error) }
  }
  return { ok: true }
}

function bridge(args: string[], timeoutMs = 600_000): any {
  const a = alloyAvailable()
  if (!a.ok) throw new Error(a.reason)
  const r = run('java', ['-Dorg.slf4j.simpleLogger.defaultLogLevel=warn', '-cp', `${ALLOY_JAR}:${BUILD}`, 'SpecBridgeAlloy', ...args], { timeoutMs })
  if (r.code !== 0) throw new Error(`Alloy bridge exited ${r.code}: ${r.stderr.slice(0, 800) || r.error}`)
  return JSON.parse(r.stdout)
}

export const alloyParse = (file: string) => bridge(['parse', file])
export const alloyExec = (file: string, labels: string[] = [], timeoutMs?: number) => bridge(['exec', file, ...labels], timeoutMs)
export const reproduceCommand = (file: string, label: string) => `java -cp tools/org.alloytools.alloy.dist.jar:tools/java-build SpecBridgeAlloy exec ${file} ${label}`

export const alloyId = (file: string, kind: string, name: string) => `alloy:${file}#${kind}:${name}`

const MULT: Record<string, [number, number | null]> = { one: [1, 1], lone: [0, 1], some: [1, null], set: [0, null] }

export function extractAlloy(models: string[], ctx: AdapterContext): AdapterResult {
  const res = emptyResult('alloy', 'unknown', models.join(','), 'Alloy Java API CompUtil.parseEverything_fromFile (via java/SpecBridgeAlloy.java)')
  res.source.lossy.push('Facts, predicates and assertion bodies are kept as Alloy references; only field multiplicities become normalized Cardinality constraints', 'Referenced sigs/fields of formulas are found by scanning the resolved (pretty-printed) expression')
  const a = alloyAvailable()
  if (!a.ok) {
    res.source.status = models.length ? 'ERROR' : 'SKIPPED'
    res.source.diagnostics.push({ severity: models.length ? 'error' : 'info', message: a.reason! })
    return res
  }
  for (const m of models) {
    const abs = resolve(ctx.workspace, m)
    const relFile = rel(ctx.workspace, abs)
    if (!existsSync(abs)) {
      res.source.status = 'ERROR'
      res.source.diagnostics.push({ severity: 'error', message: `Alloy model not found: ${relFile}` })
      continue
    }
    const sha = fileSha(abs)
    res.source.files.push({ path: relFile, sha256: sha })
    let d: any
    try { d = alloyParse(abs) } catch (e) {
      res.source.status = 'ERROR'
      res.source.diagnostics.push({ severity: 'error', message: (e as Error).message })
      continue
    }
    if (!d.ok) {
      res.source.status = 'ERROR'
      res.source.diagnostics.push({ severity: 'error', message: `Alloy ${d.phase} error: ${d.error}`, location: d.pos ? { file: relFile, line: d.pos.line, column: d.pos.column, locatedBy: 'tool' } : undefined })
      continue
    }
    res.source.toolVersion = d.alloyVersion
    for (const w of d.warnings ?? []) res.source.diagnostics.push({ severity: 'warning', message: w })
    const sv: SourceVersion = { tool: 'alloy', toolVersion: d.alloyVersion, fileSha256: sha, gitRevision: ctx.git.revision, gitDirty: ctx.git.dirty }
    const validation = { status: 'tool-validated' as const, by: `Alloy ${d.alloyVersion} parser/typechecker` }
    const loc = (p: any): SourceLocation => p && resolve(p.file) === abs ? { file: relFile, line: p.line, column: p.column, endLine: p.endLine, locatedBy: 'tool' } : { file: relFile }
    const base = { tool: 'alloy' as const, version: sv, method: 'java-api' as const, adapter: ADAPTER, validation }
    const sigIds = new Map<string, string>()
    const children = new Map<string, any[]>()
    for (const s of d.sigs) if (s.parent) children.set(s.parent, [...(children.get(s.parent) ?? []), s])
    for (const s of d.sigs) {
      if (s.pos && resolve(s.pos.file) !== abs) continue // sig from an opened library module
      const id = alloyId(relFile, 'sig', s.name)
      sigIds.set(s.name, id)
      // Rule ALLOY-STATE: a `one sig` extending an abstract sig whose children are all `one sig`s is an enumerated state value.
      const siblings = s.parent ? children.get(s.parent) ?? [] : []
      const parent = d.sigs.find((x: any) => x.name === s.parent)
      const isState = s.one && parent?.abstract && siblings.every((x: any) => x.one && x.fields.length === 0)
      res.entities.push(entity({ ...base, id, type: isState ? 'State' : 'DataType', name: s.name, source: loc(s.pos), attrs: { alloyKind: 'sig', abstract: s.abstract, one: s.one, lone: s.lone, some: s.some, variable: s.variable, parent: s.parent, fields: s.fields.map((f: any) => f.name), ...(isState ? { stateOf: s.parent, rule: 'ALLOY-STATE' } : {}) }, trust: isState ? 'Derived' : 'Explicit' }))
      if (s.parent) res.relations.push(relation('EXTENDS', id, alloyId(relFile, 'sig', s.parent), 'Explicit', 'alloy.sig.extends', [{ kind: 'source', detail: `${s.name} extends ${s.parent}`, location: loc(s.pos) }]))
      for (const f of s.fields) {
        const fid = alloyId(relFile, 'field', `${s.name}.${f.name}`)
        res.entities.push(entity({ ...base, id: fid, type: 'Field', name: `${s.name}.${f.name}`, source: loc(f.pos), attrs: { sig: s.name, field: f.name, decl: f.decl, multiplicity: f.multiplicity, variable: f.variable, concept: s.name } }))
        res.relations.push(relation('CONTAINS', id, fid, 'Explicit', 'alloy.sig.field', [{ kind: 'source', detail: `${s.name}.${f.name}: ${f.decl}`, location: loc(f.pos) }]))
        const mm = f.multiplicity ? MULT[f.multiplicity] : null
        if (mm) {
          res.constraints.push({
            id: `constraint:${fid}#ALLOY-MULT`, kind: 'Cardinality', origin: fid, tool: 'alloy', trust: 'Explicit', interpretation: 'structured',
            subject: { concept: s.name, field: f.name, entity: fid, direction: 'stored' }, params: { min: mm[0], max: mm[1] },
            text: `${s.name}.${f.name}: ${f.decl}${f.variable ? ' (var)' : ''}`, source: loc(f.pos),
            evidence: [{ kind: 'tool-output', detail: `Alloy field declaration multiplicity '${f.multiplicity}' (upper bound; facts may restrict further)`, location: loc(f.pos) }],
          })
        }
      }
    }
    const refRelations = (from: string, refs: string[], rule: string, location: SourceLocation) => {
      for (const r of refs ?? []) {
        const target = r.includes('.') ? alloyId(relFile, 'field', r) : sigIds.get(r)
        if (target) res.relations.push(relation('CONSTRAINS', from, target, 'Explicit', rule, [{ kind: 'source', detail: `formula references ${r}`, location }]))
      }
    }
    for (const f of d.facts) {
      const id = alloyId(relFile, 'fact', f.name.replace(/^this\//, '') || `fact${f.index}`)
      res.entities.push(entity({ ...base, id, type: 'Constraint', name: f.name, source: loc(f.pos), attrs: { alloyKind: 'fact', refs: f.refs } }))
      res.constraints.push(alloyRefConstraint(id, f.name, 'fact', f.refs, loc(f.pos)))
      refRelations(id, f.refs, 'alloy.fact.refs', loc(f.pos))
    }
    for (const f of d.functions) {
      if (f.pos && resolve(f.pos.file) !== abs) continue
      const kind = f.pred && f.primed ? 'Transition' : 'Predicate'
      const id = alloyId(relFile, f.pred ? 'pred' : 'fun', f.name)
      res.entities.push(entity({ ...base, id, type: kind, name: f.name, source: loc(f.pos), attrs: { alloyKind: f.pred ? 'pred' : 'fun', params: f.params, primed: f.primed, refs: f.refs, ...(kind === 'Transition' ? { rule: 'ALLOY-TRANSITION (pred body uses primed relations)' } : {}) }, trust: kind === 'Transition' ? 'Derived' : 'Explicit' }))
      refRelations(id, f.refs, 'alloy.pred.refs', loc(f.pos))
    }
    for (const as of d.assertions) {
      const id = alloyId(relFile, 'assert', as.name)
      res.entities.push(entity({ ...base, id, type: 'Invariant', name: as.name, source: loc(as.pos), attrs: { alloyKind: 'assert', refs: as.refs, body: as.body, model: relFile, modelSha256: sha }, semantic: { name: as.name, body: as.body, refs: as.refs } }))
      res.constraints.push(alloyRefConstraint(id, as.name, 'assert', as.refs, loc(as.pos)))
      refRelations(id, as.refs, 'alloy.assert.refs', loc(as.pos))
    }
    const seen = new Map<string, number>()
    for (const c of d.commands) {
      if (c.label === 'Default' && (!c.target || c.target === 'true') && !c.pos?.file) continue // implicit command Alloy adds to models without commands
      const n = (seen.get(c.label) ?? 0) + 1
      seen.set(c.label, n)
      const id = alloyId(relFile, 'cmd', n > 1 ? `${c.label}~${n}` : c.label)
      const target: string | undefined = c.target ?? c.text.match(/^(?:Check|Run)\s+(\w+)/)?.[1]
      res.entities.push(entity({ ...base, id, type: 'Command', name: c.label, source: loc(c.pos), attrs: { check: c.check, text: c.text, overall: c.overall, bitwidth: c.bitwidth, maxseq: c.maxseq, steps: c.maxprefix, scopes: c.scopes, expects: c.expects, target, model: relFile } }))
      if (target) {
        const t = c.check ? alloyId(relFile, 'assert', target) : alloyId(relFile, 'pred', target)
        res.relations.push(relation(c.check ? 'VERIFIES' : 'REFERENCES', id, t, 'Explicit', c.check ? 'alloy.command.check' : 'alloy.command.run', [{ kind: 'source', detail: c.text, location: loc(c.pos) }]))
      }
    }
  }
  return res
}

function alloyRefConstraint(id: string, name: string, kind: string, refs: string[], source: SourceLocation): Constraint {
  return {
    id: `constraint:${id}`, kind: 'StateInvariant', origin: id, tool: 'alloy', trust: 'Explicit', interpretation: 'alloy-reference',
    subject: { direction: 'stored' }, params: { alloyRef: `${kind} ${name}` }, text: `Alloy ${kind} ${name} over ${refs.join(', ')}`, source,
    evidence: [{ kind: 'source', detail: `Alloy ${kind} ${name} (formula retained in source)`, location: source }],
  }
}
