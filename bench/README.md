# Semantic benchmark

`bench/base/` is a small, independent design case (seat booking: OpenSpec specs, LikeC4 model,
TypeSpec contract, two Alloy models, approved mappings created with `bench/approve-base.sh`). Each
of the 15 cases in `bench/cases/NN-*/` contains **real source files** (`overlay/`) that replace base
files, plus `case.yaml` with the ground truth (schema: `schemas/benchmark-case.schema.json`).

**Ground-truth review status: agent-authored, NOT reviewed by a human.** Every `case.yaml` says so
and `test/cli.test.ts` enforces that no case claims human review.

| # | Case class (spec §15.2) | Defect / expectation |
|---|---|---|
| 01 | all specs consistent | overall CONSISTENT, expected links present |
| 02 | requirement vs API required field | `RC-REQUIRED-OPTIONAL` |
| 03 | architecture vs API ownership | `AA-PROVIDER-CONFLICT`, `XS-OWNERSHIP` |
| 04 | missing API operation reference | `RC-MISSING-OPERATION`, `AA-DANGLING-OPERATION` |
| 05 | forbidden service dependency | `XS-FORBIDDEN-DEPENDENCY`, projection counterexample traced to the requirement |
| 06 | breaking change | `API-BREAKING-CHANGE` traced to consumer + requirement; impact expectations |
| 07 | Alloy counterexample | two `RI-COUNTEREXAMPLE`s traced to the requirement |
| 08 | core requirement without invariant | `RI-NOT-LINKED` UNKNOWN; overall UNKNOWN |
| 09 | mapping to non-existent entity | `MAP-DANGLING` |
| 10 | wrong AI link candidate (stub fixture) | candidate stays Proposed; nothing changes |
| 11 | same term, different meaning | no unification, no conflict without an approved mapping |
| 12 | false contradiction from scope/state | UNKNOWN `STATE_DIFFERS`, no conflict |
| 13 | incomplete spec | UNKNOWN (`RC-RANGE-MISSING`, `REQ-AMBIGUOUS-NL`) |
| 14 | mapping invalidated by a change (rename) | `MAP-DANGLING` ×2, `REF-DANGLING`, invalidated vs baseline |
| 15 | no false PASS for unverified areas | assertion without check + no API baseline ⇒ not CONSISTENT |

## Configurations (executed independently by `bench/run.ts`)

- **A** individual tools only: `openspec validate`, LikeC4 diagnostics, TypeSpec compile, oasdiff
  breaking (HEAD vs working tree), raw Alloy commands. No cross-tool model, no UNKNOWN concept.
- **B** explicit-reference integration: IR + reference/mapping checks only
  (`analyzeConsistency({profile:'reference'})`), only Explicit links, plus A's tool results.
- **C** Semantic IR + deterministic rules: the real CLI (`specbridge verify --base-ref HEAD`, case 15
  `verify`).
- **D** Semantic IR + AI mapping: **not measured** (no AI provider configured).
- **D′** heuristic proposals with score ≥ 0.5 auto-approved into the mappings (labelled as a
  simulation of blind trust; *not AI, not a human approval*), then C.

Metrics per configuration: TP/FP/FN over expected defects (a finding matches a defect when its rule
is accepted and a subject is one of the anchors), precision, recall, FP rate over
`FP / (FP + correctly-unflagged designated negatives)`, FN rate, overall-verdict accuracy,
**false PASS** (expected ≠ CONSISTENT but reported CONSISTENT), UNKNOWN recall, mapping accuracy
(expected present/absent links), requirement traceability of detected defects, impact expectations,
latency, tokens. Reproducibility: C is run twice; normalized reports (timestamps/durations removed)
are hashed.

Run: `npm run bench` (≈ 4.5 min; writes `bench/results/latest.json` and `summary.md`, then the
regression gate `bench/check.ts`).

## Results

See [results/summary.md](results/summary.md) for the latest run. Interpretation caveat: the same
agent wrote the rules and the cases, so C's scores demonstrate *that the specified behaviours work*,
not accuracy on independent data. A/B results show what is lost without semantic integration:
A misses every cross-spec contradiction and reports CONSISTENT where information is missing
(false PASS); B finds dangling references but no constraint contradictions or formal traces.
