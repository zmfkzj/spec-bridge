# payment Specification

## Purpose
Held seats are confirmed only after a successful payment through the booking API.

## Requirements
### Requirement: Payment confirmation
`ConfirmRequest.paymentToken` MUST be present in request.

- `Reservations.confirmPayment` MUST respond with 402 when the payment is declined.
- `Hold.priceCents` MUST be at least 0.

#### Scenario: Declined card
- **WHEN** the payment provider declines the card
- **THEN** the API responds with 402 and the seat stays held
