# Backend/frontend integration repair — RPC contract

This branch includes a narrowly scoped correction in server.js: the API call to `create_aftercare_vaccination` no longer sends `p_call_schedule`. The deployed/migration-defined RPC accepts ten arguments and creates the two scheduled follow-up rows internally; sending the extra argument causes a function signature mismatch.

## Verification limits and blockers

- Static source comparison: the API call now matches the ten-argument definition in migration `0004_atomic_aftercare_vaccination.sql`.
- This correction is not runtime-tested; no safe test database credentials/environment were available in this task.
- `lafiya_register_enrolment` and `lafiya_schema_version` remain prerequisites not present in the repository's current migrations tree.
- The frontend still requires a coordinated authenticated API rewrite; frontend repository branch access was denied by GitHub permissions in this session.
- Do not apply migrations to the live project or enable outbound calling until the remaining RPCs/schema are installed and validated in a separate draft environment.

## Changed

The `/api/vaccinations` handler removes the unsupported `p_call_schedule` argument. Call scheduling continues to be calculated by the database function.
