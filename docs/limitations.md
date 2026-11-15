# Supported scope and limitations

## Supported

- Extraction: OpenSpec specs + active changes (CLI JSON), LikeC4 elements/relations/metadata/dynamic
  views/deployments (model API), TypeSpec HTTP services, operations, models, properties, bounds,
  types, error responses, `@extension` values (compiler API), Alloy sigs/fields/facts/preds/
  assertions/commands/scopes (Java API), oasdiff changes (JSON).
- Structured cross-spec checks listed in [architecture.md](architecture.md#rule-catalogue);
  Alloy execution of explicit models and of deterministic LikeC4→Alloy projections; counterexample
  atoms mapped to IR entities via approved mappings or projection atoms.
- Impact analysis from OpenSpec changes, git baselines (`--base-ref`), baseline directories, oasdiff
  changes and explicit entities.
- Five coverage categories; status/verdict separation; reproducible JSON (15/15 benchmark cases
  produced identical normalized reports across two runs).

## Known limitations (honest list)

1. **Natural language** is interpreted only through SCN patterns. Everything else is UNKNOWN
   (`REQ-AMBIGUOUS-NL`); SpecBridge does not formalize free text.
2. **Requirement identity** is title-based (OpenSpec has no ids). Editing a title without a `RENAMED`
   delta looks like delete + add (reported as a rename *candidate*); approved mappings to the old id
   become INVALIDATED until re-approved.
3. **Alloy formulas are not interpreted**; only the sigs/fields an assertion mentions (token scan of
   Alloy's resolved pretty-print) and field multiplicities are used. Whether an assertion adequately
   models a requirement is only checked structurally (`RI-CORRESPONDENCE`), never decided.
4. **Bounded verification**: `NO_COUNTEREXAMPLE_IN_SCOPE` holds for the model and scope only.
5. **Architecture projection** maps direct LikeC4 relations between elements of the configured kinds;
   nested/implied relations, dynamic views and deployment topology are not projected.
6. **Contract semantics**: only properties of models used as HTTP bodies/responses get directions;
   headers/query parameters are recorded but not compared; `@minLength/@maxLength` are extracted but
   length requirements are compared only as UNKNOWN (`RC-RANGE-MISSING`); unions other than literal
   unions are opaque; templates are not extracted.
7. **Units** come from SCN unit words and TypeSpec name suffixes/`@encode`; anything else → UNKNOWN.
8. **Architecture policies** (single provider) are configurable defaults, not truths.
9. **Impact** follows recorded relations only. Unlinked elements produce "impact UNKNOWN" warnings;
   the propagation table is a design choice (documented in code) and has not been validated on large
   real-world models.
10. **Benchmark validity**: the 15 cases and their ground truth were written by the same agent that
    implemented the rules, and **no human reviewed them**. C's perfect scores show the rules do what
    the cases specify; they are not evidence of accuracy on independent, real specifications.
11. **AI-assisted mapping (configuration D) was not measured**: no AI provider was available. Only the
    command boundary exists; the case-10 stub is a fixture, not a model.
12. **Performance** was measured only on small workspaces (≈ 3–7 s per `verify`, dominated by tool
    start-up: OpenSpec CLI ≈ 1 s, Alloy JVM ≈ 0.3–1 s). Large models were not benchmarked.
13. oasdiff is pinned for linux/amd64 checksums; other platforms verify against the release checksum
    file only.
14. LikeC4 or TypeSpec sources with errors are not extracted (status ERROR, verdict UNKNOWN) instead of
    partially extracted.

## Out of scope (by design, spec §17)

General NL theorem proving, own SMT/solver, Alloy replacement, full automatic formalization,
bidirectional spec conversion, automatic fixing, implementation-code proofs, knowledge-graph
platform, web IDE, distributed agent systems.
