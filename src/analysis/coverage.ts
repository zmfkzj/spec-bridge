// Coverage (spec 11): which analysis targets are linked / verified. Not a quality score.
// A ratio is null when its denominator is 0 ("no targets"), never 100%.
import type { SpecBridgeConfig } from '../config.ts'
import { globMatch } from '../config.ts'
import type { SemanticIR } from '../ir/types.ts'
import { facts } from '../link/derive.ts'
import type { Finding } from './findings.ts'
import { formalInputsHash, type FormalEvidence } from '../verify/formal.ts'

export interface CoverageMetric { covered: number; total: number; ratio: number | null; uncovered: string[]; definition: string; note?: string }
export interface CoverageReport {
  requirementTraceability: CoverageMetric
  apiContractLinkage: CoverageMetric
  architectureLinkage: CoverageMetric
  invariantVerification: CoverageMetric & { linked: number; executed: number }
  executedVerification: CoverageMetric & { planned: string[]; executed: string[]; skipped: string[]; errored: string[] }
}

const metric = (covered: string[], all: string[], definition: string): CoverageMetric => ({
  covered: covered.length, total: all.length, ratio: all.length ? Math.round((covered.length / all.length) * 1000) / 1000 : null,
  uncovered: all.filter(a => !covered.includes(a)), definition, ...(all.length ? {} : { note: 'no analysis targets of this kind: ratio is undefined, not 100%' }),
})

export function computeCoverage(ir: SemanticIR, config: SpecBridgeConfig, formal: FormalEvidence | null, extraChecks: Finding[] = []): CoverageReport {
  const f = facts(ir)
  const type = (id: string) => ir.entities.find(e => e.id === id)?.type
  const tool = (id: string) => ir.entities.find(e => e.id === id)?.tool
  const reqs = ir.entities.filter(e => e.type === 'Requirement').map(e => e.id)
  const ops = ir.entities.filter(e => e.type === 'Operation').map(e => e.id)
  const comps = ir.entities.filter(e => e.tool === 'likec4' && e.type === 'Component' && !['actor', 'person', 'user'].includes(String(e.attrs.kind))
    && !ir.relations.some(r => r.type === 'CONTAINS' && r.from === e.id)).map(e => e.id)

  const reqLinked = reqs.filter(r => f.some(x => (x.from === r && (x.type === 'REQUIRES' || x.type === 'REFERENCES') && (type(x.to) === 'Operation' || tool(x.to) === 'likec4')) || (x.to === r && x.type === 'SATISFIES')))
  const opReq = (o: string) => f.some(x => (x.type === 'REQUIRES' && x.to === o) || (x.type === 'SATISFIES' && x.from === o))
  const opComp = (o: string) => f.some(x => (x.type === 'EXPOSES' || x.type === 'CONSUMES') && x.to === o)
  const opLinked = ops.filter(o => opReq(o) && opComp(o))
  const compLinked = comps.filter(c => f.some(x => x.from === c && ['EXPOSES', 'CONSUMES', 'SATISFIES', 'IMPLEMENTS'].includes(x.type)))

  const needsFormal = reqs.filter(r => config.policies.formalVerificationRequired.some(p => globMatch(p, r.replace(/^openspec:/, '')))
    || ir.constraints.some(k => (k.origin === r || k.origin.startsWith(r + '#')) && ['Cardinality', 'Exclusivity', 'StateInvariant'].includes(k.kind)))
  const fresh = formal && formal.inputsHash === formalInputsHash(ir, config) ? formal : null
  // explicit runs and architecture projections both attribute results to the source model's assertion
  const resultsFor = (assertId: string) => (fresh?.runs ?? []).flatMap(r => r.results.filter(x => x.check && `alloy:${r.sourceModel}#assert:${x.target}` === assertId))
  const verifies = (r: string) => f.filter(x => x.type === 'VERIFIES' && x.to === r && type(x.from) === 'Invariant').map(x => x.from)
  const linked = needsFormal.filter(r => verifies(r).length)
  const executed = linked.filter(r => verifies(r).some(a => resultsFor(a).length && resultsFor(a).every(x => x.outcome !== 'ERROR')))
  const verifiedClean = executed.filter(r => verifies(r).every(a => resultsFor(a).length && resultsFor(a).every(x => x.outcome === 'NO_COUNTEREXAMPLE_IN_SCOPE')))

  const planned: string[] = [], exe: string[] = [], skipped: string[] = [], errored: string[] = []
  for (const c of ir.entities.filter(e => e.type === 'Command' && e.attrs.check)) {
    planned.push(c.id)
    const rs = (fresh?.runs ?? []).flatMap(r => r.results).filter(x => x.commandId === c.id)
    if (!rs.length) skipped.push(c.id)
    else if (rs.some(x => x.outcome === 'ERROR')) errored.push(c.id)
    else exe.push(c.id)
  }
  for (const p of config.alloyProjections) for (const a of p.assertions) {
    const id = `projection:${p.id}#specbridge_${a}`
    planned.push(id)
    const run = fresh?.runs.find(r => r.projection === p.id)
    const rs = run?.results.filter(x => x.commandId === id) ?? []
    if (!run || run.status === 'SKIPPED') skipped.push(id)
    else if (run.status === 'ERROR' || rs.some(x => x.outcome === 'ERROR') || !rs.length) errored.push(id)
    else exe.push(id)
  }
  for (const c of extraChecks) { planned.push(c.id); (c.status === 'SKIP' ? skipped : c.status === 'ERROR' ? errored : exe).push(c.id) }
  const ex = metric(exe, planned, 'executed verification checks (Alloy check commands, architecture projections, API compatibility) / planned checks')
  return {
    requirementTraceability: metric(reqLinked, reqs, 'requirements with an Explicit/Derived link to an operation or architecture element / all requirements'),
    apiContractLinkage: metric(opLinked, ops, 'operations linked to at least one requirement AND one architecture component / all operations'),
    architectureLinkage: metric(compLinked, comps, 'leaf LikeC4 components (excluding actors) linked to an operation or requirement / all leaf components'),
    invariantVerification: { ...metric(verifiedClean, needsFormal, 'requirements needing formal backing (policy or cardinality/exclusivity/state constraints) whose VERIFIES-linked assertions executed with no counterexample within scope / requirements needing formal backing'), linked: linked.length, executed: executed.length },
    executedVerification: { ...ex, planned, executed: exe, skipped, errored },
  }
}
