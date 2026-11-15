# Change: Add explicit job lease expiry

## Why
Workers that crash keep jobs claimed forever; an explicit, client-visible lease expiry lets the platform recover stuck jobs.

## What Changes
- The claim requirement now demands an explicit lease duration from workers.
- A new requirement exposes the lease expiry time of claimed jobs.
