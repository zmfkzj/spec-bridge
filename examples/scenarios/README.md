# Success scenarios A–E

Each scenario starts from `examples/jobs-platform` (committed as the git baseline in a scratch
repository), applies the files in `overlay/` on top, and runs the SpecBridge command in
`scenario.json`. `scripts/run-scenarios.mjs` executes them and writes the reports to
`evidence/scenarios/`; `test/scenarios.test.ts` asserts the expectations.

| Scenario | Change | Command |
|---|---|---|
| A | OpenSpec change `add-job-lease` (no overlay) | `verify --change add-job-lease --base-ref HEAD` |
| B | TypeSpec contract edited | `verify --base-ref HEAD` |
| C | LikeC4 relations / provider edited | `verify --base-ref HEAD` |
| D | Alloy behaviour model edited | `verify formal` |
| E | TypeSpec contradicts OpenSpec | `analyze consistency` |
