// SpecBridge Constraint Notation (SCN): a small controlled-language grammar recognised inside
// OpenSpec requirement/scenario text. Only sentences matching these patterns become structured
// constraints; every other normative sentence (SHALL/MUST/...) is kept as "uninterpreted" and
// leads to UNKNOWN, never to a confirmed verdict. Patterns are deterministic (rule ids below).
import type { ConstraintKind, Direction } from '../ir/types.ts'

export interface ScnConstraint {
  rule: string
  kind: ConstraintKind
  ref: string               // backticked subject reference as written (e.g. "ClaimRequest.workerId")
  direction: Direction
  state?: string
  min?: number | null
  max?: number | null
  unit?: string | null
  type?: string
  status?: number[]
  target?: string
  from?: string
  to?: string
  text: string              // the sentence
  offset: number            // character offset of the sentence in the analysed text
}

export interface ScnResult {
  constraints: ScnConstraint[]
  references: { ref: string; offset: number }[]
  uninterpreted: { text: string; offset: number }[]
}

const UNITS: Record<string, [string, number]> = {
  ms: ['s', 0.001], millisecond: ['s', 0.001], milliseconds: ['s', 0.001],
  s: ['s', 1], sec: ['s', 1], secs: ['s', 1], second: ['s', 1], seconds: ['s', 1],
  min: ['s', 60], minute: ['s', 60], minutes: ['s', 60],
  h: ['s', 3600], hour: ['s', 3600], hours: ['s', 3600],
  byte: ['byte', 1], bytes: ['byte', 1], kb: ['byte', 1024], mb: ['byte', 1024 * 1024],
  char: ['char', 1], chars: ['char', 1], character: ['char', 1], characters: ['char', 1],
  item: ['item', 1], items: ['item', 1],
}

export function normalizeUnit(word: string | undefined | null): [string, number] | null {
  if (!word) return null
  return UNITS[word.toLowerCase()] ?? null
}

const TYPE_WORDS: Record<string, string> = {
  integer: 'integer', int: 'integer', string: 'string', text: 'string', boolean: 'boolean', number: 'number', decimal: 'number', timestamp: 'datetime', 'date-time': 'datetime', datetime: 'datetime',
}

const R = String.raw
const REF = R`\x60([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+)\x60`      // `A.b` or `a.b.c`
const NAME = R`\x60([A-Za-z_][\w.\-]*)\x60`                         // `anything`
const MUST = R`(?:MUST|SHALL)`
const NUM = R`(-?\d+(?:\.\d+)?)`
const DIR = R`(?:\s+in\s+(?:the\s+|every\s+|each\s+)?(request|response|storage|stored state)s?)?`
const STATE = R`(?:\s+(?:when|while|whenever)\s+\x60[\w.]+\x60\s+is\s+\x60(\w+)\x60|\s+for\s+(?:every\s+|each\s+)?\x60?\w+\x60?\s+in\s+state\s+\x60(\w+)\x60)?`
const UNIT = R`(?:\s*([A-Za-z]+))?`

function dir(w: string | undefined): Direction {
  if (!w) return 'any'
  if (w.startsWith('request')) return 'request'
  if (w.startsWith('response')) return 'response'
  return 'stored'
}

interface Pattern { rule: string; re: RegExp; build: (m: RegExpMatchArray) => Omit<ScnConstraint, 'text' | 'offset' | 'rule'> | null }

const PATTERNS: Pattern[] = [
  { rule: 'SCN-REQUIRED', re: new RegExp(`${REF}\\s+${MUST}\\s+be\\s+(?:present|provided|required|set)${DIR}${STATE}`, 'i'),
    build: m => ({ kind: 'Required', ref: m[1], direction: dir(m[2]), state: m[3] ?? m[4] }) },
  { rule: 'SCN-OPTIONAL', re: new RegExp(`${REF}\\s+MAY\\s+be\\s+(?:omitted|absent|missing|unset)${DIR}${STATE}`, 'i'),
    build: m => ({ kind: 'Optional', ref: m[1], direction: dir(m[2]), state: m[3] ?? m[4] }) },
  { rule: 'SCN-RANGE-BETWEEN', re: new RegExp(`${REF}\\s+${MUST}\\s+be\\s+between\\s+${NUM}\\s+and\\s+${NUM}${UNIT}${DIR}`, 'i'),
    build: m => range(m[1], +m[2], +m[3], m[4], m[5]) },
  { rule: 'SCN-RANGE-MIN', re: new RegExp(`${REF}\\s+${MUST}\\s+be\\s+(?:at\\s+least|no\\s+less\\s+than)\\s+${NUM}${UNIT}${DIR}`, 'i'),
    build: m => range(m[1], +m[2], null, m[3], m[4]) },
  { rule: 'SCN-RANGE-MAX', re: new RegExp(`${REF}\\s+(?:${MUST}\\s+be\\s+(?:at\\s+most|no\\s+more\\s+than)|${MUST}\\s+NOT\\s+exceed)\\s+${NUM}${UNIT}${DIR}`, 'i'),
    build: m => range(m[1], null, +m[2], m[3], m[4]) },
  { rule: 'SCN-TYPE', re: new RegExp(`${REF}\\s+${MUST}\\s+be\\s+(?:an?\\s+)?(integer|int|string|text|boolean|number|decimal|timestamp|date-time|datetime)\\b${DIR}`, 'i'),
    build: m => ({ kind: 'TypeCompatibility', ref: m[1], direction: dir(m[3]), type: TYPE_WORDS[m[2].toLowerCase()] }) },
  { rule: 'SCN-UNIQUE', re: new RegExp(`${REF}\\s+${MUST}\\s+be\\s+unique`, 'i'),
    build: m => ({ kind: 'Exclusivity', ref: m[1], direction: 'stored' }) },
  { rule: 'SCN-CARDINALITY', re: new RegExp(`(?:each|every)\\s+\\x60(\\w+)\\x60(?:\\s+in\\s+state\\s+\\x60(\\w+)\\x60)?\\s+${MUST}\\s+have\\s+(exactly\\s+one|at\\s+most\\s+one|at\\s+least\\s+one|no)\\s+\\x60(\\w+)\\x60`, 'i'),
    build: m => {
      const q = m[3].toLowerCase().replace(/\s+/g, ' ')
      const [min, max] = q === 'exactly one' ? [1, 1] : q === 'at most one' ? [0, 1] : q === 'at least one' ? [1, null] : [0, 0]
      return { kind: 'Cardinality', ref: `${m[1]}.${m[4]}`, direction: 'stored', state: m[2], min, max }
    } },
  { rule: 'SCN-ERROR-RESPONSE', re: new RegExp(`${REF}\\s+${MUST}\\s+(?:respond|return|fail|reply)\\s+with\\s+(?:status\\s+|HTTP\\s+)?(\\d{3})(?:\\s+or\\s+(\\d{3}))?`, 'i'),
    build: m => ({ kind: 'ErrorResponse', ref: m[1], direction: 'response', status: [+m[2], ...(m[3] ? [+m[3]] : [])] }) },
  { rule: 'SCN-NO-DEPENDENCY', re: new RegExp(`${NAME}\\s+${MUST}\\s+NOT\\s+(?:depend\\s+on|call|communicate\\s+with|use)\\s+${NAME}`, 'i'),
    build: m => ({ kind: 'DependencyRestriction', ref: m[1], direction: 'any', target: m[2] }) },
  { rule: 'SCN-OWNERSHIP', re: new RegExp(`${NAME}\\s+${MUST}\\s+(?:be\\s+the\\s+only\\s+provider\\s+of|exclusively\\s+provide|own)\\s+${REF}`, 'i'),
    build: m => ({ kind: 'Ownership', ref: m[2], direction: 'any', target: m[1] }) },
  { rule: 'SCN-TRANSITION', re: new RegExp(`${REF}\\s+MAY\\s+(?:change|transition)\\s+from\\s+\\x60(\\w+)\\x60\\s+to\\s+\\x60(\\w+)\\x60`, 'i'),
    build: m => ({ kind: 'StateInvariant', ref: m[1], direction: 'stored', from: m[2], to: m[3] }) },
]

function range(ref: string, min: number | null, max: number | null, unitWord: string | undefined, d: string | undefined) {
  let unit: string | null = null
  if (unitWord && !/^(in|for|when|while|and|or)$/i.test(unitWord)) {
    const u = normalizeUnit(unitWord)
    if (!u) return null // unknown unit word: refuse to interpret (stays uninterpreted)
    unit = u[0]
    if (min !== null) min *= u[1]
    if (max !== null) max *= u[1]
  }
  return { kind: 'Range' as const, ref, direction: dir(d), min, max, unit }
}

const NORMATIVE = /\b(SHALL|MUST|SHOULD|REQUIRED|MAY NOT)\b/

/** Split into lines / list items / sentences (on [.!?] + whitespace) while tracking offsets. */
function sentences(text: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = []
  let lineStart = 0
  for (const line of text.split('\n')) {
    const re = /(?<=[.!?])\s+/g
    let start = 0
    const push = (end: number) => {
      const raw = line.slice(start, end)
      const lead = raw.length - raw.trimStart().length
      const t = raw.trim().replace(/^[-*]\s+/, '').replace(/\*\*/g, '')
      if (t) out.push({ text: t, offset: lineStart + start + lead })
    }
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) { push(m.index); start = m.index + m[0].length }
    push(line.length)
    lineStart += line.length + 1
  }
  return out
}

export function parseScn(text: string): ScnResult {
  const res: ScnResult = { constraints: [], references: [], uninterpreted: [] }
  const refRe = /`([A-Za-z_][\w.\-]*)`/g
  let m: RegExpExecArray | null
  while ((m = refRe.exec(text))) res.references.push({ ref: m[1], offset: m.index })
  for (const s of sentences(text)) {
    let matched = false
    for (const p of PATTERNS) {
      const mm = s.text.match(p.re)
      if (!mm) continue
      const c = p.build(mm)
      if (!c) continue
      res.constraints.push({ ...c, rule: p.rule, text: s.text, offset: s.offset })
      matched = true
    }
    if (!matched && NORMATIVE.test(s.text)) res.uninterpreted.push(s)
  }
  return res
}
