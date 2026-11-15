# Traceability: requirement → implementation → test → evidence

Checks were executed locally on 2026-11-15 (Node 24.21.0, JDK 17.0.20). The GitHub workflow itself
was **not** run on GitHub (no push was authorized); its steps were executed locally, including a
clean-copy reproduction (`npm ci` → `scripts/setup-tools.sh` → `npm run typecheck` → `npm test` →
PoC) in a scratch directory outside the repository: 29/29 tests passed.

## Assignment requirements

| Id | Implementation | Verified by | Evidence |
|---|---|---|---|
| R1 environment, interfaces, Phase 0 | `docs/interfaces.md`, `scripts/setup-tools.sh` (pinned + checksums), `scripts/phase0-poc.mjs`, `examples/phase0/` | `npm run poc`; `test/ir.test.ts` "Phase 0 trace" | `evidence/phase0-poc.json` |
| R2 Semantic IR | `src/ir/types.ts`, `src/ir/build.ts`, `schemas/ir.schema.json` | `test/ir.test.ts` (metadata, regeneration, trust), `test/cli.test.ts` (schema) | `.specbridge/ir.json` of any workspace |
| R3 adapters | `src/adapters/*.ts`, `java/SpecBridgeAlloy.java`, `src/verify/apicompat.ts` | `test/ir.test.ts`, `test/engine.test.ts` (Alloy), scenario B | `docs/interfaces.md` observations; lossy lists in reports |
| R4 linking | `src/link/resolve.ts`, `mappings.ts`, `derive.ts`, `proposals.ts`, `mapping approve/reject` | `test/ir.test.ts` (proposals, STALE/INVALIDATED, same-name), bench 08–11, 14 | `bench/results/latest.json` |
| R5 consistency | `src/analysis/consistency.ts`, `src/constraints/{scn,compare}.ts` | `test/constraints.test.ts`, scenarios C/E, bench 02–05, 12–13 | `evidence/scenarios/E-spec-contradiction.json` |
| R6 impact | `src/analysis/impact.ts`, `src/workspace/materialize.ts`, `src/pipeline.ts` | `test/engine.test.ts` (impact ×4), scenarios A–C, bench 06/14 | `evidence/scenarios/A-requirement-change.json` |
| R7 formal | `src/verify/formal.ts`, `src/verify/draft.ts` | `test/engine.test.ts` (formal), `test/draft.test.ts`, scenario D, bench 05/07/15 | `evidence/scenarios/D-logical-error.json` |
| R8 CLI/report/coverage | `src/cli.ts`, `src/report/report.ts`, `src/analysis/coverage.ts`, `schemas/report.schema.json` | `test/cli.test.ts`, `test/engine.test.ts` (report) | reports in `evidence/` |
| R9 benchmark | `bench/base`, `bench/cases/*`, `bench/run.ts`, `bench/check.ts` | `npm run bench` (gate ok), `test/cli.test.ts` (case schema, review status) | `bench/results/summary.md`, `latest.json` |
| R10 scenarios/tests | `examples/scenarios/*`, `test/*.test.ts`, `scripts/run-scenarios.ts` | `npm test` (29/29), `npm run typecheck` | `evidence/scenarios/summary.json` |
| R11 deliverables/docs | see table below | review | `docs/` |

## The 16 requested deliverables

| # | Deliverable | Location |
|---|---|---|
| 1 | Executable SpecBridge CLI | `bin/specbridge.mjs`, `src/cli.ts`, `src/pipeline.ts` |
| 2 | OpenSpec / LikeC4 / TypeSpec / Alloy extraction adapters | `src/adapters/openspec.ts`, `likec4.ts`, `typespec.ts`, `alloy.ts`, `java/SpecBridgeAlloy.java` |
| 3 | oasdiff integration adapter | `src/verify/apicompat.ts` |
| 4 | Semantic IR schema | `schemas/ir.schema.json`, `src/ir/types.ts`, `docs/ir.md` |
| 5 | Semantic linking engine | `src/link/` |
| 6 | Consistency analysis engine | `src/analysis/consistency.ts`, `src/constraints/` |
| 7 | Change impact analysis engine | `src/analysis/impact.ts`, `src/workspace/materialize.ts` |
| 8 | Formal verification integration | `src/verify/formal.ts`, `src/verify/draft.ts` |
| 9 | Evidence / provenance tracking | `Entity.evidence/source/version`, `Relation.evidence`, `Finding.evidence/path/reproduce`, `.specbridge/evidence/formal.json` |
| 10 | Unified JSON report | `src/report/report.ts`, `schemas/report.schema.json` |
| 11 | AI agent integration guide | `docs/agent-guide.md` |
| 12 | CI pipeline | `.github/workflows/ci.yml` (steps run locally; not run on GitHub) |
| 13 | Semantic benchmark dataset | `bench/` |
| 14 | Automated tests | `test/` (29 tests), `bench/check.ts` |
| 15 | Installation and usage docs | `README.md`, `docs/usage.md` |
| 16 | Supported scope and limitations | `docs/limitations.md`, `docs/backlog.md` |
