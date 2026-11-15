# seat-hold Specification

## Purpose
Customers hold seats for a show before paying; a held seat cannot be held by anyone else.

## Requirements
### Requirement: Single seat hold
`Reservations.holdSeat` MUST respond with 409 when the seat is already held.

- `HoldRequest.seatId` MUST be present in request.
- `HoldRequest.customerId` MUST be present in request.
- Each `Seat` in state `held` MUST have exactly one `holder`.
- `Hold.releasedAt` MUST be present in response when `Hold.state` is `released`.
- `Hold.priceCents` MUST be present in request.

#### Scenario: Seat already held
- **WHEN** a second customer tries to hold a seat that is already held
- **THEN** the API responds with 409

### Requirement: Hold duration
`HoldRequest.holdMinutes` MUST be between 1 and 15 minutes.

#### Scenario: Hold too long
- **WHEN** a customer asks for a 30 minute hold
- **THEN** the hold is rejected
