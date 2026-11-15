# architools

## SpecBridge — Semantic Design Engine

SpecBridge connects **OpenSpec** (requirements), **LikeC4** (architecture), **TypeSpec** (API
contracts), **oasdiff** (API compatibility) and **Alloy** (relations, states, invariants) through a
derived **Semantic IR** and detects, with evidence, contradictions, gaps and change impact *across*
those specifications. It does not replace any tool: each tool's sources stay the single source of
truth and SpecBridge never edits them.

What it answers mechanically (within the limits in [docs/limitations.md](docs/limitations.md)):

| Question | Where |
|---|---|
| Which components and APIs satisfy a requirement? | IR relations `REQUIRES/SATISFIES/EXPOSES`, `analyze coverage` |
| Do architecture communication relations match API contracts? | `AA-*` rules (`analyze consistency`) |
| Are requirement constraints reflected in the design? | `RC-*`, `XS-*` rules (structured constraint comparison) |
| Do two specs contradict each other? | `RC-*`, `XS-*`, `AI-*`, `RI-*` findings with both source locations |
| What does a component/API change impact? | `analyze impact`, `verify --change/--base-ref` |
| Can a forbidden state occur? | `verify formal` (Alloy, bounded) incl. LikeC4 → Alloy projection |
| What is unverified or weakly supported? | `UNKNOWN` findings, five coverage categories |

## Install

Requirements: Node.js ≥ 22.18 (tested 24.21), JDK 17+, `curl`, `tar`, git.

```bash
npm ci                      # OpenSpec 2.0.0, LikeC4 1.61.0, TypeSpec 1.18.0 (pinned in package-lock.json)
npm run setup-tools         # oasdiff 1.38.0 + Alloy 6.2.0 into tools/ (checksums verified), compiles java/SpecBridgeAlloy.java
npm run typecheck && npm test
```

The CLI runs TypeScript directly through Node's type stripping: `node bin/specbridge.mjs …`
(or `npm link` to get `specbridge` on PATH).

## Quick start

```bash
node bin/specbridge.mjs build   -w examples/jobs-platform        # Semantic IR -> .specbridge/ir.json
node bin/specbridge.mjs analyze consistency -w examples/jobs-platform
node bin/specbridge.mjs verify  -w examples/jobs-platform --base-ref HEAD   # executes Alloy + oasdiff
node bin/specbridge.mjs verify  -w examples/jobs-platform --change add-job-lease
node bin/specbridge.mjs analyze coverage -w examples/jobs-platform --format json
node bin/specbridge.mjs link    -w examples/jobs-platform        # candidate links (Proposed only)
node bin/specbridge.mjs mapping approve <proposal-id> --by "<reviewer>" -w examples/jobs-platform
node bin/specbridge.mjs formal draft --requirement job-claim/exclusive-job-claim -w examples/jobs-platform
node bin/specbridge.mjs report --format json -w examples/jobs-platform
```

`analyze` never executes verification tools (it reuses fresh formal evidence if present);
`verify` executes Alloy (and oasdiff when a baseline is given) and records evidence. Every report
separates **execution status** (`PASS/FAIL/SKIP/ERROR`) from **semantic verdict**
(`CONSISTENT/CONFLICT/UNKNOWN/NOT_APPLICABLE`). Exit codes: 0 CONSISTENT, 1 CONFLICT, 2 ERROR,
3 UNKNOWN or skipped checks (`--allow-unknown` turns 3 into 0 explicitly).

## Workspace layout

```
specbridge.yaml               # paths, policies, Alloy projections (optional; defaults below)
openspec/                     # OpenSpec root (specs/, changes/)
architecture/*.c4             # LikeC4 workspace
api/main.tsp                  # TypeSpec entry
formal/*.als                  # explicit Alloy models
specbridge/mappings.yaml      # approved/rejected semantic mappings (human-reviewed, versioned)
.specbridge/                  # derived, regenerable: ir.json, report.json, evidence/, proposals.json, cache/
```

## Documentation

- [docs/usage.md](docs/usage.md) — CLI reference, configuration, conventions for explicit links
- [docs/architecture.md](docs/architecture.md) — layers, data flow, rule catalogue
- [docs/ir.md](docs/ir.md) — Semantic IR schema, identities, trust, provenance, constraint notation (SCN)
- [docs/interfaces.md](docs/interfaces.md) — official tool interfaces/versions, observations vs assumptions, Phase 0
- [docs/agent-guide.md](docs/agent-guide.md) — AI agent / CI integration guide
- [docs/limitations.md](docs/limitations.md) — supported scope and known limitations
- [docs/backlog.md](docs/backlog.md) — follow-up R&D
- [bench/README.md](bench/README.md) — semantic benchmark method and results
- [docs/traceability.md](docs/traceability.md) — requirement → implementation → test → evidence matrix
- [docs/final-report.ko.md](docs/final-report.ko.md) — 최종 보고서 (Korean)
- Schemas: [schemas/](schemas/) (`ir`, `report`, `mappings`, `benchmark-case`)
