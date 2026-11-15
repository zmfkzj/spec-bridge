# CLI reference and configuration

All commands accept `-w/--workspace DIR` (default `.`), `--format text|json`, `--out FILE`.

| Command | Executes tools? | Purpose |
|---|---|---|
| `build` | extraction only | Build the Semantic IR (`.specbridge/ir.json`). Exit 2 if any extractor reports errors. |
| `link [--ai]` | extraction | Heuristic (and optionally AI-command) link **proposals** → `.specbridge/proposals.json`. |
| `mapping list` | extraction | Approved/rejected mappings with validity (`VALID/STALE/INVALIDATED`). |
| `mapping approve <proposal-id> --by NAME [--rationale T]` | – | Store a reviewed proposal in `specbridge/mappings.yaml` (records endpoint fingerprints). |
| `mapping approve --type T --from ID --to ID --by NAME` | – | Approve an explicit mapping (endpoints must exist). |
| `mapping reject <proposal-id> --by NAME` | – | Record a rejection (kept as `Rejected`, never proposed again). |
| `analyze consistency [--rule ID]` | no (reuses fresh formal evidence) | Cross-spec contradiction analysis. |
| `analyze impact [--change C] [--base-ref R \| --baseline-dir D] [--entity ID]…` | no | Semantic change impact. |
| `analyze coverage` | no | Five coverage categories. |
| `verify formal` | Alloy | Execute explicit model commands + architecture projections; write `.specbridge/evidence/formal.json`. |
| `verify [--change C] [--base-ref R \| --baseline-dir D]` | Alloy, oasdiff | Integrated verification + analysis + impact + coverage. |
| `formal draft --requirement ID` | Alloy parser | Draft Alloy model (marked `SPECBRIDGE-DRAFT`, excluded from evidence). |
| `report [--format json]` | – | Print the last report. |

Exit codes: `0` CONSISTENT, `1` CONFLICT, `2` ERROR, `3` UNKNOWN or skipped checks, `64` usage.
`--allow-unknown` makes 3 → 0 (an explicit decision, visible in CI configuration).

`--change C` applies the OpenSpec change **on a copy** with the official `openspec archive C --yes`
and analyses the after-state; `--base-ref R` materialises `R` with `git archive` under
`.specbridge/cache/` (no checkout, reset or stash of your working tree).

## `specbridge.yaml`

```yaml
openspec: { root: . }                 # directory containing openspec/   (null disables)
likec4: { root: architecture }        # LikeC4 workspace directory
typespec: { main: api/main.tsp }      # TypeSpec entry file
alloy: { models: [formal/jobs.als] }  # explicit models (default: formal/*.als)
mappings: specbridge/mappings.yaml
policies:
  singleProvider: true                # an operation has exactly one providing component
  formalVerificationRequired: []      # requirement-id globs that must be backed by an executed assertion
  impactMaxDepth: 4
  impactMaxNodes: 500
alloyProjections:                     # LikeC4 -> Alloy, deterministic (Architecture-Invariant checks)
  - id: architecture
    model: formal/architecture.als    # schema model: sig + relation + assertions (no own check commands)
    sig: Component
    relation: deps
    elementKinds: [component, database]
    atoms: { WebApp: jobs.webApp }    # existing `one sig`s of the model -> LikeC4 FQN
    assertions: [QueueIsolation]
```

## Explicit links in the source specifications

SpecBridge only uses links that are written down (or approved). Supported carriers:

| Source | Carrier | Meaning |
|---|---|---|
| OpenSpec | backticked identifiers, e.g. `` `Jobs.claimJob` ``, `` `ClaimRequest.workerId` `` | requirement REQUIRES/REFERENCES the element; resolved exactly or by unique dotted suffix, never by similarity |
| OpenSpec | SCN sentences (see [ir.md](ir.md#scn)) | structured constraints |
| LikeC4 element metadata | `specbridge_provides`, `specbridge_requirements`, `specbridge_owns`, `specbridge_interface`, `specbridge_forbidden_dependencies` | EXPOSES, SATISFIES, OWNS, IMPLEMENTS, DependencyRestriction |
| LikeC4 relationship metadata | `specbridge_operations` | source CONSUMES operations over this relationship (target expected to provide them) |
| TypeSpec (`@extension` from @typespec/openapi) | `x-specbridge-requirements`, `x-specbridge-provider`, `x-specbridge-owner` | SATISFIES, provider claim, ownership claim |
| `specbridge/mappings.yaml` | approved entries (`VERIFIES`, `CORRESPONDS_TO`, …) | links that cannot live in a source (e.g. Alloy ↔ requirement) |

Identifiers: OpenSpec `openspec:<capability>/<slug(requirement name)>`; LikeC4 `likec4:<fqn>`;
TypeSpec `typespec:op:<FQN>`, `typespec:type:<FQN>`, `typespec:field:<FQN>.<prop>`;
Alloy `alloy:<model path>#sig|field|fact|pred|assert|cmd:<name>`.
