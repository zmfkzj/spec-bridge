# SpecBridge semantic benchmark — results

Generated 2026-11-15T09:03:09.251Z (v24.21.0). Ground truth: **agent-authored by the implementing agent; NOT reviewed by a human (no human review occurred)**.

## Configurations

| metric | A tools only | B explicit refs | C IR + rules | D AI mapping | D′ heuristic auto-accept |
|---|---|---|---|---|---|
| tp | 3 | 9 | 14 | n/a | 14 |
| fp | 0 | 0 | 0 | n/a | 0 |
| fn | 11 | 5 | 0 | n/a | 0 |
| precision | 1 | 1 | 1 | n/a | 1 |
| recall | 0.214 | 0.643 | 1 | n/a | 1 |
| falsePositiveRate | 0 | 0 | 0 | n/a | 0 |
| falseNegativeRate | 0.786 | 0.357 | 0 | n/a | 0 |
| overallVerdictAccuracy | 0.333 | 0.6 | 1 | n/a | 0.933 |
| falsePass | 10 | 6 | 0 | n/a | 0 |
| unknownRecall | 0 | 0 | 1 | n/a | 1 |
| mappingAccuracy | 0.444 | 0.778 | 1 | n/a | 0.778 |
| requirementTraceOfDetectedDefects | 0 | 0 | 1 | n/a | 1 |
| impactExpectationsMet | 0 | 0 | 1 | n/a | 1 |
| latency mean/max ms | 1206/1801 | 2515/3144 | 4560/5088 | n/a | 4567/5036 |
| tokens | 0 | 0 | 0 | not measured | 0 |

D: UNSUPPORTED / NOT MEASURED — no AI provider is configured in this environment; SPECBRIDGE_AI_COMMAND boundary exists but no model was called.

Reproducibility (C run twice, normalized report hash): 15/15 identical.

## Cases

| case | expected | A | B | C | D′ | C TP/FP/FN | C false PASS | repro |
|---|---|---|---|---|---|---|---|---|
| 01-consistent | CONSISTENT | CONSISTENT | CONSISTENT | CONSISTENT | CONSISTENT | 0/0/0 | false | true |
| 02-required-field-conflict | CONFLICT | CONSISTENT | CONSISTENT | CONFLICT | CONFLICT | 1/0/0 | false | true |
| 03-ownership-mismatch | CONFLICT | CONSISTENT | CONSISTENT | CONFLICT | CONFLICT | 2/0/0 | false | true |
| 04-missing-operation-ref | CONFLICT | CONSISTENT | CONFLICT | CONFLICT | CONFLICT | 2/0/0 | false | true |
| 05-forbidden-dependency | CONFLICT | CONSISTENT | CONSISTENT | CONFLICT | CONFLICT | 2/0/0 | false | true |
| 06-breaking-change | CONFLICT | CONFLICT | CONFLICT | CONFLICT | CONFLICT | 1/0/0 | false | true |
| 07-alloy-counterexample | CONFLICT | CONFLICT | CONFLICT | CONFLICT | CONFLICT | 2/0/0 | false | true |
| 08-core-requirement-unlinked | UNKNOWN | CONSISTENT | CONSISTENT | UNKNOWN | UNKNOWN | 0/0/0 | false | true |
| 09-nonexistent-entity-mapping | CONFLICT | CONSISTENT | CONFLICT | CONFLICT | CONFLICT | 1/0/0 | false | true |
| 10-wrong-ai-candidate | CONSISTENT | CONSISTENT | CONSISTENT | CONSISTENT | CONSISTENT | 0/0/0 | false | true |
| 11-same-term-different-meaning | CONSISTENT | CONSISTENT | CONSISTENT | CONSISTENT | UNKNOWN | 0/0/0 | false | true |
| 12-scope-false-contradiction | UNKNOWN | CONSISTENT | UNKNOWN | UNKNOWN | UNKNOWN | 0/0/0 | false | true |
| 13-incomplete-unknown | UNKNOWN | CONSISTENT | CONSISTENT | UNKNOWN | UNKNOWN | 0/0/0 | false | true |
| 14-invalidated-mapping | CONFLICT | CONSISTENT | CONFLICT | CONFLICT | CONFLICT | 3/0/0 | false | true |
| 15-false-pass-prevention | UNKNOWN | CONSISTENT | CONSISTENT | UNKNOWN | UNKNOWN | 0/0/0 | false | true |

## False positives / false negatives (C)


## False positives / false negatives (D′ heuristic auto-accept)

- 11-same-term-different-meaning: mapping unexpected CORRESPONDS_TO|alloy:formal/locks.als#sig:Hold|typespec:type:BookingApi.Hold
- 11-same-term-different-meaning: mapping unexpected CORRESPONDS_TO|alloy:formal/locks.als#field:Hold.holder|typespec:field:BookingApi.Hold.holder
