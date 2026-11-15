#!/usr/bin/env bash
# Re-creates the approved mappings of examples/jobs-platform through the normal review command.
# The approver label states plainly that these are agent-authored example approvals.
set -euo pipefail
cd "$(dirname "$0")/.."
E=${1:-examples/jobs-platform}
BY="example-fixture (agent-authored example data, not human-reviewed)"
S=./bin/specbridge.mjs
echo 'mappings: []' > "$E/specbridge/mappings.yaml"
$S mapping approve -w "$E" --type VERIFIES --from 'alloy:formal/jobs.als#assert:NoDoubleAssignment' --to openspec:job-claim/exclusive-job-claim --by "$BY" --rationale "lone owner per job = at most one worker per job"
$S mapping approve -w "$E" --type VERIFIES --from 'alloy:formal/jobs.als#assert:ClaimedHasOwner' --to openspec:job-claim/exclusive-job-claim --by "$BY" --rationale "a claimed job has exactly one owner"
$S mapping approve -w "$E" --type CORRESPONDS_TO --from 'alloy:formal/jobs.als#sig:Job' --to typespec:type:JobApi.Job --by "$BY" --rationale "Alloy Job models the stored job resource of the Job API"
$S mapping approve -w "$E" --type VERIFIES --from 'alloy:formal/architecture.als#assert:QueueIsolation' --to openspec:platform-architecture/queue-isolation --by "$BY" --rationale "WebApp must not depend on JobQueue (checked on the LikeC4 projection)"
