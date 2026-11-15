import type { Evidence, SemanticIR, Tool } from '../ir/types.ts'
import { fingerprint } from '../util.ts'
import { isFact } from '../link/derive.ts'

export type ExecStatus = 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'
export type Verdict = 'CONSISTENT' | 'CONFLICT' | 'UNKNOWN' | 'NOT_APPLICABLE'
export type Family = 'architecture-api' | 'requirement-contract' | 'architecture-invariant' | 'requirement-invariant' | 'cross-spec' | 'requirement-architecture' | 'mapping' | 'tool' | 'api-compatibility' | 'formal'

export interface PathStep { from: string; relation: string; to: string; trust: string; rule: string }

export interface Finding {
  id: string
  rule: string
  family: Family
  /** Execution status of the check procedure (did it run, did it find a violation). */
  status: ExecStatus
  /** Semantic judgement, independent of execution status. */
  verdict: Verdict
  category: string
  message: string
  subjects: string[]
  constraints?: string[]
  tools: Tool[]
  path?: PathStep[]
  evidence: Evidence[]
  reproduce: string
  details?: Record<string, unknown>
}

export function finding(f: Omit<Finding, 'id' | 'status'> & { status?: ExecStatus }): Finding {
  const status: ExecStatus = f.status ?? (f.verdict === 'CONFLICT' ? 'FAIL' : 'PASS')
  const id = 'F-' + fingerprint({ r: f.rule, s: f.subjects, c: f.constraints ?? [] })
  return { id, status, ...f, tools: [...new Set(f.tools)].sort() as Tool[] }
}

/** Shortest relation path between two entities over fact relations (undirected, bounded). */
export function pathBetween(ir: SemanticIR, from: string, to: string, maxDepth = 5): PathStep[] | undefined {
  if (from === to) return []
  const adj = new Map<string, PathStep[]>()
  for (const r of ir.relations) {
    if (!isFact(r)) continue
    const step = { from: r.from, relation: r.type, to: r.to, trust: r.trust, rule: r.rule }
    if (!adj.has(r.from)) adj.set(r.from, [])
    if (!adj.has(r.to)) adj.set(r.to, [])
    adj.get(r.from)!.push(step)
    adj.get(r.to)!.push(step)
  }
  const prev = new Map<string, PathStep>()
  let frontier = [from]
  const seen = new Set([from])
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next: string[] = []
    for (const n of frontier) for (const s of adj.get(n) ?? []) {
      const m = s.from === n ? s.to : s.from
      if (seen.has(m)) continue
      seen.add(m); prev.set(m, s); next.push(m)
      if (m === to) {
        const path: PathStep[] = []
        let cur = to
        while (cur !== from) { const p = prev.get(cur)!; path.unshift(p); cur = p.from === cur ? p.to : p.from }
        return path
      }
    }
    frontier = next
  }
  return undefined
}
