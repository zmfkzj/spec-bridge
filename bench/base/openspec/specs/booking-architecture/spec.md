# booking-architecture Specification

## Purpose
Structural rules of the booking platform that architecture and API changes must respect.

## Requirements
### Requirement: Inventory isolation
`booking.webApp` MUST NOT depend on `booking.seatInventory`.

- `booking.bookingService` MUST be the only provider of `Reservations.holdSeat`.

#### Scenario: Web app holds a seat
- **WHEN** the web app holds a seat
- **THEN** it goes through the booking service
