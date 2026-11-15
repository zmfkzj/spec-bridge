# Architecture

```
CLI (bin/specbridge.mjs, src/cli.ts)  ── JSON report (schemas/report.schema.json) ──> CI / agents / developers
        │
src/pipeline.ts      build → link → (verify: Alloy, oasdiff) → analyze → impact → coverage → report
        │
Analysis   src/analysis/consistency.ts  impact.ts  coverage.ts   src/constraints/compare.ts
Verification  src/verify/formal.ts (Alloy + LikeC4 projection)  apicompat.ts (TypeSpec→OpenAPI→oasdiff)  draft.ts
        │
Semantic IR   src/ir/types.ts  build.ts   (.specbridge/ir.json; schemas/ir.schema.json)
        │
Linking    src/link/resolve.ts (explicit/unique-suffix)  mappings.ts (approved, revalidated)  derive.ts (rules)  proposals.ts
        │
Extraction src/adapters/openspec.ts  likec4.ts  typespec.ts  alloy.ts (+ java/SpecBridgeAlloy.java)   src/constraints/scn.ts
        │
OpenSpec CLI --json │ LikeC4 model API │ TypeSpec compiler + @typespec/http │ Alloy 6 Java API │ oasdiff --format json
```

## Data flow

1. **Extraction** — each adapter calls the tool's official structured interface, records the source
   file/position, tool version, file hash, git revision, extraction method, validation status and the
   information it cannot represent (`lossy`). Extraction with tool errors is marked `ERROR`; TypeSpec
   and LikeC4 programs with errors are *not* extracted because unresolved libraries change semantics.
2. **Linking** (order of spec §6.1): explicit ids → approved mappings (revalidated against entity
   fingerprints) → structurally verifiable references (unique dotted suffix) → deterministic rules
   (`D-*`, Derived) → proposals (heuristic / optional AI command, stored outside the IR).
3. **Constraint normalization** — SCN sentences (OpenSpec), compiler facts (TypeSpec optionality,
   bounds, types, declared responses), LikeC4 metadata restrictions, Alloy field multiplicities.
   Each constraint gets a canonical subject (`conceptKey`, `fieldKey`), direction
   (request/response/stored/any), optional state, and normalized unit.
4. **Analysis** — rule families below. Findings carry rule id, family, execution status, verdict,
   category, compared constraints, relation path, source locations and a reproduction command.
5. **Verification** — Alloy commands of explicit models; deterministic LikeC4→Alloy projections;
   oasdiff between baseline and current OpenAPI emitted by the official TypeSpec emitter.
6. **Impact** — typed propagation over baseline ∪ current graphs (see [ir.md](ir.md#impact)).
7. **Report** — status vs verdict, coverage, impact, limitations, AI usage.

## Rule catalogue

| Family | Rule | Verdicts | Tools contributing |
|---|---|---|---|
| tool | `TOOL-ERROR` | ERROR/UNKNOWN | any |
| reference | `AA-DANGLING-OPERATION`, `REF-DANGLING` (strict metadata/extension references) | CONFLICT | likec4/typespec + target tool |
| reference | `RC-MISSING-OPERATION` (OpenSpec names `Iface.op` of an existing interface that lacks `op`) | CONFLICT | openspec, typespec |
| reference | `REF-AMBIGUOUS`, `REF-UNRESOLVED` | UNKNOWN | – |
| mapping | `MAP-DANGLING` (approved endpoint missing; rename/move suggestion, never applied) | CONFLICT | specbridge + endpoint tools |
| mapping | `MAP-STALE` (endpoint fingerprint changed since approval) | UNKNOWN | " |
| architecture–API | `AA-PROVIDER-CONFLICT` (unrelated providers vs singleProvider policy) | CONFLICT | likec4, typespec |
| architecture–API | `AA-CONSUMER-TARGET` (relationship carries an op its target does not provide) | CONFLICT / UNKNOWN (no provider declared) / CONSISTENT | likec4, typespec |
| architecture–API | `AA-FORBIDDEN-API-DEPENDENCY` (consumes an op provided by a forbidden component) | CONFLICT | likec4, typespec (+openspec) |
| requirement–architecture | `XS-FORBIDDEN-DEPENDENCY`, `XS-DEPENDENCY-RESTRICTION`, `XS-OWNERSHIP` | CONFLICT / CONSISTENT / UNKNOWN | openspec, likec4 (+typespec) |
| requirement–contract | `RC-<A>-<B>` structured comparisons (Required/Optional/Cardinality/Range/Type), `RC-ERROR-RESPONSE`, `RC-FIELD-MISSING` | CONFLICT / CONSISTENT / UNKNOWN | openspec, typespec |
| requirement–contract | `RC-RANGE-MISSING`, `RC-SUBJECT-UNRESOLVED`, `RC-NOT-LINKED`, `REQ-AMBIGUOUS-NL` | UNKNOWN | openspec (+typespec) |
| cross-spec | `XS-<A>-<B>` requirement vs Alloy multiplicity; `XS-ALLOY-<K>` Alloy vs TypeSpec (via approved CORRESPONDS_TO); `XS-ORTHOGONAL` | CONFLICT / UNKNOWN (scope/state/unit/delegated) / NOT_APPLICABLE | openspec/alloy/typespec |
| requirement–invariant | `RI-NOT-LINKED`, `RI-NOT-EXECUTABLE`, `RI-ASSERTION-RESULT`, `RI-COUNTEREXAMPLE`, `RI-CORRESPONDENCE` | UNKNOWN / SKIP / CONSISTENT(bounded) / CONFLICT | openspec, alloy (+likec4 for projections) |
| architecture–invariant | `AI-PROJECTION`, `AI-PROJECTION-COUNTEREXAMPLE`, `AI-UNKNOWN-COMPONENT` | CONSISTENT(bounded) / CONFLICT | likec4, alloy |
| api-compatibility | `API-BREAKING-CHANGE` (oasdiff ERR), `API-POTENTIALLY-BREAKING` (WARN), traced to consumers/requirements | CONFLICT / UNKNOWN | oasdiff, typespec (+likec4, openspec) |

Semantic contradictions that need two tools: `RC-*` (OpenSpec + TypeSpec), `XS-FORBIDDEN-DEPENDENCY`
/ `XS-OWNERSHIP` (OpenSpec + LikeC4), `AA-*` (LikeC4 + TypeSpec), `AI-PROJECTION-COUNTEREXAMPLE`
(LikeC4 + Alloy), `RI-COUNTEREXAMPLE` (Alloy + OpenSpec), `XS-*` (OpenSpec/TypeSpec + Alloy).

## Status vs verdict

| Situation | status | verdict |
|---|---|---|
| rule ran, compared constraints agree | PASS | CONSISTENT |
| rule ran, information missing / scope differs | PASS | UNKNOWN |
| rule ran, contradiction | FAIL | CONFLICT |
| assertion linked but not executed / evidence stale | SKIP | UNKNOWN |
| tool failed | ERROR | UNKNOWN |
| Alloy `check` SAT | FAIL | CONFLICT (counterexample) |
| Alloy `check` UNSAT | PASS | CONSISTENT *within scope* |
| Alloy `run` SAT | PASS | NOT_APPLICABLE (an instance, not an assertion result) |

The overall verdict is `CONSISTENT` only when no finding is CONFLICT/UNKNOWN and no planned check
was skipped or errored; otherwise UNKNOWN (or CONFLICT). There is no path from a skipped check to a
clean PASS.
