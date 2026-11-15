module booking
-- Behavioural model of seat holds (explicit, hand-written).

abstract sig SeatState {}
one sig Free, Held extends SeatState {}

sig Customer {}

sig Seat {
  var state: one SeatState,
  var holder: set Customer
}

fact init { all s: Seat | s.state = Free and no s.holder }

pred hold[s: Seat, c: Customer] {
  s.state in Free + Held
  s.state' = Held
  s.holder' = s.holder + c
  all o: Seat - s | o.state' = o.state and o.holder' = o.holder
}

pred release[s: Seat] {
  s.state = Held
  s.state' = Free
  no s.holder'
  all o: Seat - s | o.state' = o.state and o.holder' = o.holder
}

pred stutter { state' = state and holder' = holder }

fact traces { always (stutter or (some s: Seat, c: Customer | hold[s, c]) or (some s: Seat | release[s])) }

assert SingleHolder { always all s: Seat | lone s.holder }
assert HeldHasHolder { always all s: Seat | s.state = Held implies one s.holder }

check SingleHolder for 3 but 6 steps
check HeldHasHolder for 3 but 6 steps
