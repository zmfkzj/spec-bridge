# platform-architecture Specification

## Purpose
Structural rules for the job platform that every architecture and API change must respect.

## Requirements
### Requirement: Queue isolation
The web front end SHALL only reach the queue through the job service.

- `jobs.webApp` MUST NOT depend on `jobs.jobQueue`.
- `jobs.jobService` MUST be the only provider of `Jobs.claimJob`.

#### Scenario: Web app submits a job
- **WHEN** the web app submits a job
- **THEN** it calls the job service, never the queue store
