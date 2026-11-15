## MODIFIED Requirements
### Requirement: Exclusive job claim
The system SHALL assign a job to at most one worker at a time through `Jobs.claimJob`, for the duration of the lease.

- `ClaimRequest.workerId` MUST be present in request.
- `ClaimRequest.leaseSeconds` MUST be present in request.
- `Jobs.claimJob` MUST respond with 409 when the job is already claimed.
- Each `Job` in state `claimed` MUST have exactly one `owner`.

#### Scenario: Concurrent claim
- **WHEN** two workers claim the same queued job concurrently
- **THEN** exactly one claim succeeds
- **AND** the other worker receives 409 Conflict

## ADDED Requirements
### Requirement: Lease expiry visibility
Workers SHALL see when their lease expires through `Jobs.getJob`.

- `Job.leaseExpiresAt` MUST be present in response.

#### Scenario: Read lease expiry
- **WHEN** a worker reads a claimed job
- **THEN** the response contains the lease expiry time
