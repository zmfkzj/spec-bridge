# AI agent and CI integration guide

SpecBridge is designed to be driven by coding agents and CI. The engine's verdicts are
deterministic; an agent may *explain* them and *propose* fixes or links, but must not override them.

## Workflow and approval boundaries

```
change specs (agent or human)            ← agent may edit specs ONLY when its task says so
   │
specbridge build                         automatic
specbridge link [--ai]                   automatic, output = Proposed candidates
   │  ── human decision ──  specbridge mapping approve|reject <id> --by <name>
specbridge analyze consistency|coverage  automatic (no tool execution)
specbridge analyze impact --change C | --base-ref main
specbridge verify [--change C] --base-ref main --format json   automatic, executes Alloy/oasdiff
   │
read report.json → explain findings / propose spec edits → human or agent fixes the SOURCE spec
```

| Step | Automatic | Requires a person |
|---|---|---|
| Extraction, IR, deterministic linking, analysis, verification, impact | ✔ | |
| Approving/rejecting a mapping (`mapping approve/reject --by`) | | ✔ (`--by` is mandatory) |
| Promoting an Alloy draft (remove `SPECBRIDGE-DRAFT`, add to `alloy.models`) | | ✔ |
| Resolving a CONFLICT (editing OpenSpec/LikeC4/TypeSpec/Alloy) | | ✔ or agent with an explicit task |
| Accepting UNKNOWN in CI (`--allow-unknown`) | | ✔ (configuration decision) |

## Rules for agents

Agents MAY: extract candidate constraints (write them as SCN sentences for a human to accept),
propose links via `SPECBRIDGE_AI_COMMAND`, draft Alloy models (`formal draft`), explain findings,
propose conflict resolutions.

Agents MUST NOT: edit `.specbridge/` evidence, write `status: approved` into
`specbridge/mappings.yaml` on their own, treat `Proposed` links or similarity scores as facts,
re-run analysis until a desired verdict appears, describe `NO_COUNTEREXAMPLE_IN_SCOPE` as proof of
correctness, describe Alloy results as implementation correctness, or silently change a source spec
to make a finding disappear.

## JSON contract (schemas/report.schema.json, schemaVersion 1.x)

- `overall.status` (`PASS|FAIL|SKIP|ERROR`), `overall.verdict` (`CONSISTENT|CONFLICT|UNKNOWN|NOT_APPLICABLE`),
  `overall.exitCode`, `overall.reasons`.
- `analysis.findings[]`: `id` (stable hash of rule+subjects+constraints), `rule`, `family`, `status`,
  `verdict`, `category`, `message`, `subjects`, `constraints`, `tools`, `path`, `evidence[].location`,
  `reproduce`. `analysis.introducedByChange` lists finding ids new in the after-change view.
- `verification.checks[]` (what was executed), `verification.formal.runs[].results[]` (command,
  scopes, outcome, counterexample with atoms mapped to IR entities, `boundedNote`, `reproduce`),
  `verification.apiCompatibility` (oasdiff changes mapped to TypeSpec operations, lossy report).
- `impact`: `seeds`, `impacted[]` (`kind` direct/indirect, `path`, `graph` current/baseline),
  `invalidatedMappings`, `revalidation`, `warnings`, `complete`.
- `coverage`: five metrics `{covered,total,ratio|null,uncovered,definition}`.
- `aiUsage`: provider, number of calls, tokens (null when not reported).

Typical agent loop: run `verify --format json`, iterate over `analysis.findings` with
`verdict == "CONFLICT"`, open `evidence[].location` on both sides, propose a change to the
authoritative source (see the "single source" table in the README), re-run once. If the result is
UNKNOWN, report what information is missing instead of retrying.

## Optional AI proposal boundary

`SPECBRIDGE_AI_COMMAND` is any executable; it receives a JSON request on stdin
(`{task, entities:[{id,type,name,text}]}`) and must print
`{"proposals":[{"type","from","to","rationale"}],"usage":{"tokens":n}}`. Output is validated
(endpoints must exist) and stored as `Proposed` in `.specbridge/proposals.json`. No provider is
bundled; in this repository no AI calls were made (the benchmark's case 10 uses a shell stub,
`bench/fixtures/stub-ai.sh`, which is labelled as such).

## CI

`.github/workflows/ci.yml` runs type-check, unit/CLI/scenario tests, the Phase 0 PoC, the benchmark
with a regression gate (`bench/check.ts`) and uploads evidence. A design-gate example job runs
`specbridge verify -w examples/jobs-platform --allow-unknown`. For a real repository:

```yaml
- run: node bin/specbridge.mjs verify -w specs --base-ref origin/main --format json --out specbridge.json
  # fails on CONFLICT (1), ERROR (2) and UNKNOWN (3); add --allow-unknown only as a conscious policy
```
