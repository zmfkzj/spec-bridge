# job-claim Specification

## Purpose
Workers claim queued jobs; every job must be processed by exactly one worker at a time.

## Requirements
### Requirement: Exclusive job claim
The system SHALL assign a job to at most one worker at a time through `Jobs.claimJob`.

- `ClaimRequest.workerId` MUST be present in request.

#### Scenario: Concurrent claim
- **WHEN** two workers claim the same queued job concurrently
- **THEN** exactly one claim succeeds
