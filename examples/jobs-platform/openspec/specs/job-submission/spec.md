# job-submission Specification

## Purpose
Clients submit jobs through the web application; submitted jobs are queued for workers.

## Requirements
### Requirement: Job submission
Clients SHALL submit jobs through `Jobs.submitJob`.

- `SubmitJobRequest.payload` MUST be present in request.
- `Job.id` MUST be present in response.
- `Job.status` MAY transition from `queued` to `claimed`.

#### Scenario: Submit a job
- **WHEN** a client submits a payload
- **THEN** the job is stored with status queued
