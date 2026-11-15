module architecture
-- Structural architecture invariants. SpecBridge projects the LikeC4 relation graph onto
-- Component/deps (see alloyProjections in specbridge.yaml) and checks these assertions.

abstract sig Component { deps: set Component }
one sig WebApp, JobQueue extends Component {}

assert QueueIsolation { JobQueue not in WebApp.deps }
assert NoCycles { no c: Component | c in c.^deps }

-- No check commands here: the assertions are only meaningful for a concrete architecture,
-- so they are executed through the SpecBridge projection (exact LikeC4 components + relations).
