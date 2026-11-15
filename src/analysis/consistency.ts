// Semantic Consistency Engine (spec 7). Deterministic rules over the IR; every finding carries
// the rule id, the constraints/relations compared, source locations and a reproduction command.
import type { SpecBridgeConfig } from '../config.ts'
import { globMatch } from '../config.ts'
import { compareConstraints } from '../constraints/compare.ts'
import type { Constraint, Entity, Evidence, Relation, SemanticIR, Tool } from '../ir/types.ts'
import { facts } from '../link/derive.ts'
import { EntityIndex } from '../link/resolve.ts'
import type { FormalEvidence, FormalResult } from '../verify/formal.ts'
import { formalInputsHash } from '../verify/formal.ts'
import { type Finding, finding, pathBetween } from './findings.ts'

export interface ConsistencyInput {
  ir: SemanticIR
  config: SpecBridgeConfig
  /** Formal evidence from `verify formal`, or null when not executed. */
  formal: FormalEvidence | null
  /** 'reference': explicit-reference integration only (benchmark configuration B); default 'full'. */
  profile?: 'full' | 'reference'
}

const REPRO = (rule: string) => `specbridge analyze consistency --rule ${rule} --format json`
const src = (e: Entity | undefined, detail?: string): Evidence => ({ kind: 'source', detail: detail ?? `${e?.tool} ${e?.type} ${e?.name}`, location: e?.source })
const csrc = (c: Constraint): Evidence => ({ kind: c.interpretation === 'scn-pattern' ? 'rule' : 'source', rule: c.evidence[0]?.rule, detail: `${c.tool} ${c.kind}: ${c.text}`, location: c.source })

export function analyzeConsistency(input: ConsistencyInput): Finding[] {
  const { ir, config } = input
  const idx = new EntityIndex(ir.entities)
  const E = (id: string) => idx.byId.get(id)
  const out: Finding[] = []
  const rels = (type: string) => facts(ir, type)
  const ancestors = (id: string): string[] => { const a: string[] = []; let p = rels('CONTAINS').find(r => r.to === id && r.from.startsWith('likec4:')); while (p) { a.push(p.from); const pf = p.from; p = rels('CONTAINS').find(r => r.to === pf && r.from.startsWith('likec4:')) } return a }
  const related = (a: string, b: string) => a === b || ancestors(a).includes(b) || ancestors(b).includes(a)
  const toolOfRule = (r: Relation): Tool => (r.rule.startsWith('typespec') ? 'typespec' : r.rule.startsWith('likec4') ? 'likec4' : r.rule === 'approved-mapping' ? 'specbridge' : (E(r.from)?.tool ?? 'specbridge'))

  // ---------- tool status
  for (const s of ir.sources) {
    if (s.status === 'ERROR') out.push(finding({ rule: 'TOOL-ERROR', family: 'tool', status: 'ERROR', verdict: 'UNKNOWN', category: 'TOOL_ERROR', message: `${s.tool} extraction failed or reported errors; analyses depending on it are incomplete: ${s.diagnostics.filter(d => d.severity === 'error').map(d => d.message).slice(0, 5).join(' | ')}`, subjects: [`tool:${s.tool}`], tools: [s.tool], evidence: s.diagnostics.filter(d => d.severity === 'error').slice(0, 10).map(d => ({ kind: 'tool-output' as const, detail: d.message, location: d.location })), reproduce: 'specbridge build --format json' }))
  }
  for (const d of ir.diagnostics.filter(d => d.code === 'MAPPING_FILE' || d.code === 'DUPLICATE_ID'))
    out.push(finding({ rule: d.code === 'MAPPING_FILE' ? 'MAP-FILE-INVALID' : 'IR-DUPLICATE-ID', family: 'mapping', status: 'ERROR', verdict: 'UNKNOWN', category: 'INPUT_ERROR', message: d.message, subjects: [d.message], tools: ['specbridge'], evidence: [{ kind: 'source', detail: d.message, location: d.location }], reproduce: 'specbridge build' }))

  // ---------- dangling / ambiguous explicit references
  for (const r of ir.references) {
    const from = E(r.from)
    if (r.status === 'ambiguous') {
      out.push(finding({ rule: 'REF-AMBIGUOUS', family: familyOfRef(r.expect, r.tool), verdict: 'UNKNOWN', category: 'AMBIGUOUS_REFERENCE', message: `'${r.ref}' in ${r.from} matches several entities: ${r.candidates!.join(', ')}; not linked`, subjects: [r.from, r.ref], tools: [r.tool], evidence: [{ kind: 'source', detail: `${r.rule}: ${r.ref}`, location: r.location }], reproduce: REPRO('REF-AMBIGUOUS') }))
      continue
    }
    if (r.status !== 'unresolved') continue
    if (r.strict) {
      const target = r.expect.includes('requirement') ? 'openspec' : r.expect.includes('component') ? 'likec4' : 'typespec'
      out.push(finding({
        rule: r.expect.includes('operation') || r.expect.includes('interface') ? 'AA-DANGLING-OPERATION' : 'REF-DANGLING', family: familyOfRef(r.expect, r.tool), verdict: 'CONFLICT', category: 'DANGLING_REFERENCE',
        message: `${r.tool} declares ${r.relation} '${r.ref}' (${r.rule}) but no ${r.expect.join('/')} with that identifier exists in ${target}`,
        subjects: [r.from, r.ref], tools: [r.tool, target as Tool], evidence: [{ kind: 'source', detail: `${r.rule} = '${r.ref}'`, location: r.location }, src(from)], reproduce: REPRO('AA-DANGLING-OPERATION'),
      }))
    } else if (r.tool === 'openspec') {
      // A backtick reference shaped like Interface.operation whose interface exists but operation does not
      const parts = r.ref.split('.')
      if (parts.length >= 2) {
        const prefix = parts.slice(0, -1).join('.')
        const iface = idx.resolve(prefix, ['interface'])
        const type = idx.resolve(prefix, ['type'])
        if (iface.status === 'resolved') {
          out.push(finding({ rule: 'RC-MISSING-OPERATION', family: 'requirement-contract', verdict: 'CONFLICT', category: 'DANGLING_REFERENCE', message: `requirement references operation '${r.ref}' but TypeSpec interface ${E(iface.target!)!.name} has no operation '${parts.at(-1)}'`, subjects: [r.from, r.ref], tools: ['openspec', 'typespec'], evidence: [{ kind: 'source', detail: `backtick reference \`${r.ref}\``, location: r.location }, src(E(iface.target!))], reproduce: REPRO('RC-MISSING-OPERATION'), path: [] }))
        } else if (type.status !== 'resolved') {
          out.push(finding({ rule: 'REF-UNRESOLVED', family: 'requirement-contract', verdict: 'UNKNOWN', category: 'UNRESOLVED_REFERENCE', message: `requirement mentions \`${r.ref}\`, which matches no TypeSpec/LikeC4 identifier (may be prose)`, subjects: [r.from, r.ref], tools: ['openspec'], evidence: [{ kind: 'source', detail: r.ref, location: r.location }], reproduce: REPRO('REF-UNRESOLVED') }))
        }
      }
    }
  }

  // ---------- approved mappings revalidation
  for (const m of ir.mappings.filter(m => m.status === 'approved')) {
    if (m.validity === 'VALID') continue
    const fam = mappingFamily(m.from, m.to)
    out.push(finding({
      rule: m.validity === 'INVALIDATED' ? 'MAP-DANGLING' : 'MAP-STALE', family: fam, verdict: m.validity === 'INVALIDATED' ? 'CONFLICT' : 'UNKNOWN', category: m.validity === 'INVALIDATED' ? 'DANGLING_MAPPING' : 'MAPPING_STALE',
      message: `approved mapping ${m.id} (${m.from} ${m.type} ${m.to}) is ${m.validity}: ${m.reasons.join('; ')}${m.suggestion ? ' — suggestion (not applied): ' + m.suggestion : ''}`,
      subjects: [m.id, m.from, m.to], tools: [toolOf(m.from), toolOf(m.to), 'specbridge'], evidence: [{ kind: 'mapping', detail: `${m.id}: ${m.reasons.join('; ')}`, location: { file: config.mappings } }], reproduce: 'specbridge build && specbridge mapping list --format json', details: { suggestion: m.suggestion ?? null },
    }))
  }

  if (input.profile === 'reference') return dedupeFindings(out)

  // ---------- Architecture-API: providers
  const providers = new Map<string, Relation[]>()
  for (const r of rels('EXPOSES')) if (E(r.to)?.type === 'Operation') providers.set(r.to, [...(providers.get(r.to) ?? []), r])
  if (config.policies.singleProvider) for (const [op, ps] of providers) {
    const comps = [...new Set(ps.map(p => p.from))]
    const independent = comps.filter(c => !comps.some(o => o !== c && ancestors(c).includes(o)))
    if (independent.length > 1) {
      out.push(finding({
        rule: 'AA-PROVIDER-CONFLICT', family: 'architecture-api', verdict: 'CONFLICT', category: 'OWNERSHIP_MISMATCH',
        message: `operation ${E(op)?.name} has ${independent.length} unrelated providers (${independent.join(', ')}); policy singleProvider requires exactly one`,
        subjects: [op, ...independent.sort()], tools: ['typespec', ...ps.map(toolOfRule)], evidence: [src(E(op)), ...ps.flatMap(p => p.evidence)], reproduce: REPRO('AA-PROVIDER-CONFLICT'),
        path: ps.map(p => ({ from: p.from, relation: p.type, to: p.to, trust: p.trust, rule: p.rule })),
      }))
    }
  }
  // ---------- Architecture-API: communication relation carries an operation the target does not provide
  for (const c of rels('CONSUMES')) {
    const via = c.attrs?.via as string | undefined
    if (!via) continue
    const ps = (providers.get(c.to) ?? []).map(p => p.from)
    const base = { family: 'architecture-api' as const, subjects: [c.from, via, c.to], tools: ['likec4', 'typespec'] as Tool[], reproduce: REPRO('AA-CONSUMER-TARGET') }
    if (!ps.length) out.push(finding({ ...base, rule: 'AA-CONSUMER-TARGET', verdict: 'UNKNOWN', category: 'MISSING_INFORMATION', message: `${c.from} invokes ${E(c.to)?.name} over its relation to ${via}, but no component is declared as provider of that operation`, evidence: c.evidence }))
    else if (!ps.some(p => related(p, via))) out.push(finding({ ...base, rule: 'AA-CONSUMER-TARGET', verdict: 'CONFLICT', category: 'OWNERSHIP_MISMATCH', message: `${c.from} -> ${via} carries ${E(c.to)?.name}, but that operation is provided by ${ps.join(', ')}, not by ${via} (or its parents/children)`, evidence: [...c.evidence, ...(providers.get(c.to) ?? []).flatMap(p => p.evidence)], path: [{ from: c.from, relation: 'CONSUMES', to: c.to, trust: c.trust, rule: c.rule }, ...(providers.get(c.to) ?? []).map(p => ({ from: p.from, relation: 'EXPOSES', to: p.to, trust: p.trust, rule: p.rule }))] }))
    else out.push(finding({ ...base, rule: 'AA-CONSUMER-TARGET', verdict: 'CONSISTENT', category: 'ALIGNED', message: `${c.from} -> ${via} carries ${E(c.to)?.name}, provided by ${ps.join(', ')}`, evidence: c.evidence }))
  }
  // ---------- dependency restrictions (LikeC4 metadata or OpenSpec SCN) vs architecture relations and API consumption
  for (const k of ir.constraints.filter(k => k.kind === 'DependencyRestriction')) {
    const s = k.subject.entity, t = k.params.target
    const fam = k.tool === 'openspec' ? 'requirement-architecture' as const : 'architecture-api' as const
    if (!s || !t || !E(s) || !E(t)) {
      out.push(finding({ rule: 'XS-DEPENDENCY-RESTRICTION', family: fam, verdict: 'UNKNOWN', category: 'UNRESOLVED_REFERENCE', message: `dependency restriction "${k.text}" refers to elements that do not resolve in LikeC4`, subjects: [k.id], constraints: [k.id], tools: [k.tool, 'likec4'], evidence: [csrc(k)], reproduce: REPRO('XS-DEPENDENCY-RESTRICTION') }))
      continue
    }
    const inS = (x: string) => x === s || ancestors(x).includes(s)
    const inT = (x: string) => x === t || ancestors(x).includes(t)
    const direct = rels('DEPENDS_ON').filter(r => inS(r.from) && inT(r.to))
    for (const d of direct) out.push(finding({ rule: 'XS-FORBIDDEN-DEPENDENCY', family: fam, verdict: 'CONFLICT', category: 'CONTRADICTION', message: `architecture relation ${d.from} -> ${d.to} violates "${k.text}"`, subjects: [k.id, d.id], constraints: [k.id], tools: [k.tool, 'likec4'], evidence: [csrc(k), ...d.evidence], path: [{ from: d.from, relation: 'DEPENDS_ON', to: d.to, trust: d.trust, rule: d.rule }], reproduce: REPRO('XS-FORBIDDEN-DEPENDENCY') }))
    const apiDeps = rels('CONSUMES').filter(c => inS(c.from) && (providers.get(c.to) ?? []).some(p => inT(p.from)))
    for (const c of apiDeps) out.push(finding({ rule: 'AA-FORBIDDEN-API-DEPENDENCY', family: 'architecture-api', verdict: 'CONFLICT', category: 'CONTRADICTION', message: `${c.from} consumes ${E(c.to)?.name}, provided by ${(providers.get(c.to) ?? []).map(p => p.from).join(', ')}, which "${k.text}" forbids`, subjects: [k.id, c.id], constraints: [k.id], tools: [k.tool, 'likec4', 'typespec'], evidence: [csrc(k), ...c.evidence, ...(providers.get(c.to) ?? []).flatMap(p => p.evidence)], path: [{ from: c.from, relation: 'CONSUMES', to: c.to, trust: c.trust, rule: c.rule }, ...(providers.get(c.to) ?? []).map(p => ({ from: p.from, relation: 'EXPOSES', to: p.to, trust: p.trust, rule: p.rule }))], reproduce: REPRO('AA-FORBIDDEN-API-DEPENDENCY') }))
    if (!direct.length && !apiDeps.length) out.push(finding({ rule: 'XS-DEPENDENCY-RESTRICTION', family: fam, verdict: 'CONSISTENT', category: 'ALIGNED', message: `no LikeC4 relation or declared API consumption violates "${k.text}" (undeclared runtime calls are outside this check)`, subjects: [k.id], constraints: [k.id], tools: [k.tool, 'likec4'], evidence: [csrc(k)], reproduce: REPRO('XS-DEPENDENCY-RESTRICTION') }))
  }
  // ---------- ownership requirements (OpenSpec SCN-OWNERSHIP) vs declared providers
  for (const k of ir.constraints.filter(k => k.kind === 'Ownership' && k.tool === 'openspec')) {
    const op = k.subject.operation, owner = k.params.owner
    if (!op || !E(op) || !owner) { out.push(finding({ rule: 'XS-OWNERSHIP', family: 'requirement-architecture', verdict: 'UNKNOWN', category: 'UNRESOLVED_REFERENCE', message: `ownership requirement "${k.text}" does not resolve to a TypeSpec operation and LikeC4 component`, subjects: [k.id], constraints: [k.id], tools: ['openspec'], evidence: [csrc(k)], reproduce: REPRO('XS-OWNERSHIP') })); continue }
    const ps = (providers.get(op) ?? []).map(p => p.from)
    const others = ps.filter(p => !related(p, owner))
    const verdict = !ps.length ? 'UNKNOWN' : others.length ? 'CONFLICT' : 'CONSISTENT'
    out.push(finding({ rule: 'XS-OWNERSHIP', family: 'requirement-architecture', verdict, category: verdict === 'CONFLICT' ? 'OWNERSHIP_MISMATCH' : verdict === 'UNKNOWN' ? 'MISSING_INFORMATION' : 'ALIGNED', message: verdict === 'CONFLICT' ? `requirement says ${owner} must be the only provider of ${E(op)!.name}, but it is also/instead provided by ${others.join(', ')}` : verdict === 'UNKNOWN' ? `no provider declared for ${E(op)!.name}` : `${E(op)!.name} is provided only by ${owner}`, subjects: [k.id, op], constraints: [k.id], tools: ['openspec', 'likec4', 'typespec'], evidence: [csrc(k), ...(providers.get(op) ?? []).flatMap(p => p.evidence)], reproduce: REPRO('XS-OWNERSHIP') }))
  }

  // ---------- Requirement-Contract and cross-spec structured constraint comparison
  const tsp = ir.constraints.filter(c => c.tool === 'typespec')
  const als = ir.constraints.filter(c => c.tool === 'alloy' && c.interpretation === 'structured')
  for (const A of ir.constraints.filter(c => c.tool === 'openspec')) {
    const owner = reqOf(A.origin, idx)
    if (A.kind === 'ErrorResponse') {
      const op = A.subject.operation && E(A.subject.operation)?.type === 'Operation' ? A.subject.operation : null
      if (!op) continue // unresolved op handled by RC-MISSING-OPERATION / REF-UNRESOLVED
      const B = tsp.find(c => c.kind === 'ErrorResponse' && c.subject.operation === op)!
      const missing = (A.params.status ?? []).filter(s => !(B.params.status ?? []).includes(s))
      const verdict = !missing.length ? 'CONSISTENT' : B.params.value === 'wildcard' ? 'UNKNOWN' : 'CONFLICT'
      out.push(finding({ rule: 'RC-ERROR-RESPONSE', family: 'requirement-contract', verdict, category: verdict === 'CONFLICT' ? 'CONTRADICTION' : verdict === 'UNKNOWN' ? 'MISSING_INFORMATION' : 'ALIGNED', message: verdict === 'CONFLICT' ? `requirement demands status ${missing.join(', ')} from ${E(op)!.name}, but the contract's closed response set is {${(B.params.status ?? []).join(', ')}}` : verdict === 'UNKNOWN' ? `status ${missing.join(', ')} not declared explicitly; a wildcard/range response may cover it` : `contract declares status ${(A.params.status ?? []).join(', ')}`, subjects: [owner, op], constraints: [A.id, B.id], tools: ['openspec', 'typespec'], evidence: [csrc(A), csrc(B)], path: pathBetween(ir, owner, op), reproduce: REPRO('RC-ERROR-RESPONSE') }))
      continue
    }
    if (!['Required', 'Optional', 'Range', 'TypeCompatibility', 'Cardinality', 'Exclusivity'].includes(A.kind)) continue
    if (!A.subject.fieldKey) {
      if (A.subject.conceptKey) {
        const model = E(A.subject.conceptKey)!
        const verdict = A.kind === 'Required' || (A.kind === 'Cardinality' && (A.params.min ?? 0) >= 1) ? 'CONFLICT' : 'UNKNOWN'
        out.push(finding({ rule: 'RC-FIELD-MISSING', family: 'requirement-contract', verdict, category: verdict === 'CONFLICT' ? 'CONTRADICTION' : 'MISSING_INFORMATION', message: `requirement constrains ${A.subject.concept}.${A.subject.field} (${A.kind}) but TypeSpec model ${model.name} has no property '${A.subject.field}'`, subjects: [owner, A.subject.conceptKey], constraints: [A.id], tools: ['openspec', 'typespec'], evidence: [csrc(A), src(model)], reproduce: REPRO('RC-FIELD-MISSING') }))
      } else out.push(finding({ rule: 'RC-SUBJECT-UNRESOLVED', family: 'requirement-contract', verdict: 'UNKNOWN', category: 'MISSING_INFORMATION', message: `requirement constraint subject ${A.subject.concept}.${A.subject.field} has no counterpart in the API contract`, subjects: [owner, `${A.subject.concept}.${A.subject.field}`], constraints: [A.id], tools: ['openspec'], evidence: [csrc(A)], reproduce: REPRO('RC-SUBJECT-UNRESOLVED') }))
      continue
    }
    const pairs: Array<[Constraint, 'requirement-contract' | 'cross-spec']> = [...tsp.map(b => [b, 'requirement-contract'] as [Constraint, 'requirement-contract']), ...als.map(b => [b, 'cross-spec'] as [Constraint, 'cross-spec'])]
    let rangeCompared = false
    for (const [B, fam] of pairs) {
      if (B.subject.fieldKey !== A.subject.fieldKey) continue
      const cmp = compareConstraints(A, B)
      if (!cmp) {
        if (A.kind === 'Exclusivity' && (B.kind === 'Optional' || B.kind === 'Required' || B.kind === 'Cardinality'))
          out.push(finding({ rule: 'XS-ORTHOGONAL', family: fam, verdict: 'NOT_APPLICABLE', category: 'ORTHOGONAL_KINDS', message: `${A.kind} (uniqueness) and ${B.kind} (presence/cardinality) on ${A.subject.concept}.${A.subject.field} are different properties; not compared as a contradiction`, subjects: [owner, B.origin], constraints: [A.id, B.id], tools: ['openspec', B.tool], evidence: [csrc(A), csrc(B)], reproduce: REPRO('XS-ORTHOGONAL') }))
        continue
      }
      if (A.kind === 'Range' && B.kind === 'Range') rangeCompared = true
      out.push(finding({
        rule: fam === 'cross-spec' ? `XS-${A.kind.toUpperCase()}-${B.kind.toUpperCase()}` : `RC-${A.kind.toUpperCase()}-${B.kind.toUpperCase()}`, family: fam, verdict: cmp.verdict, category: cmp.category,
        message: `${A.subject.concept}.${A.subject.field}: requirement "${A.text}" vs ${B.tool} "${B.text}": ${cmp.reason}`,
        subjects: [owner, B.origin], constraints: [A.id, B.id], tools: ['openspec', B.tool], evidence: [csrc(A), csrc(B)], path: pathBetween(ir, owner, B.origin), reproduce: REPRO(`RC-${A.kind.toUpperCase()}`),
      }))
    }
    if (A.kind === 'Range' && !rangeCompared) {
      const f = E(A.subject.fieldKey)
      if (f?.tool === 'typespec') out.push(finding({ rule: 'RC-RANGE-MISSING', family: 'requirement-contract', verdict: 'UNKNOWN', category: 'MISSING_INFORMATION', message: `requirement bounds ${f.name} ("${A.text}") but the contract states no range for it`, subjects: [owner, f.id], constraints: [A.id], tools: ['openspec', 'typespec'], evidence: [csrc(A), src(f)], reproduce: REPRO('RC-RANGE-MISSING') }))
    }
  }
  // Alloy field multiplicity vs TypeSpec presence (both via approved concept mapping)
  for (const A of als) for (const B of tsp) {
    if (A.subject.fieldKey !== B.subject.fieldKey || !A.subject.fieldKey?.startsWith('typespec:')) continue
    const cmp = compareConstraints(A, B)
    if (!cmp) continue
    out.push(finding({ rule: `XS-ALLOY-${B.kind.toUpperCase()}`, family: 'cross-spec', verdict: cmp.verdict, category: cmp.category, message: `${A.text} (Alloy) vs ${B.text} (TypeSpec): ${cmp.reason}`, subjects: [A.origin, B.origin], constraints: [A.id, B.id], tools: ['alloy', 'typespec'], evidence: [csrc(A), csrc(B)], reproduce: REPRO('XS-ALLOY') }))
  }

  // ---------- requirement linkage / ambiguity
  for (const r of ir.entities.filter(e => e.type === 'Requirement')) {
    const ops = facts(ir).filter(x => (x.from === r.id && x.type === 'REQUIRES' && E(x.to)?.type === 'Operation') || (x.to === r.id && x.type === 'SATISFIES'))
    if (!ops.length) out.push(finding({ rule: 'RC-NOT-LINKED', family: 'requirement-contract', verdict: 'UNKNOWN', category: 'NOT_LINKED', message: `requirement "${r.name}" is not linked to any operation or component (no explicit reference, metadata or approved mapping)`, subjects: [r.id], tools: ['openspec'], evidence: [src(r)], reproduce: REPRO('RC-NOT-LINKED') }))
    const un = (r.attrs.uninterpreted as { text: string; line: number }[]) ?? []
    if (un.length) out.push(finding({ rule: 'REQ-AMBIGUOUS-NL', family: 'requirement-contract', verdict: 'UNKNOWN', category: 'AMBIGUOUS_NL', message: `${un.length} normative statement(s) of "${r.name}" are not in SCN form and were not interpreted: ${un.map(u => `"${u.text}"`).join('; ')}`, subjects: [r.id], tools: ['openspec'], evidence: un.map(u => ({ kind: 'source' as const, detail: u.text, location: { file: r.source.file, line: u.line } })), reproduce: REPRO('REQ-AMBIGUOUS-NL') }))
  }

  // ---------- Requirement-Invariant and Architecture-Invariant (formal evidence)
  const fresh = input.formal && input.formal.inputsHash === formalInputsHash(ir, config) ? input.formal : null
  const staleNote = input.formal && !fresh ? 'formal evidence exists but is STALE (models, mappings or projected architecture changed since it was produced)' : 'formal verification not executed in this run (use `specbridge verify formal`)'
  const results = new Map<string, FormalResult[]>()
  for (const run of fresh?.runs ?? []) for (const res of run.results) {
    const key = run.kind === 'projection' ? `projection:${run.projection}:${res.target}` : `alloy:${run.sourceModel}#assert:${res.target}`
    results.set(key, [...(results.get(key) ?? []), res])
  }
  const verifies = rels('VERIFIES').filter(v => E(v.from)?.type === 'Invariant' && E(v.to)?.type === 'Requirement')
  for (const v of verifies) {
    const inv = E(v.from)!, req = E(v.to)!
    const cmds = rels('VERIFIES').filter(c => c.to === inv.id && E(c.from)?.type === 'Command')
    const proj = config.alloyProjections.find(p => p.assertions.some(a => `alloy:${p.model}#assert:${a}` === inv.id))
    const base = { family: 'requirement-invariant' as const, subjects: [req.id, inv.id], tools: (proj ? ['openspec', 'alloy', 'likec4'] : ['openspec', 'alloy']) as Tool[], path: [{ from: v.from, relation: 'VERIFIES', to: v.to, trust: v.trust, rule: v.rule }] }
    if (!cmds.length && !proj) { out.push(finding({ ...base, rule: 'RI-NOT-EXECUTABLE', status: 'SKIP', verdict: 'UNKNOWN', category: 'NOT_EXECUTED', message: `assertion ${inv.name} is linked to "${req.name}" but the model has no check command for it`, evidence: [src(inv), ...v.evidence], reproduce: REPRO('RI-NOT-EXECUTABLE') })); continue }
    // projected architecture assertions are judged on the concrete LikeC4 projection, not the bare schema
    const rs = (proj ? results.get(`projection:${proj.id}:${inv.name}`) : results.get(inv.id)) ?? []
    if (!fresh || !rs.length) { out.push(finding({ ...base, rule: 'RI-ASSERTION-RESULT', status: 'SKIP', verdict: 'UNKNOWN', category: 'NOT_EXECUTED', message: `assertion ${inv.name} (verifies "${req.name}"): ${staleNote}`, evidence: [src(inv), ...v.evidence], reproduce: 'specbridge verify formal --format json' })); continue }
    const ce = rs.filter(r => r.outcome === 'COUNTEREXAMPLE'), err = rs.filter(r => r.outcome === 'ERROR')
    if (ce.length) out.push(finding({ ...base, rule: 'RI-COUNTEREXAMPLE', status: 'FAIL', verdict: 'CONFLICT', category: 'COUNTEREXAMPLE', message: `Alloy found a counterexample to ${inv.name} (${ce[0].text}); it maps to requirement "${req.name}". Atoms: ${ce[0].counterexample?.atoms.map(a => `${a.atom}${a.entity ? '=' + a.entity : ''}`).join(', ')}`, evidence: [src(inv), ...v.evidence, ...ce.map(c => ({ kind: 'execution' as const, detail: `${c.text}: ${c.outcome}`, reproduce: c.reproduce }))], reproduce: ce[0].reproduce, details: { counterexample: ce[0].counterexample, scope: ce[0].scopes } }))
    else if (err.length) out.push(finding({ ...base, rule: 'RI-ASSERTION-RESULT', status: 'ERROR', verdict: 'UNKNOWN', category: 'TOOL_ERROR', message: `executing ${inv.name} failed: ${err[0].error}`, evidence: [src(inv)], reproduce: err[0].reproduce }))
    else out.push(finding({ ...base, rule: 'RI-ASSERTION-RESULT', verdict: 'CONSISTENT', category: 'BOUNDED_NO_COUNTEREXAMPLE', message: `${inv.name}: ${rs.map(r => r.boundedNote).join(' ')} Linked requirement: "${req.name}".`, evidence: [src(inv), ...rs.map(r => ({ kind: 'execution' as const, detail: `${r.text}: ${r.outcome} (${r.durationMs} ms)`, reproduce: r.reproduce }))], reproduce: rs[0].reproduce, details: { scopes: rs.map(r => ({ command: r.text, scopes: r.scopes, steps: r.steps })) } }))
    // correspondence plausibility: do the assertion's concepts overlap the requirement's constrained concepts?
    const reqCons = ir.constraints.filter(k => reqOf(k.origin, idx) === req.id)
    // contract concepts for behavioural assertions; LikeC4 elements for projected architecture assertions
    const reqConcepts = new Set(proj ? reqCons.flatMap(k => [k.subject.entity, k.params.target, k.params.owner]).filter((x): x is string => !!x && x.startsWith('likec4:')) : reqCons.filter(k => k.subject.conceptKey).map(k => k.subject.conceptKey!))
    const constrained = rels('CONSTRAINS').filter(c => c.from === inv.id)
    const invTsp = new Set(constrained.filter(c => E(c.to)?.tool === 'typespec').map(c => E(c.to)!.type === 'Field' ? String(E(c.to)!.attrs.model) : c.to))
    const invAlloy = new Set(constrained.filter(c => E(c.to)?.tool === 'alloy').map(c => c.to.replace(/#field:([^.]+)\..*$/, '#sig:$1')))
    const invConcepts = new Set(proj ? Object.values(proj.atoms ?? {}).map(f => `likec4:${f}`) : [...invTsp, ...invAlloy])
    const overlap = [...reqConcepts].filter(c => invConcepts.has(c))
    const reqUsesContract = [...reqConcepts].some(c => c.startsWith('typespec:'))
    const cat = overlap.length ? 'STRUCTURAL_OVERLAP' : (!reqConcepts.size || (reqUsesContract && !invTsp.size && !proj)) ? 'CORRESPONDENCE_UNVERIFIED' : 'CORRESPONDENCE_DOUBTFUL'
    out.push(finding({ ...base, rule: 'RI-CORRESPONDENCE', verdict: cat === 'STRUCTURAL_OVERLAP' ? 'CONSISTENT' : 'UNKNOWN', category: cat, message: cat === 'CORRESPONDENCE_UNVERIFIED' ? `none of the sigs/fields used by ${inv.name} has an approved CORRESPONDS_TO mapping to the contract; whether the assertion models "${req.name}" cannot be checked` : cat === 'CORRESPONDENCE_DOUBTFUL' ? `${inv.name} constrains ${[...invConcepts].join(', ')} but "${req.name}" constrains ${[...reqConcepts].join(', ')}: no overlap, the mapping may not model the requirement` : `${inv.name} and "${req.name}" constrain the same concepts (${(overlap.length ? overlap : [...invConcepts]).join(', ')}); structural overlap only — semantic adequacy of the model is not decided automatically`, evidence: [src(inv), src(req)], reproduce: REPRO('RI-CORRESPONDENCE') }))
  }
  // DELEGATED_TO_ALLOY comparisons are settled (boundedly) when the requirement's approved assertions all ran clean
  const cleanReqs = new Set(out.filter(f => f.rule === 'RI-ASSERTION-RESULT' && f.verdict === 'CONSISTENT').map(f => f.subjects[0]))
  const dirtyReqs = new Set(out.filter(f => f.family === 'requirement-invariant' && f.rule !== 'RI-CORRESPONDENCE' && f.verdict !== 'CONSISTENT').map(f => f.subjects[0]))
  for (const f of out) if (f.category === 'DELEGATED_TO_ALLOY' && cleanReqs.has(f.subjects[0]) && !dirtyReqs.has(f.subjects[0])) {
    f.verdict = 'CONSISTENT'; f.category = 'DELEGATED_VERIFIED_BOUNDED'
    f.message += ' — settled within scope: every approved assertion verifying this requirement executed with no counterexample (bounded evidence, see RI-ASSERTION-RESULT)'
  }
  // requirements that need formal backing but have none
  for (const r of ir.entities.filter(e => e.type === 'Requirement')) {
    const why = config.policies.formalVerificationRequired.some(p => globMatch(p, r.id.replace(/^openspec:/, ''))) ? 'policy formalVerificationRequired'
      : ir.constraints.some(k => reqOf(k.origin, idx) === r.id && ['Cardinality', 'Exclusivity', 'StateInvariant'].includes(k.kind)) ? 'states a cardinality/exclusivity/state constraint' : null
    if (!why) continue
    if (!verifies.some(v => v.to === r.id)) out.push(finding({ rule: 'RI-NOT-LINKED', family: 'requirement-invariant', verdict: 'UNKNOWN', category: 'NOT_LINKED', message: `requirement "${r.name}" ${why} but no approved, valid VERIFIES mapping links it to an Alloy assertion`, subjects: [r.id], tools: ['openspec', 'alloy'], evidence: [src(r)], reproduce: REPRO('RI-NOT-LINKED') }))
  }
  // projections (Architecture-Invariant)
  for (const p of config.alloyProjections) {
    const run = fresh?.runs.find(x => x.kind === 'projection' && x.projection === p.id)
    const base = { family: 'architecture-invariant' as const, tools: ['likec4', 'alloy'] as Tool[] }
    if (!run) { out.push(finding({ ...base, rule: 'AI-PROJECTION', subjects: [`projection:${p.id}`], status: 'SKIP', verdict: 'UNKNOWN', category: 'NOT_EXECUTED', message: `architecture projection ${p.id}: ${staleNote}`, evidence: [], reproduce: 'specbridge verify formal --format json' })); continue }
    if (run.status !== 'EXECUTED') {
      const dangling = /does not exist/.test(run.error ?? '')
      out.push(finding({ ...base, rule: dangling ? 'AI-UNKNOWN-COMPONENT' : 'AI-PROJECTION', subjects: [`projection:${p.id}`], status: dangling ? 'FAIL' : run.status === 'SKIPPED' ? 'SKIP' : 'ERROR', verdict: dangling ? 'CONFLICT' : 'UNKNOWN', category: dangling ? 'DANGLING_MAPPING' : 'TOOL_ERROR', message: `architecture projection ${p.id}: ${run.error}`, evidence: [{ kind: 'source', detail: `alloyProjections[${p.id}]`, location: { file: 'specbridge.yaml' } }], reproduce: 'specbridge verify formal --format json' }))
      continue
    }
    for (const res of run.results) {
      const reqs = rels('VERIFIES').filter(v => v.from === `alloy:${p.model}#assert:${res.target}` && v.to.startsWith('openspec:')).map(v => v.to)
      const subj = [`projection:${p.id}:${res.target}`, ...reqs]
      if (res.outcome === 'COUNTEREXAMPLE') {
        const deps = (res.counterexample?.states?.[0]?.fields?.[`${p.sig}.${p.relation}`] ?? []) as string[][]
        const am = new Map(res.counterexample!.atoms.map(a => [a.atom, a.entity]))
        out.push(finding({ ...base, rule: 'AI-PROJECTION-COUNTEREXAMPLE', subjects: subj, verdict: 'CONFLICT', category: 'COUNTEREXAMPLE', message: `LikeC4 architecture violates Alloy assertion ${res.target} (${p.model}); projected relations in the counterexample: ${deps.map(([a, b]) => `${am.get(a) ?? a} -> ${am.get(b) ?? b}`).join(', ')}${reqs.length ? '; linked requirement(s): ' + reqs.join(', ') : ''}`, evidence: [{ kind: 'execution', detail: `${res.text}: COUNTEREXAMPLE`, reproduce: res.reproduce }, ...rels('DEPENDS_ON').filter(r => deps.some(([a, b]) => am.get(a) === r.from && am.get(b) === r.to)).flatMap(r => r.evidence)], reproduce: res.reproduce, details: { counterexample: res.counterexample } }))
      } else if (res.outcome === 'ERROR') out.push(finding({ ...base, rule: 'AI-PROJECTION', subjects: subj, status: 'ERROR', verdict: 'UNKNOWN', category: 'TOOL_ERROR', message: `${res.text}: ${res.error}`, evidence: [], reproduce: res.reproduce }))
      else out.push(finding({ ...base, rule: 'AI-PROJECTION', subjects: subj, verdict: 'CONSISTENT', category: 'BOUNDED_NO_COUNTEREXAMPLE', message: `projected LikeC4 architecture satisfies ${res.target}: ${res.boundedNote}`, evidence: [{ kind: 'execution', detail: `${res.text}: ${res.outcome}`, reproduce: res.reproduce }], reproduce: res.reproduce }))
    }
  }
  return dedupeFindings(out)
}

function dedupeFindings(fs: Finding[]): Finding[] {
  const m = new Map<string, Finding>()
  for (const f of fs) if (!m.has(f.id)) m.set(f.id, f)
  return [...m.values()].sort((a, b) => a.family.localeCompare(b.family) || a.rule.localeCompare(b.rule) || a.id.localeCompare(b.id))
}

export function reqOf(origin: string, idx: EntityIndex): string {
  const e = idx.byId.get(origin)
  return e?.type === 'Scenario' ? String(e.attrs.requirement) : origin
}

function toolOf(id: string): Tool {
  const p = id.split(':')[0].replace(/-.*$/, '')
  return (['openspec', 'likec4', 'typespec', 'alloy', 'oasdiff'].includes(p) ? p : 'specbridge') as Tool
}

function mappingFamily(a: string, b: string): Finding['family'] {
  const t = new Set([toolOf(a), toolOf(b)])
  if (t.has('alloy') && t.has('openspec')) return 'requirement-invariant'
  if (t.has('alloy') && t.has('likec4')) return 'architecture-invariant'
  if (t.has('likec4') && t.has('typespec')) return 'architecture-api'
  if (t.has('openspec') && t.has('typespec')) return 'requirement-contract'
  if (t.has('alloy') && t.has('typespec')) return 'cross-spec'
  return 'mapping'
}

function familyOfRef(expect: string[], tool: Tool): Finding['family'] {
  if (expect.includes('requirement')) return tool === 'typespec' ? 'requirement-contract' : 'requirement-architecture'
  if (tool === 'likec4' || expect.includes('component')) return 'architecture-api'
  return 'requirement-contract'
}
