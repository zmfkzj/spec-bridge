# Semantic IR

Schema: [schemas/ir.schema.json](../schemas/ir.schema.json). Types: [src/ir/types.ts](../src/ir/types.ts).
The IR is **derived data** (`.specbridge/ir.json`): deleting `.specbridge/` and running
`specbridge build` regenerates it byte-identically from the specifications plus
`specbridge/mappings.yaml` (tested in `test/ir.test.ts`). Timestamps live in `build-meta.json`.

## Entities

Base types: `Requirement, Scenario, Component, Interface, Operation, DataType, Constraint, State,
Transition, Invariant`. Documented extensions: `Field` (TypeSpec property / Alloy field),
`Predicate` (Alloy pred without primed relations), `Command` (Alloy run/check), `Change`
(OpenSpec change), `Flow` (LikeC4 dynamic view), `DeploymentNode`.

| Tool | Mapping |
|---|---|
| OpenSpec | requirement → Requirement, scenario → Scenario (GIVEN/WHEN/THEN steps), change → Change (+ `CHANGES` relations per delta: ADDED/MODIFIED/REMOVED/RENAMED) |
| LikeC4 | element → Component (kinds containing `interface`/`api` → Interface), hierarchy → `CONTAINS`, relationship → `DEPENDS_ON`, dynamic view → Flow, deployment → DeploymentNode/`DEPLOYS` |
| TypeSpec | service/interface → Interface, operation → Operation (verb, path, params, body, responses, extensions), model → DataType, property → Field, `extends` → `EXTENDS`, op request/response types → `REFERENCES {direction}` |
| Alloy | sig → DataType (enum-like `one sig`s of an abstract sig → State, rule ALLOY-STATE), field → Field, fact → Constraint, pred with primed relations → Transition (rule ALLOY-TRANSITION) else Predicate, assert → Invariant, command → Command (`VERIFIES` its assertion) |

Every entity has: stable `id`, `type`, `tool`, `source` (`file`, `line`, `column`, `locatedBy: tool |
source-locator`), `version` (tool version, file sha256, git revision, dirty flag), `extraction`
(`method`, `adapter`, `lossy`), `validation` (tool-validated / invalid / unvalidated), `trust`,
`fingerprint` (hash of semantic content, not location), `attrs`, `evidence`.

**Identity vs revision.** Ids are derived from names the tools treat as identity (OpenSpec
capability + requirement title, LikeC4 FQN, TypeSpec fully-qualified name, Alloy model path + name).
Fingerprints are revisions: same id + new fingerprint = MODIFIED; same fingerprint + new file =
MOVED; removed + added with identical content = RENAMED candidate (reported, never auto-applied).
OpenSpec `RENAMED` deltas are honoured as explicit renames.

## Relations

`REQUIRES, SATISFIES, IMPLEMENTS, DEPENDS_ON, EXPOSES, CONSUMES, OWNS, CONSTRAINS, TRANSITIONS_TO,
VERIFIES, CONFLICTS_WITH, IMPACTS` + extensions `CONTAINS, REFERENCES, EXTENDS, CORRESPONDS_TO,
DEPLOYS, CHANGES`. Every relation has `rule` and ≥1 `evidence` item (source location, tool output,
mapping or rule). `CONFLICTS_WITH` and `IMPACTS` are expressed as findings / impact results in the
report rather than stored in the IR (they are analysis results, not extracted facts).

## Trust

| Trust | Produced by | Used as fact? |
|---|---|---|
| Explicit | the source spec (metadata, extension, exact identifier) or an **approved, VALID** mapping | yes |
| Derived | deterministic rule (`D-*`, unique-suffix resolution, ALLOY-STATE, SCN patterns) | yes |
| Proposed | heuristic similarity / AI command (`.specbridge/proposals.json` only) | **never** |
| Rejected | `mapping reject` | never (kept for audit, suppresses re-proposal) |

Approved mappings whose endpoint fingerprints changed are kept with `stale: true`: they still
propagate impact (flagged `(stale)`) but no longer count for verification or coverage.

Derived rules: `D-INTERFACE-EXPOSES` (component exposes a TypeSpec interface ⇒ its operations),
`D-PROVIDER-SATISFIES` (requirement requires op O and component exposes O ⇒ component SATISFIES
requirement, Derived), `D-CORRESPONDS-CONSTRAINS` (Alloy formula constrains sig S, S approved
CORRESPONDS_TO TypeSpec T ⇒ constrains T), `D-REQ-CONSTRAINS` (SCN constraint subject resolved to a
contract element), `D-FIELD-IN-MAPPED-CONCEPT` (Alloy field with the same name inside an approved
concept mapping), `D-SCN-TRANSITION`.

## Constraints

Kinds: `Equality, Inequality, Cardinality, Required, Optional, Range, TypeCompatibility,
DependencyRestriction, Ownership, Exclusivity, StateInvariant, ErrorResponse`. Interpretation:
`structured` (compiler/model facts), `scn-pattern` (OpenSpec controlled language), `alloy-reference`
(formula stays in Alloy; only referenced sigs/fields are recorded), `uninterpreted`.
Complex logic is never translated; SpecBridge has no solver of its own.

<a id="scn"></a>
### SCN — SpecBridge Constraint Notation (OpenSpec requirement/scenario text)

| Rule | Sentence pattern | Constraint |
|---|---|---|
| SCN-REQUIRED | `` `T.f` MUST be present [in request\|response] [when `T.s` is `v`] `` | Required (direction, state) |
| SCN-OPTIONAL | `` `T.f` MAY be omitted [in …] `` | Optional (permission) |
| SCN-RANGE-* | `` `T.f` MUST be between A and B [unit] `` / `at least` / `at most` / `MUST NOT exceed` | Range (unit normalized: s, byte, char, item) |
| SCN-TYPE | `` `T.f` MUST be an integer\|string\|boolean\|number\|timestamp `` | TypeCompatibility |
| SCN-UNIQUE | `` `T.f` MUST be unique `` | Exclusivity |
| SCN-CARDINALITY | `` Each `T` [in state `s`] MUST have exactly one\|at most one\|at least one\|no `f` `` | Cardinality (stored) |
| SCN-ERROR-RESPONSE | `` `Iface.op` MUST respond with NNN `` | ErrorResponse |
| SCN-NO-DEPENDENCY | `` `a` MUST NOT depend on\|call\|use `b` `` | DependencyRestriction |
| SCN-OWNERSHIP | `` `c` MUST be the only provider of `Iface.op` `` | Ownership |
| SCN-TRANSITION | `` `T.f` MAY transition from `a` to `b` `` | State/Transition entities |

Any other sentence containing SHALL/MUST/SHOULD/REQUIRED is listed as *uninterpreted* and yields
`REQ-AMBIGUOUS-NL` (UNKNOWN). Unknown unit words make the sentence uninterpreted.

### Comparison (src/constraints/compare.ts)

Same `fieldKey` only. Then: request vs response → not compared; stored vs request/response →
UNKNOWN `SCOPE_DIFFERS`; requirement scoped to a state while the design is state-less → UNKNOWN
`STATE_DIFFERS`; units missing/mismatched → UNKNOWN; uniqueness vs presence → NOT_APPLICABLE.
Required vs Optional → CONFLICT; disjoint ranges/cardinalities → CONFLICT; contract with an explicit
looser bound → CONFLICT (`CONTRACT_PERMITS_VIOLATION`); contract silent on a bound → UNKNOWN; Alloy
multiplicity wider than required → UNKNOWN `DELEGATED_TO_ALLOY`, upgraded to CONSISTENT
(`DELEGATED_VERIFIED_BOUNDED`) only when every approved assertion verifying that requirement ran
with no counterexample.

<a id="impact"></a>
## Impact propagation

Rules are per relation type and direction, optionally restricted by the type of the entity the
impact comes from, and may be terminal (the reached entity must be re-checked but is not expanded):
see `PROPAGATION` in [src/analysis/impact.ts](../src/analysis/impact.ts). Additional controls:
no traversal back through the same relation type in the opposite direction (prevents sibling
explosion), cycle-safe visited set, `impactMaxDepth` / `impactMaxNodes` with explicit truncation
warnings, seeds without relations produce "impact UNKNOWN" warnings, deletions are traced on the
baseline graph, Proposed links are listed separately and never propagated.
