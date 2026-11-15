module jobs
sig Worker {}
sig Job { var owner: lone Worker }
pred claim[j: Job, w: Worker] { no j.owner and j.owner' = w and all o: Job - j | o.owner' = o.owner }
pred stutter { owner' = owner }
fact init { no owner }
fact traces { always (stutter or some j: Job, w: Worker | claim[j, w]) }
assert NoDoubleAssignment { always all j: Job | lone j.owner }
check NoDoubleAssignment for 3 but 5 steps
