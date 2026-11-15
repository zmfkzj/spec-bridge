module locks
-- 'Hold' here is a mutex hold of the booking service's worker threads, NOT the API's seat Hold.

sig Thread {}
sig Hold { holder: one Thread }

assert HoldHasOwner { all h: Hold | one h.holder }
check HoldHasOwner for 3
