# Tool interfaces, versions, observations and assumptions (Phase 0 record)

Environment observed on 2026-11-15: Linux x86_64, Node 24.21.0, npm 11.19.0, OpenJDK Temurin 17.0.20,
no Go, no Docker. Repository was a one-line README (no prior stack), so the engine is TypeScript on
Node (TypeSpec and LikeC4 are Node libraries; OpenSpec is a Node CLI) plus a small Java bridge for
Alloy.

## Versions (pinned)

| Tool | Version | How obtained | Integrity |
|---|---|---|---|
| OpenSpec (`@fission-ai/openspec`) | 2.0.0 | npm (package-lock.json) | npm lockfile integrity |
| LikeC4 (`likec4`) | 1.61.0 | npm | lockfile |
| TypeSpec (`@typespec/compiler`, `http`, `openapi`, `openapi3`) | 1.18.0 (`rest` 0.88.0) | npm | lockfile |
| oasdiff | 1.38.0 linux_amd64 | GitHub release tarball (`scripts/setup-tools.sh`) | sha256 `613037fd…ea2da` = release `checksums.txt` |
| Alloy (`org.alloytools.alloy.dist`) | 6.2.0 | Maven Central | sha1 `f3993119…4b9c` = Maven `.sha1` |
| TypeScript (dev, type-check only) | 7.0.2 | npm | lockfile |

## Interfaces used (official, structured)

| Tool | Interface | Why |
|---|---|---|
| OpenSpec | `openspec list --specs --json`, `openspec show <spec> --type spec --json`, `openspec show <change> --type change --json --deltas-only`, `openspec validate --all --json`, `openspec archive <change> --yes` (on a copy, for after-change views) | The package's public JS exports (`dist/index.d.ts`) do not expose the markdown parser; the CLI JSON is the documented structured interface. |
| LikeC4 | `LikeC4.fromWorkspace(dir, {printErrors:false, logger:false})`, `.computedModel()` (elements, relationships, views, deployment), `.getErrors()`, `.languageServices.locate({element|relation|view|deployment})` | Model API = semantic model, not rendered diagrams (docs: https://likec4.dev/tooling/model-api/, fetched 2026-11-15). |
| TypeSpec | `compile(NodeHost, main, {noEmit:true})`, `navigateProgram`, `getTypeName`, `getMinValue/MaxValue/MinLength/MaxLength/Pattern/Format/Encode`, `isErrorModel`, `getSourceLocation`; `@typespec/http` `getAllHttpServices`; `@typespec/openapi` `getExtensions`; `@typespec/openapi3` emitter for OpenAPI | Compiler program / type graph (docs: https://typespec.io/docs/extending-typespec/emitters-basics/). |
| Alloy | Java API: `CompUtil.parseEverything_fromFile`, `Module.getAllReachableUserDefinedSigs/getAllFacts/getAllFunc/getAllAssertions/getAllCommands`, `TranslateAlloyToKodkod.execute_command`, `A4Solution.eval` (per state) — wrapped by `java/SpecBridgeAlloy.java` (JSON output) | Official parser/typechecker and analyzer; signatures confirmed with `javap` against the 6.2.0 jar. |
| oasdiff | `oasdiff breaking <base> <rev> --format json`, `oasdiff changelog <base> <rev> --format json` | JSON output with `id`, `level` (3=ERR, 2=WARN, 1=INFO), `operation`, `path`, `operationId`, source positions. |

## Observations (verified by running the tools)

- OpenSpec `show --json` gives requirement `name`, full `text` (all lines incl. bullet lists), and
  scenarios as `rawText`, but **no source positions** → SpecBridge locates `### Requirement:` /
  `#### Scenario:` headers itself (`locatedBy: source-locator`).
- OpenSpec has **no requirement identifiers**; deltas reference requirements by title; `RENAMED`
  deltas carry `{from, to}` → SpecBridge ids are `<capability>/<slug(title)>` and RENAMED is used for
  identity continuity.
- OpenSpec searches **parent directories** for a root; the adapter rejects a root that differs from
  the configured one. Telemetry is opt-out; SpecBridge always sets `OPENSPEC_TELEMETRY=0`.
- `openspec list` rejects `--no-interactive` while `show/validate` accept it.
- `openspec archive <change> --yes` applies ADDED/MODIFIED/REMOVED/RENAMED deltas to the main specs
  (used only on a copy under `.specbridge/cache/`).
- LikeC4 relation ids are generated hashes (e.g. `1ck9ivq`) → SpecBridge uses
  `DEPENDS_ON:<src>-><tgt>[#n]`. Element metadata values are strings; locations from the language
  services are 0-based (converted to 1-based). Dynamic view edges list the backing model relation ids.
- Deployment nodes require `deploymentNode` kinds in the specification; otherwise LikeC4 reports
  errors — the adapter then refuses to extract (`ERROR`).
- TypeSpec: a missing library import produces diagnostics but `compile` still returns a program with
  silently different semantics (decorators unknown, responses collapsed). Therefore any error
  diagnostic aborts TypeSpec extraction.
- TypeSpec OpenAPI3 emitter keeps `@extension("x-…")` values, emits `operationId` as
  `<Interface>_<op>`; interface grouping is otherwise lost (reported in `lossyReport`).
- Alloy: a model without commands gets an implicit `Run Default` command (ignored by SpecBridge);
  labelled commands print as `Check <label>` — the checked assertion is read from
  `Command.nameExpr`. Field declarations print as `lone this/Worker`, multiplicities are taken from
  that. Temporal models (`var`, `steps`) work with `sat4j` (Alloy's default solver in this jar).
- oasdiff marks `request-property-became-required` as level 3 (breaking) and
  `response-non-success-status-removed` as level 1; making a request property optional is level 1.
  Hence semantic conflicts such as "requirement requires a field the contract made optional" are
  invisible to oasdiff alone (scenario B).

## Assumptions (not verifiable mechanically; documented choices)

- Backticked identifiers in OpenSpec text are author-intended references; they are resolved only by
  exact name or *unique* dotted suffix, otherwise UNKNOWN.
- A TypeSpec property name suffix (`Seconds`, `Minutes`, `Ms`, `Bytes`) or `@encode` gives its unit
  (rule TSP-UNIT, reported as SpecBridge-derived in the lossy report).
- A TypeSpec model used in a request body constrains requests, one used in responses constrains
  responses; unused models are direction `any`.
- Alloy field multiplicity is an upper bound; facts may restrict it (never treated as complete).
- Policy `singleProvider` (one provider per operation) is a configurable default, not a fact.

## Phase 0 PoC result

`node scripts/phase0-poc.mjs` (output in `evidence/phase0-poc.json`) uses only the interfaces above
on `examples/phase0`: requirement `job-claim/exclusive-job-claim` → LikeC4 `jobs.jobService`
(metadata `specbridge_provides`) → TypeSpec `JobApi.Jobs.claimJob` (with `x-specbridge-requirements`)
→ Alloy `NoDoubleAssignment` (approved mapping), executed: *no counterexample for
`check NoDoubleAssignment for 3 but 5 steps`* (bounded). It also found the structured contradiction
"`ClaimRequest.workerId` required in request (OpenSpec, spec.md:10) vs optional (TypeSpec,
main.tsp:15)". Adjustments made after the PoC: unique-suffix resolution for short operation names,
TypeSpec errors abort extraction, Alloy command target via `nameExpr`, OpenSpec root check.
