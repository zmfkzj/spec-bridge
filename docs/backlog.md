# Backlog (follow-up R&D, out of the current scope)

| # | Item | Why / evidence |
|---|---|---|
| B1 | Independent, human-reviewed benchmark built from real repositories (and a held-out set authored by someone other than the rule author) | Current ground truth is agent-authored; C's 14/14 recall is not external evidence (limitations §10) |
| B2 | Measure configuration D with a real AI provider through `SPECBRIDGE_AI_COMMAND` (precision of proposals, token cost, reviewer effort) | D unmeasured; D′ (heuristic auto-accept) already shows wrong unifications in case 11 |
| B3 | Requirement identity anchors inside OpenSpec (e.g. a stable `ID:` line) once/if OpenSpec supports metadata, to survive title edits | title-based ids (limitations §2) |
| B4 | Richer SCN: conditional constraints, enumerations, string length/patterns, cross-field relations; propose SCN sentences from prose via AI as *proposals* | many normative sentences stay UNKNOWN |
| B5 | Projection of LikeC4 dynamic views into Alloy traces (sequence/ordering invariants) | projections cover static relations only |
| B6 | Alloy formula structure (via the AST visitor) for better correspondence checks than token references | RI-CORRESPONDENCE is structural only |
| B7 | Persistent extraction cache keyed by file hashes; single long-lived JVM for Alloy | tool start-up dominates latency |
| B8 | Query/header parameter and status-code body comparison; TypeSpec visibility (`@visibility`) as direction source | contract limitations §6 |
| B9 | Impact rule calibration on large real models (precision/recall of impacted sets) | propagation table unvalidated at scale |
| B10 | SARIF output for code-scanning UIs | CI integration convenience |
| B11 | Multi-project LikeC4 workspaces and multi-service TypeSpec programs | single project/service tested |
