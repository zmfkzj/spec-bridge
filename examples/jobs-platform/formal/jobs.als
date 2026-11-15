module jobs
-- Behavioural model of job claiming (explicit, hand-written).

abstract sig Status {}
one sig Queued, Claimed, Done extends Status {}

sig Worker {}

sig Job {
  var status: one Status,
  var owner: lone Worker
}

fact init { all j: Job | j.status = Queued and no j.owner }

pred claim[j: Job, w: Worker] {
  j.status = Queued
  j.status' = Claimed
  j.owner' = w
  all o: Job - j | o.status' = o.status and o.owner' = o.owner
}

pred complete[j: Job] {
  j.status = Claimed
  j.status' = Done
  no j.owner'
  all o: Job - j | o.status' = o.status and o.owner' = o.owner
}

pred stutter { status' = status and owner' = owner }

fact traces { always (stutter or (some j: Job, w: Worker | claim[j, w]) or (some j: Job | complete[j])) }

assert NoDoubleAssignment { always all j: Job | lone j.owner }
assert ClaimedHasOwner { always all j: Job | j.status = Claimed implies one j.owner }

check NoDoubleAssignment for 3 but 6 steps
check ClaimedHasOwner for 3 but 6 steps
run claim for 3 but 3 steps
