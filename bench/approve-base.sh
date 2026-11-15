#!/usr/bin/env bash
# Re-creates bench/base/specbridge/mappings.yaml through the normal review command.
# Approver label states that these are agent-authored benchmark approvals (no human review).
set -euo pipefail
cd "$(dirname "$0")/.."
W=bench/base
BY="benchmark-fixture (agent-authored, not human-reviewed)"
S=./bin/specbridge.mjs
echo 'mappings: []' > $W/specbridge/mappings.yaml
$S mapping approve -w $W --type VERIFIES --from 'alloy:formal/booking.als#assert:SingleHolder' --to openspec:seat-hold/single-seat-hold --by "$BY" --rationale "a seat never has two holders"
$S mapping approve -w $W --type VERIFIES --from 'alloy:formal/booking.als#assert:HeldHasHolder' --to openspec:seat-hold/single-seat-hold --by "$BY" --rationale "a held seat has exactly one holder"
$S mapping approve -w $W --type VERIFIES --from 'alloy:formal/architecture.als#assert:InventoryIsolation' --to openspec:booking-architecture/inventory-isolation --by "$BY" --rationale "WebApp must not depend on SeatInventory (LikeC4 projection)"
rm -rf $W/.specbridge
