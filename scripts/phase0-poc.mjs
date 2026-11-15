#!/usr/bin/env node
// Phase 0 feasibility PoC (kept for reproducibility; the engine in src/ supersedes it).
// Links ONE requirement to a LikeC4 component, a TypeSpec operation and an Alloy assertion
// using only the official tool interfaces, executes the assertion, and checks one
// structured requirement constraint against the compiler-derived contract.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ws = resolve(process.argv[2] ?? join(repo, 'examples/phase0'))
const require = createRequire(join(repo, 'package.json'))
const env = { ...process.env, OPENSPEC_TELEMETRY: '0', DO_NOT_TRACK: '1' }
const out = { workspace: ws, steps: [] }
const step = (name, data) => { out.steps.push({ name, ...data }); }

// 1. OpenSpec: official structured CLI output
const osBin = join(repo, 'node_modules/.bin/openspec')
const spec = JSON.parse(execFileSync(osBin, ['show', 'job-claim', '--type', 'spec', '--json', '--no-interactive'], { cwd: ws, env }).toString())
const req = spec.requirements[0]
const reqId = `job-claim/${req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
const md = readFileSync(join(ws, 'openspec/specs/job-claim/spec.md'), 'utf8').split('\n')
const reqLine = md.findIndex(l => l.startsWith(`### Requirement: ${req.name}`)) + 1
const opRef = req.text.match(/`([A-Za-z]+\.[A-Za-z]+)`/)?.[1]
const reqField = req.text.match(/`(\w+)\.(\w+)` MUST be present in request/)
step('openspec', { tool: 'openspec', interface: 'openspec show --json', requirementId: reqId, requirementName: req.name, line: reqLine, operationRef: opRef, requiredField: reqField && `${reqField[1]}.${reqField[2]}` })

// 2. LikeC4: official model API
const { LikeC4 } = await import(require.resolve('likec4'))
const c4 = await LikeC4.fromWorkspace(join(ws, 'architecture'), { printErrors: false, logger: false })
const model = await c4.computedModel()
const comps = [...model.elements()].filter(e => e.$element.metadata?.specbridge_requirements === reqId)
const comp = comps[0]
const loc = c4.languageServices.locate({ element: comp.id })
step('likec4', { tool: 'likec4', interface: 'LikeC4.fromWorkspace().computedModel()', errors: c4.getErrors().length, component: comp.id, provides: comp.$element.metadata.specbridge_provides, line: loc.range.start.line + 1 })

// 3. TypeSpec: compiler program + HTTP library
const tsp = await import(require.resolve('@typespec/compiler'))
const http = await import(require.resolve('@typespec/http'))
const openapi = await import(require.resolve('@typespec/openapi'))
const program = await tsp.compile(tsp.NodeHost, join(ws, 'api/main.tsp'), { noEmit: true })
const errors = program.diagnostics.filter(d => d.severity === 'error')
if (errors.length) throw new Error('TypeSpec errors: ' + errors.map(d => d.message).join('; '))
const [services] = http.getAllHttpServices(program)
const op = services[0].operations.find(o => o.operation.name === comp.$element.metadata.specbridge_provides.split('.').pop())
const ext = openapi.getExtensions(program, op.operation).get('x-specbridge-requirements')
const bodyModel = op.parameters.body.type
const prop = bodyModel.properties.get(reqField[2])
const pl = tsp.getSourceLocation(prop)
step('typespec', { tool: 'typespec', interface: '@typespec/compiler compile() + @typespec/http getAllHttpServices()', operation: `${op.operation.interface.namespace.name}.${op.operation.interface.name}.${op.operation.name}`, verb: op.verb, path: op.path, requirementsExtension: ext, bodyModel: bodyModel.name, property: prop.name, optional: prop.optional, line: pl.file.getLineAndCharacterOfPosition(pl.pos).line + 1 })

// 4. Alloy: official Java API via the SpecBridge bridge
const cp = [join(repo, 'tools/org.alloytools.alloy.dist.jar'), join(repo, 'tools/java-build')].join(':')
const mapping = readFileSync(join(ws, 'specbridge/mappings.yaml'), 'utf8')
const assertName = mapping.match(/#assert:(\w+)/)[1]
const parsed = JSON.parse(execFileSync('java', ['-Dorg.slf4j.simpleLogger.defaultLogLevel=warn', '-cp', cp, 'SpecBridgeAlloy', 'parse', join(ws, 'formal/jobs.als')]).toString())
const assertion = parsed.assertions.find(a => a.name === assertName)
const cmd = parsed.commands.find(c => c.check && c.text.includes(assertName))
const exec = JSON.parse(execFileSync('java', ['-Dorg.slf4j.simpleLogger.defaultLogLevel=warn', '-cp', cp, 'SpecBridgeAlloy', 'exec', join(ws, 'formal/jobs.als'), cmd.label]).toString())
const r = exec.results[0]
step('alloy', { tool: 'alloy', interface: 'CompUtil.parseEverything_fromFile + TranslateAlloyToKodkod.execute_command', alloyVersion: exec.alloyVersion, solver: exec.solver, assertion: assertion.name, line: assertion.pos.line, refs: assertion.refs, command: cmd.text, satisfiable: r.satisfiable, outcome: r.satisfiable ? 'COUNTEREXAMPLE' : 'NO_COUNTEREXAMPLE_WITHIN_SCOPE' })

// 5. Trace + one cross-tool structured check (requirement Required vs contract optional)
out.trace = [`openspec:${reqId}`, `likec4:${comp.id}`, `typespec:${out.steps[2].operation}`, `alloy:${assertion.name}`]
out.traceComplete = out.trace.length === 4 && ext?.includes(reqId) && comp.$element.metadata.specbridge_provides === out.steps[2].operation
out.contradiction = prop.optional ? {
  rule: 'REQ-CONTRACT-REQUIRED-OPTIONAL',
  requirement: { file: 'openspec/specs/job-claim/spec.md', line: reqLine, constraint: `${reqField[1]}.${reqField[2]} required (request)` },
  contract: { file: 'api/main.tsp', line: out.steps[2].line, constraint: `${bodyModel.name}.${prop.name} optional (request body of ${out.steps[2].operation})` },
  path: [`openspec:${reqId}`, 'REQUIRES', `typespec:${out.steps[2].operation}`, 'REFERENCES(request body)', `typespec:${bodyModel.name}.${prop.name}`],
} : null
out.boundedNote = r.satisfiable ? 'Counterexample found' : `No counterexample within scope "${cmd.text}"; this is not a proof of system correctness.`
console.log(JSON.stringify(out, null, 2))
