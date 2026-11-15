module architecture
-- Architecture schema; assertions are executed on the SpecBridge projection of the LikeC4 model.

abstract sig Component { deps: set Component }
one sig WebApp, SeatInventory extends Component {}

assert InventoryIsolation { SeatInventory not in WebApp.deps }
assert NoCycles { no c: Component | c in c.^deps }
