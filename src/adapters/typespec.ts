// TypeSpec adapter: TypeSpec compiler program/type graph (+ @typespec/http for HTTP semantics,
// @typespec/openapi for x-* extensions). Compilation errors abort extraction: unresolved
// libraries/decorators silently change semantics, so partial programs are not trusted.
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import type { Constraint, Direction, Entity, SourceLocation, SourceVersion } from '../ir/types.ts'
import { REPO_ROOT, fileSha, packageVersion, rel } from '../util.ts'
import { type AdapterContext, type AdapterResult, emptyResult, entity, relation } from './common.ts'

const ADAPTER = 'typespec@1'
const require = createRequire(join(REPO_ROOT, 'package.json'))

/** Unit derived from a property name suffix or @encode (deterministic rule TSP-UNIT). */
export function unitFromName(name: string): { unit: string; factor: number } | null {
  if (/(Seconds|Secs|Sec)$|_s$|_seconds$/.test(name)) return { unit: 's', factor: 1 }
  if (/(Millis|Ms|Milliseconds)$|_ms$/.test(name)) return { unit: 's', factor: 0.001 }
  if (/(Minutes|Mins)$/.test(name)) return { unit: 's', factor: 60 }
  if (/(Hours)$/.test(name)) return { unit: 's', factor: 3600 }
  if (/(Bytes)$/.test(name)) return { unit: 'byte', factor: 1 }
  return null
}

const STD: Record<string, string> = {
  integer: 'integer', int8: 'integer', int16: 'integer', int32: 'integer', int64: 'integer', uint8: 'integer', uint16: 'integer', uint32: 'integer', uint64: 'integer', safeint: 'integer',
  numeric: 'number', float: 'number', float32: 'number', float64: 'number', decimal: 'number', decimal128: 'number',
  string: 'string', url: 'string', boolean: 'boolean', utcDateTime: 'datetime', offsetDateTime: 'datetime', plainDate: 'date', plainTime: 'time', duration: 'duration', bytes: 'bytes',
}

export async function extractTypeSpec(mainRel: string, ctx: AdapterContext): Promise<AdapterResult> {
  const main = resolve(ctx.workspace, mainRel)
  const version = packageVersion('@typespec/compiler')
  const res = emptyResult('typespec', version, mainRel, `@typespec/compiler ${version} compile() type graph + @typespec/http getAllHttpServices()`)
  res.source.lossy.push('Template declarations are not extracted (only instantiated/concrete models)', 'Custom decorators other than @minValue/@maxValue/@minLength/@maxLength/@pattern/@format/@encode/@extension are not interpreted')
  const tsp = await import(require.resolve('@typespec/compiler'))
  const http = await import(require.resolve('@typespec/http'))
  let openapi: any = null
  try { openapi = await import(require.resolve('@typespec/openapi')) } catch { /* optional */ }
  let program: any
  try {
    program = await tsp.compile(tsp.NodeHost, main, { noEmit: true })
  } catch (e) {
    res.source.status = 'ERROR'
    res.source.diagnostics.push({ severity: 'error', message: 'TypeSpec compile threw: ' + (e as Error).message })
    return res
  }
  const locOf = (t: any): SourceLocation => {
    try {
      const l = tsp.getSourceLocation(t)
      const p = l.file.getLineAndCharacterOfPosition(l.pos)
      const pe = l.file.getLineAndCharacterOfPosition(l.end)
      return { file: rel(ctx.workspace, l.file.path), line: p.line + 1, column: p.character + 1, endLine: pe.line + 1, locatedBy: 'tool' }
    } catch { return { file: mainRel } }
  }
  for (const d of program.diagnostics) {
    const location = d.target && typeof d.target === 'object' ? (() => { try { return locOf(d.target) } catch { return undefined } })() : undefined
    res.source.diagnostics.push({ severity: d.severity === 'error' ? 'error' : 'warning', message: `${d.code}: ${d.message}`, location })
    if (d.severity === 'error') res.source.status = 'ERROR'
  }
  const inWorkspace = (path: string) => resolve(path).startsWith(resolve(ctx.workspace)) && !path.includes('node_modules')
  for (const [path, sf] of program.sourceFiles ?? []) if (inWorkspace(path)) res.source.files.push({ path: rel(ctx.workspace, path), sha256: fileSha(sf.file?.path ?? path) })
  if (res.source.status === 'ERROR') return res
  const sv = (loc: SourceLocation): SourceVersion => ({ tool: 'typespec', toolVersion: version, fileSha256: res.source.files.find(f => f.path === loc.file)?.sha256, gitRevision: ctx.git.revision, gitDirty: ctx.git.dirty })
  const validation: Entity['validation'] = { status: 'tool-validated', by: 'typespec compile (0 errors)' }
  const name = (t: any) => tsp.getTypeName(t)
  const userType = (t: any) => { const l = locOf(t); return l.line !== undefined && inWorkspace(join(ctx.workspace, l.file)) }
  const ext = (t: any): Record<string, unknown> => {
    if (!openapi) return {}
    const m: Map<string, unknown> = openapi.getExtensions(program, t)
    return Object.fromEntries([...(m ?? new Map()).entries()].filter(([k]) => String(k).startsWith('x-')))
  }
  const scalarName = (t: any): string => {
    let s = t
    while (s && s.kind === 'Scalar' && !STD[s.name] && s.baseScalar) s = s.baseScalar
    return s?.kind === 'Scalar' ? (STD[s.name] ?? s.name) : t?.kind ?? 'unknown'
  }
  const typeDesc = (t: any): { type: string; ref?: any; values?: unknown[] } => {
    if (!t) return { type: 'unknown' }
    if (t.kind === 'Scalar') return { type: scalarName(t) }
    if (t.kind === 'Model' && t.indexer && t.name === 'Array') return { type: 'array', ref: t.indexer.value.kind === 'Model' ? t.indexer.value : undefined }
    if (t.kind === 'Model') return { type: 'model', ref: t }
    if (t.kind === 'Enum') return { type: 'enum', values: [...t.members.values()].map((m: any) => m.value ?? m.name) }
    if (t.kind === 'Union') {
      const vs = [...t.variants.values()].map((v: any) => v.type)
      if (vs.every((v: any) => v.kind === 'String' || v.kind === 'Number' || v.kind === 'Boolean')) return { type: 'literal-union', values: vs.map((v: any) => v.value) }
      return { type: 'union' }
    }
    if (t.kind === 'String' || t.kind === 'Number' || t.kind === 'Boolean') return { type: 'literal', values: [t.value] }
    return { type: t.kind }
  }

  // --- HTTP operations and model usage directions
  const [services] = http.getAllHttpServices(program)
  const usage = new Map<any, Set<Direction>>()
  const markUsage = (t: any, d: Direction, seen = new Set<any>()) => {
    if (!t || seen.has(t)) return
    seen.add(t)
    if (t.kind === 'Model' && t.indexer && t.name === 'Array') return markUsage(t.indexer.value, d, seen)
    if (t.kind === 'Union') { for (const v of t.variants.values()) markUsage((v as any).type, d, seen); return }
    if (t.kind !== 'Model') return
    if (!usage.has(t)) usage.set(t, new Set())
    usage.get(t)!.add(d)
    for (const p of t.properties.values()) markUsage((p as any).type, d, seen)
    if (t.baseModel) markUsage(t.baseModel, d, seen)
  }
  for (const svc of services) {
    const sid = `typespec:service:${tsp.getNamespaceFullName(svc.namespace)}`
    const sloc = locOf(svc.namespace)
    res.entities.push(entity({ id: sid, type: 'Interface', name: tsp.getNamespaceFullName(svc.namespace), tool: 'typespec', source: sloc, version: sv(sloc), method: 'compiler-api', adapter: ADAPTER, validation, attrs: { kind: 'service' } }))
    for (const op of svc.operations) {
      const o = op.operation
      const fqn = name(o)
      const id = `typespec:op:${fqn}`
      const oloc = locOf(o)
      const params = op.parameters.parameters.map((p: any) => ({ name: p.name, in: p.type, optional: !!p.param?.optional, type: typeDesc(p.param?.type).type }))
      const bodyType = op.parameters.body?.type
      const responses = op.responses.map((r: any) => ({ statusCodes: typeof r.statusCodes === 'object' ? `${r.statusCodes.start}-${r.statusCodes.end}` : r.statusCodes, type: r.type ? name(r.type) : null, error: r.type?.kind === 'Model' ? tsp.isErrorModel(program, r.type) : false }))
      const x = ext(o)
      res.entities.push(entity({
        id, type: 'Operation', name: fqn, tool: 'typespec', source: oloc, version: sv(oloc), method: 'compiler-api', adapter: ADAPTER, validation,
        attrs: { verb: op.verb, path: op.path, interface: o.interface ? name(o.interface) : null, params, body: bodyType ? name(bodyType) : null, responses, extensions: x },
      }))
      const container = o.interface ? `typespec:iface:${name(o.interface)}` : sid
      if (o.interface && !res.entities.some(e => e.id === container)) {
        const il = locOf(o.interface)
        res.entities.push(entity({ id: container, type: 'Interface', name: name(o.interface), tool: 'typespec', source: il, version: sv(il), method: 'compiler-api', adapter: ADAPTER, validation, attrs: { kind: 'interface', extensions: ext(o.interface) } }))
        res.relations.push(relation('CONTAINS', sid, container, 'Explicit', 'typespec.namespace.interface', [{ kind: 'source', detail: `${name(o.interface)} in service`, location: il }]))
        const ix = ext(o.interface)
        if (ix['x-specbridge-provider']) for (const c of [ix['x-specbridge-provider']].flat()) res.refs.push({ from: container, ref: String(c), expect: ['component'], relation: 'EXPOSES', reverse: true, rule: 'typespec.extension.x-specbridge-provider', location: il, tool: 'typespec', strict: true })
      }
      res.relations.push(relation('CONTAINS', container, id, 'Explicit', 'typespec.interface.operation', [{ kind: 'source', detail: `${fqn}`, location: oloc }]))
      if (bodyType) { markUsage(bodyType, 'request'); res.refs.push(typeRef(id, bodyType, 'request', oloc)) }
      for (const p of op.parameters.parameters) markUsage(p.param?.type, 'request')
      for (const r of op.responses) if (r.type) { markUsage(r.type, 'response'); res.refs.push(typeRef(id, r.type, 'response', oloc)) }
      for (const rq of [x['x-specbridge-requirements']].flat().filter(Boolean)) res.refs.push({ from: id, ref: String(rq), expect: ['requirement'], relation: 'SATISFIES', rule: 'typespec.extension.x-specbridge-requirements', location: oloc, tool: 'typespec', strict: true })
      for (const c of [x['x-specbridge-provider']].flat().filter(Boolean)) res.refs.push({ from: id, ref: String(c), expect: ['component'], relation: 'EXPOSES', reverse: true, rule: 'typespec.extension.x-specbridge-provider', location: oloc, tool: 'typespec', strict: true })
      // Closed set of declared responses -> ErrorResponse constraint (structured)
      const codes = op.responses.flatMap((r: any) => typeof r.statusCodes === 'number' ? [r.statusCodes] : [])
      const wildcard = op.responses.some((r: any) => typeof r.statusCodes !== 'number')
      res.constraints.push({
        id: `constraint:${id}#TSP-RESPONSES`, kind: 'ErrorResponse', origin: id, tool: 'typespec', trust: 'Explicit', interpretation: 'structured',
        subject: { operation: id, entity: id, direction: 'response' }, params: { status: codes, value: wildcard ? 'wildcard' : 'closed' },
        text: `${fqn} declares responses ${codes.join(', ')}${wildcard ? ' (+ wildcard/range)' : ''}`, source: oloc,
        evidence: [{ kind: 'tool-output', detail: '@typespec/http getAllHttpServices responses', location: oloc }],
      })
    }
  }
  function typeRef(from: string, t: any, direction: Direction, location: SourceLocation) {
    const d = typeDesc(t)
    const target = d.ref ?? (t.kind === 'Union' ? undefined : undefined)
    return { from, ref: target ? name(target) : name(t), expect: ['type' as const], relation: 'REFERENCES' as const, rule: `typespec.operation.${direction}`, location, tool: 'typespec' as const, strict: false, via: direction }
  }

  // --- models / fields / constraints
  const models: any[] = []
  tsp.navigateProgram(program, { model(m: any) { if (m.name && m.name !== 'Array' && userType(m) && !tsp.isTemplateDeclaration(m)) models.push(m) } })
  for (const m of models) {
    const mfqn = name(m)
    const mid = `typespec:type:${mfqn}`
    const mloc = locOf(m)
    const dirs = [...(usage.get(m) ?? new Set<Direction>())]
    const props = [...m.properties.values()]
    res.entities.push(entity({
      id: mid, type: 'DataType', name: mfqn, tool: 'typespec', source: mloc, version: sv(mloc), method: 'compiler-api', adapter: ADAPTER, validation,
      attrs: { concept: m.name, usage: dirs, error: tsp.isErrorModel(program, m), base: m.baseModel ? name(m.baseModel) : null, properties: props.map((p: any) => p.name), extensions: ext(m) },
    }))
    if (m.baseModel) res.refs.push({ from: mid, ref: name(m.baseModel), expect: ['type'], relation: 'EXTENDS', rule: 'typespec.model.extends', location: mloc, tool: 'typespec', strict: false })
    for (const x of [ext(m)['x-specbridge-owner']].flat().filter(Boolean)) res.refs.push({ from: mid, ref: String(x), expect: ['component'], relation: 'OWNS', reverse: true, rule: 'typespec.extension.x-specbridge-owner', location: mloc, tool: 'typespec', strict: true })
    for (const p of props) {
      const fid = `typespec:field:${mfqn}.${p.name}`
      const ploc = locOf(p)
      const td = typeDesc(p.type)
      const enc = tsp.getEncode?.(program, p)
      const u = enc?.encoding === 'seconds' ? { unit: 's', factor: 1 } : enc?.encoding === 'milliseconds' ? { unit: 's', factor: 0.001 } : unitFromName(p.name)
      const lim = {
        min: tsp.getMinValue(program, p) ?? tsp.getMinValueExclusive?.(program, p) ?? null, max: tsp.getMaxValue(program, p) ?? tsp.getMaxValueExclusive?.(program, p) ?? null,
        exclusiveMin: tsp.getMinValueExclusive?.(program, p) !== undefined, exclusiveMax: tsp.getMaxValueExclusive?.(program, p) !== undefined,
        minLength: tsp.getMinLength(program, p) ?? null, maxLength: tsp.getMaxLength(program, p) ?? null, pattern: tsp.getPattern(program, p) ?? null, format: tsp.getFormat(program, p) ?? null,
      }
      res.entities.push(entity({
        id: fid, type: 'Field', name: `${mfqn}.${p.name}`, tool: 'typespec', source: ploc, version: sv(ploc), method: 'compiler-api', adapter: ADAPTER, validation,
        attrs: { model: mid, concept: m.name, field: p.name, optional: !!p.optional, type: td.type, typeRef: td.ref ? name(td.ref) : null, values: td.values ?? null, unit: u?.unit ?? null, unitRule: u ? (enc ? '@encode' : 'TSP-UNIT name suffix') : null, ...lim, extensions: ext(p) },
      }))
      res.relations.push(relation('CONTAINS', mid, fid, 'Explicit', 'typespec.model.property', [{ kind: 'source', detail: `${mfqn}.${p.name}`, location: ploc }]))
      if (td.ref) res.refs.push({ from: fid, ref: name(td.ref), expect: ['type'], relation: 'REFERENCES', rule: 'typespec.property.type', location: ploc, tool: 'typespec', strict: false })
      for (const d of dirs.length ? dirs : (['any'] as Direction[])) {
        const base = { origin: fid, tool: 'typespec' as const, trust: 'Explicit' as const, interpretation: 'structured' as const, subject: { concept: m.name, field: p.name, entity: fid, direction: d }, source: ploc }
        const ev = [{ kind: 'tool-output' as const, detail: `TypeSpec compiler: ${mfqn}.${p.name}${p.optional ? '?' : ''}: ${td.type}`, location: ploc }]
        res.constraints.push({ ...base, id: `constraint:${fid}#TSP-PRESENCE:${d}`, kind: p.optional ? 'Optional' : 'Required', params: {}, text: `${mfqn}.${p.name} is ${p.optional ? 'optional' : 'required'} (${d})`, evidence: ev })
        res.constraints.push({ ...base, id: `constraint:${fid}#TSP-TYPE:${d}`, kind: 'TypeCompatibility', params: { type: td.type }, text: `${mfqn}.${p.name}: ${td.type}`, evidence: ev })
        if (lim.min !== null || lim.max !== null) {
          const f = u?.factor ?? 1
          res.constraints.push({
            ...base, id: `constraint:${fid}#TSP-RANGE:${d}`, kind: 'Range', params: { min: lim.min === null ? null : lim.min * f, max: lim.max === null ? null : lim.max * f, unit: u?.unit ?? null, exclusiveMin: lim.exclusiveMin, exclusiveMax: lim.exclusiveMax },
            text: `${mfqn}.${p.name} in [${lim.min ?? '-inf'}, ${lim.max ?? '+inf'}]${u ? ' ' + u.unit + ' (' + (enc ? '@encode' : 'name suffix') + ')' : ' (unit unknown)'}`, evidence: ev,
          })
        }
      }
    }
  }
  return res
}
