// Deterministic comparison of two normalized constraints on the SAME subject.
// A = the stating side (requirement / invariant), B = the design side (contract / model).
// Before comparing kinds we align subject, direction (request/response/stored), state and unit;
// misaligned scope never yields CONFLICT (spec 7.5).
import type { Constraint } from '../ir/types.ts'

export type CompareVerdict = 'CONSISTENT' | 'CONFLICT' | 'UNKNOWN'
export interface Comparison { verdict: CompareVerdict; category: string; reason: string }

const PRESENCE = new Set(['Required', 'Optional', 'Cardinality'])

export function compareConstraints(A: Constraint, B: Constraint): Comparison | null {
  if (!A.subject.fieldKey || A.subject.fieldKey !== B.subject.fieldKey) return null
  const raw = compareKinds(A, B)
  if (!raw) return null
  const dA = A.subject.direction, dB = B.subject.direction
  let scope: string | null = null
  if (!(dA === 'any' || dB === 'any' || dA === dB)) {
    if (dA === 'stored' || dB === 'stored') scope = `direction differs (${dA} vs ${dB}): a ${dB === 'stored' ? 'stored' : dB} representation may legitimately differ from the ${dA} one`
    else return null // request vs response: different subjects in practice
  }
  const sA = A.subject.state, sB = B.subject.state
  if (sA && sB && sA !== sB) return null
  let stateNote: string | null = null
  if (PRESENCE.has(A.kind) || PRESENCE.has(B.kind)) {
    if (sA && !sB && raw.verdict === 'CONFLICT') stateNote = `requirement applies only in state '${sA}' while ${B.tool} does not distinguish states`
    if (!sA && sB && raw.verdict !== 'UNKNOWN') stateNote = `${B.tool} constrains only state '${sB}' while the requirement applies to all states`
  }
  if (scope) return { verdict: 'UNKNOWN', category: 'SCOPE_DIFFERS', reason: `${scope}; raw comparison would be ${raw.verdict} (${raw.reason})` }
  if (stateNote) return { verdict: 'UNKNOWN', category: 'STATE_DIFFERS', reason: `${stateNote}; raw comparison would be ${raw.verdict} (${raw.reason})` }
  return raw
}

const bounds = (c: Constraint): [number, number | null] | null => {
  if (c.kind === 'Required') return [1, 1]
  if (c.kind === 'Optional') return [0, 1]
  if (c.kind === 'Cardinality') return [c.params.min ?? 0, c.params.max ?? null]
  return null
}

function compareKinds(A: Constraint, B: Constraint): Comparison | null {
  const delegated = B.tool === 'alloy'
  if (PRESENCE.has(A.kind) && PRESENCE.has(B.kind)) {
    // "MAY be omitted" is a permission: the design must accept absence.
    if (A.kind === 'Optional') {
      const b = bounds(B)!
      return b[0] >= 1 ? { verdict: 'CONFLICT', category: 'CONTRADICTION', reason: `requirement permits omission but ${B.tool} requires presence (${B.text})` } : { verdict: 'CONSISTENT', category: 'ALIGNED', reason: 'both permit absence' }
    }
    if (A.kind === 'Required' && B.kind === 'Optional') return { verdict: 'CONFLICT', category: 'CONTRADICTION', reason: `requirement demands presence but ${B.tool} declares it optional (${B.text})` }
    const a = bounds(A)!, b = bounds(B)!
    const aMax = a[1] ?? Infinity, bMax = b[1] ?? Infinity
    if (b[0] > aMax || a[0] > bMax) return { verdict: 'CONFLICT', category: 'CONTRADICTION', reason: `cardinality [${a[0]},${fmt(a[1])}] and [${b[0]},${fmt(b[1])}] are disjoint` }
    if (b[0] >= a[0] && bMax <= aMax) return { verdict: 'CONSISTENT', category: 'ALIGNED', reason: `design cardinality [${b[0]},${fmt(b[1])}] is within required [${a[0]},${fmt(a[1])}]` }
    if (delegated) return { verdict: 'UNKNOWN', category: 'DELEGATED_TO_ALLOY', reason: `Alloy declaration [${b[0]},${fmt(b[1])}] is wider than required [${a[0]},${fmt(a[1])}], but facts may restrict it; needs an executed assertion` }
    return { verdict: 'CONFLICT', category: 'CONTRADICTION', reason: `design permits cardinality [${b[0]},${fmt(b[1])}] outside required [${a[0]},${fmt(a[1])}]` }
  }
  if (A.kind === 'Range' && B.kind === 'Range') {
    const ua = A.params.unit ?? null, ub = B.params.unit ?? null
    if (ua && ub && ua !== ub) return { verdict: 'UNKNOWN', category: 'UNIT_MISMATCH', reason: `units differ (${ua} vs ${ub})` }
    if (ua && !ub) return { verdict: 'UNKNOWN', category: 'UNIT_UNKNOWN', reason: `requirement is in '${ua}' but the ${B.tool} field has no derivable unit` }
    if (!ua && ub) return { verdict: 'UNKNOWN', category: 'UNIT_UNKNOWN', reason: `requirement states no unit while the ${B.tool} field is in '${ub}'` }
    const a1 = A.params.min ?? -Infinity, a2 = A.params.max ?? Infinity
    const b1 = B.params.min ?? -Infinity, b2 = B.params.max ?? Infinity
    const u = ua ? ' ' + ua : ''
    if (b1 > a2 || a1 > b2) return { verdict: 'CONFLICT', category: 'CONTRADICTION', reason: `ranges [${a1},${a2}]${u} and [${b1},${b2}]${u} are disjoint` }
    if (b1 >= a1 && b2 <= a2) return { verdict: 'CONSISTENT', category: 'ALIGNED', reason: `design range [${b1},${b2}]${u} is within required [${a1},${a2}]${u}` }
    const looser: string[] = [], silent: string[] = []
    if (b1 < a1) (B.params.min === null || B.params.min === undefined ? silent : looser).push(`minimum ${B.params.min ?? 'unbounded'} < required ${a1}`)
    if (b2 > a2) (B.params.max === null || B.params.max === undefined ? silent : looser).push(`maximum ${B.params.max ?? 'unbounded'} > required ${a2}`)
    if (looser.length) return { verdict: 'CONFLICT', category: 'CONTRACT_PERMITS_VIOLATION', reason: `${B.tool} explicitly accepts values the requirement forbids: ${looser.join('; ')}${u}` }
    return { verdict: 'UNKNOWN', category: 'MISSING_INFORMATION', reason: `${B.tool} does not state a bound: ${silent.join('; ')}` }
  }
  if (A.kind === 'TypeCompatibility' && B.kind === 'TypeCompatibility') {
    const a = A.params.type!, b = B.params.type!
    if (a === b) return { verdict: 'CONSISTENT', category: 'ALIGNED', reason: `both ${a}` }
    if (a === 'number' && b === 'integer') return { verdict: 'CONSISTENT', category: 'ALIGNED', reason: 'integer is a number' }
    if (a === 'string' && (b === 'literal-union' || b === 'enum')) return { verdict: 'CONSISTENT', category: 'ALIGNED', reason: `${b} of string literals` }
    if ((a === 'datetime' && b === 'string') || b === 'union' || b === 'unknown') return { verdict: 'UNKNOWN', category: 'MISSING_INFORMATION', reason: `cannot decide whether ${b} encodes ${a}` }
    return { verdict: 'CONFLICT', category: 'CONTRADICTION', reason: `requirement type ${a} is incompatible with ${B.tool} type ${b}` }
  }
  return null // e.g. Exclusivity vs Optional: uniqueness is not presence
}

const fmt = (n: number | null) => (n === null ? '*' : String(n))
