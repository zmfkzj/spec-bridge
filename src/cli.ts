import { parseArgs } from 'node:util'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runPipeline } from './pipeline.ts'
import { buildIR, saveIR, IR_DIR } from './ir/build.ts'
import { renderText, type Report } from './report/report.ts'
import { aiProposals, loadProposals, proposeLinks, saveProposals } from './link/proposals.ts'
import { loadMappings, saveMappings, type MappingEntry } from './link/mappings.ts'
import { draftAlloyModel } from './verify/draft.ts'
import { RELATION_TYPES, type RelationType } from './ir/types.ts'
import { SPECBRIDGE_VERSION } from './util.ts'

const HELP = `specbridge ${SPECBRIDGE_VERSION} — Semantic Design Engine for OpenSpec / LikeC4 / TypeSpec / oasdiff / Alloy

Usage: specbridge <command> [options]

  build                              extract all specs into the Semantic IR (.specbridge/ir.json)
  link [--ai]                        propose link candidates (Proposed only; never facts)
  mapping list                       list approved/rejected mappings and their validity
  mapping approve <proposal-id> --by NAME [--rationale TEXT]
  mapping approve --type T --from ID --to ID --by NAME [--rationale TEXT]
  mapping reject  <proposal-id> --by NAME [--rationale TEXT]
  analyze consistency [--rule ID]    cross-spec contradiction analysis (no tool execution)
  analyze impact [--change C] [--base-ref REF | --baseline-dir DIR] [--entity ID]...
  analyze coverage                   five coverage categories
  verify formal                      execute Alloy commands + architecture projections, record evidence
  verify [--change C] [--base-ref REF | --baseline-dir DIR]   integrated verification (formal + oasdiff + analysis)
  formal draft --requirement ID      generate an Alloy DRAFT (excluded from evidence until approved)
  report [--format json|text]        print the last report

Options: -w, --workspace DIR (default .)  --format json|text (default text)  --out FILE  --allow-unknown
Exit codes: 0 CONSISTENT, 1 CONFLICT, 2 ERROR, 3 UNKNOWN/SKIP (0 with --allow-unknown)`

export async function main(argv: string[]): Promise<number> {
  const { values: v, positionals: pos } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      workspace: { type: 'string', short: 'w', default: '.' }, format: { type: 'string', default: 'text' }, out: { type: 'string' },
      change: { type: 'string' }, 'base-ref': { type: 'string' }, 'baseline-dir': { type: 'string' }, entity: { type: 'string', multiple: true },
      rule: { type: 'string' }, ai: { type: 'boolean', default: false }, by: { type: 'string' }, rationale: { type: 'string' },
      type: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, requirement: { type: 'string' }, 'allow-unknown': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    },
  })
  if (v.version) { console.log(SPECBRIDGE_VERSION); return 0 }
  const [cmd, sub, arg] = pos
  if (v.help || !cmd) { console.log(HELP); return cmd ? 0 : 64 }
  const ws = resolve(v.workspace!)
  const emit = (obj: unknown, text: string) => {
    const s = v.format === 'json' ? JSON.stringify(obj, null, 2) : text
    if (v.out) writeFileSync(v.out, s + '\n'); else console.log(s)
  }
  const opts = { workspace: ws, change: v.change ?? null, baseRef: v['base-ref'] ?? null, baselineDir: v['baseline-dir'] ?? null, entities: v.entity ?? [], rule: v.rule ?? null, allowUnknown: v['allow-unknown'] }
  const pipeline = async (c: Parameters<typeof runPipeline>[0]) => { const r = await runPipeline(c, opts); emit(r.report, renderText(r.report)); return r.report.overall.exitCode }

  switch (cmd) {
    case 'build': {
      const { ir, timings } = await buildIR(ws)
      saveIR(ws, ir, { timings })
      const errors = ir.sources.filter(s => s.status === 'ERROR')
      const summary = { schemaVersion: ir.schemaVersion, workspace: ir.workspace, git: ir.git, irFile: join(IR_DIR, 'ir.json'), timingsMs: timings, sources: ir.sources.map(s => ({ tool: s.tool, version: s.toolVersion, status: s.status, files: s.files.length, diagnostics: s.diagnostics })), counts: { entities: ir.entities.length, relations: ir.relations.length, constraints: ir.constraints.length, mappings: ir.mappings.length }, diagnostics: ir.diagnostics }
      emit(summary, `Built Semantic IR: ${ir.entities.length} entities, ${ir.relations.length} relations, ${ir.constraints.length} constraints -> ${join(IR_DIR, 'ir.json')}\n` + ir.sources.map(s => `  ${s.tool}@${s.toolVersion}: ${s.status} (${s.files.length} files)${s.diagnostics.filter(d => d.severity === 'error').map(d => '\n    error: ' + d.message).join('')}`).join('\n'))
      return errors.length ? 2 : 0
    }
    case 'link': {
      const { ir, config } = await buildIR(ws)
      saveIR(ws, ir)
      const mf = loadMappings(join(ws, config.mappings)).data.mappings
      const proposals = proposeLinks(ir, mf)
      const ai = v.ai ? aiProposals(ir) : { provider: null, calls: 0, tokens: null, errors: v.ai ? [] : ['--ai not requested'], proposals: [] }
      const runp = { proposals: [...proposals, ...ai.proposals], ai: { provider: ai.provider, calls: ai.calls, tokens: ai.tokens, errors: ai.errors }, generatedAt: new Date().toISOString() }
      saveProposals(ws, runp)
      emit(runp, `${runp.proposals.length} link proposal(s) (trust=Proposed; NOT used as evidence until approved):\n` + runp.proposals.map(p => `  ${p.id} ${p.type} ${p.from} -> ${p.to} [${p.method} score ${p.score} — ranking signal, not probability]\n      ${p.rationale}`).join('\n') + `\nAI: ${ai.calls} call(s)${ai.provider ? ' via ' + ai.provider : ' (no provider configured)'}\nReview: specbridge mapping approve|reject <proposal-id> --by <name>`)
      return 0
    }
    case 'mapping': return mappingCmd(sub, arg, ws, v, emit)
    case 'analyze':
      if (sub === 'consistency') return pipeline('analyze consistency')
      if (sub === 'impact') return pipeline('analyze impact')
      if (sub === 'coverage') return pipeline('analyze coverage')
      console.error('analyze consistency|impact|coverage'); return 64
    case 'verify':
      return pipeline(sub === 'formal' ? 'verify formal' : 'verify')
    case 'formal': {
      if (sub !== 'draft' || !v.requirement) { console.error('formal draft --requirement <openspec:spec/req-id>'); return 64 }
      const { ir } = await buildIR(ws)
      const r = draftAlloyModel(ir, ws, v.requirement.startsWith('openspec:') ? v.requirement : `openspec:${v.requirement}`)
      emit(r, `Draft written: ${r.draft}\n  status: ${r.status}\n  syntax check: ${r.syntaxCheck.ok ? 'ok' : r.syntaxCheck.error}\n  missing: ${r.missing.join('; ')}\n  review path: ${r.reviewPath.join(' -> ')}`)
      return 0
    }
    case 'report': {
      const f = join(ws, IR_DIR, 'report.json')
      if (!existsSync(f)) { console.error('no report yet: run analyze/verify first'); return 2 }
      const r: Report = JSON.parse(readFileSync(f, 'utf8'))
      emit(r, renderText(r))
      return r.overall.exitCode
    }
    default:
      console.error(`unknown command ${cmd}\n\n${HELP}`)
      return 64
  }
}

async function mappingCmd(sub: string | undefined, arg: string | undefined, ws: string, v: any, emit: (o: unknown, t: string) => void): Promise<number> {
  const { ir, config } = await buildIR(ws)
  const file = join(ws, config.mappings)
  const mf = loadMappings(file)
  if (sub === 'list' || !sub) {
    emit(ir.mappings, ir.mappings.map(m => `${m.id} ${m.status} ${m.validity} ${m.from} ${m.type} ${m.to}${m.reasons.length ? '\n    ' + m.reasons.join('\n    ') : ''}`).join('\n') || 'no mappings')
    return 0
  }
  if (sub !== 'approve' && sub !== 'reject') { console.error('mapping list|approve|reject'); return 64 }
  if (!v.by) { console.error('--by <reviewer> is required: approvals are human decisions'); return 64 }
  let type: RelationType, from: string, to: string, source: string | undefined
  if (arg) {
    const p = loadProposals(ws)?.proposals.find(p => p.id === arg)
    if (!p) { console.error(`proposal ${arg} not found (run specbridge link)`); return 2 }
    ;({ type, from, to } = p); source = `${p.id} (${p.method}, score ${p.score})`
  } else {
    if (!v.type || !v.from || !v.to) { console.error('--type, --from and --to are required'); return 64 }
    if (!(RELATION_TYPES as readonly string[]).includes(v.type)) { console.error(`unknown relation type ${v.type}`); return 64 }
    type = v.type; from = v.from; to = v.to
  }
  const byId = new Map(ir.entities.map(e => [e.id, e]))
  if (sub === 'approve' && (!byId.has(from) || !byId.has(to))) { console.error(`cannot approve: endpoint missing in current IR (${!byId.has(from) ? from : to})`); return 2 }
  const entry: MappingEntry = {
    id: `map-${type.toLowerCase()}-${Math.abs(hash(from + to)).toString(36)}`, type, from, to, status: sub === 'approve' ? 'approved' : 'rejected',
    approvedBy: v.by, approvedAt: new Date().toISOString(), ...(v.rationale ? { rationale: v.rationale } : {}),
    fingerprints: { from: byId.get(from)?.fingerprint, to: byId.get(to)?.fingerprint }, ...(source ? { source } : {}),
  }
  const data = { mappings: [...mf.data.mappings.filter(m => !(m.type === type && m.from === from && m.to === to)), entry] }
  saveMappings(file, data)
  emit(entry, `${entry.status} ${entry.id}: ${from} ${type} ${to} (by ${v.by}) -> ${config.mappings}`)
  return 0
}

function hash(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h }
