# Proposal: initialize-repository

## Why
The workspace contained the product specification but no Git repository or embedded Harness planning state. Initialization establishes a reproducible project baseline before product implementation begins.

## What Changes
- Track the existing `PLAN.md` as the initial repository commit.
- Configure the requested GitHub repository as `origin`.
- Create the embedded OpenSpec directory structure and this change ledger.
- Keep the repository on a dedicated nonprotected feature branch until hosted delivery is available.

## Impact
This is repository and planning initialization only. It introduces no product behavior, API, schema, dependency, or runtime changes. The hosted repository is private and currently empty; delivery is limited to the isolated local feature branch until the remote feature ref and pull request can be created against `main`.
