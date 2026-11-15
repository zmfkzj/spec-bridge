# job-claim Specification

## Purpose
Workers claim queued jobs through the Job API. Each job is processed by at most one worker at a time, and claims are leased for a bounded time.

## Requirements
### Requirement: Exclusive job claim
The system SHALL assign a job to at most one worker at a time through `Jobs.claimJob`.

- `ClaimRequest.workerId` MUST be present in request.
- `Jobs.claimJob` MUST respond with 409 when the job is already claimed.
- Each `Job` in state `claimed` MUST have exactly one `owner`.

#### Scenario: Concurrent claim
- **WHEN** two workers claim the same queued job concurrently
- **THEN** exactly one claim succeeds
- **AND** the other worker receives 409 Conflict

### Requirement: Claim lease bounds
A claim is held for a bounded lease through `Jobs.claimJob`.

- `ClaimRequest.leaseSeconds` MUST be between 30 and 3600 seconds.

#### Scenario: Lease too long
- **WHEN** a worker requests a lease of 7200 seconds
- **THEN** the claim is rejected with 400
