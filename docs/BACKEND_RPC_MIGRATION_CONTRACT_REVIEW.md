# Backend RPC and Migration Contract Review

Branch: fix/live-schema-compatibility-2026-11
Review date: 2026-11-21
Production changes: none.

## Confirmed contract defects

### Schema version
server.js expects SCHEMA_VERSION = lafiya-2026-11-v1 and calls public.lafiya_schema_version(). The comment says this belongs in migration 002, but the repository has no migration 002 implementing that function. Existing 0002_fix_callbacks_rls.sql is a callback RLS patch, not a schema-version/RPC migration. The README numbering and server comment therefore do not describe the actual release contract.

### create_aftercare_vaccination
The backend sends eleven parameters, including p_call_schedule. Migration 0004 defines only ten parameters and omits p_call_schedule. PostgREST RPC resolution will fail for the backend call as written.
Migration 0004 declares v_appointment_id uuid, but the live database appointment.id is bigint. Its INSERT/RETURNING contract is incompatible with the live schema.
Migration 0004 assumes appointment/calls columns that are absent from the live schema.
Migration 0004 inserts calls without explicitly setting status. On the live schema this yields pending, whereas the dispatcher only selects scheduled.
Migration 0004 calculates schedule timestamps independently with aftercare_scheduled_time, while server.js computes and sends its own callSchedule. The contract must choose one authoritative schedule and use the supplied JSONB schedule if the API contract is retained.
Migration 0004 marks children inactive for a completed schedule; this behavior needs review against actual programme policy and must not be introduced to legacy records by a broad backfill.

### Registration
server.js computes p_estimated_dob from age and sends it to lafiya_register_enrolment. The official data rule is not to infer a child's date of birth from reported age. The API must stop calculating/sending this value. The database contract must retain actual date_of_birth only when supplied as an actual recorded value; it must not require an estimated DOB to enrol.

### Fresh-schema migrations
0001_init.sql is explicitly a clean-project initializer. It creates a different schema and UUID appointment key, so it is not a migration for the existing production database.
0003_final_dose_completion.sql assumes the newer vaccine_type/schedule_complete columns and checks uniqueness on child_id + vaccine_type. It cannot be run on the legacy production schema as-is. Its unique rule also requires clinical review of stage naming and historical rows.
0002_fix_callbacks_rls.sql assumes functions/policies from 0001 and cannot create the missing live schema.
The current README describes a separate draft project and must be corrected when a compatible migration set is prepared.

## Required next implementation design

1. Create a new clearly named additive migration for the legacy live schema. Do not reuse or edit 0001–0004 as if they were production-compatible.
2. Preserve all seven existing tables and all legacy columns; add the API contract fields without destructive renames.
3. Preserve bigint appointment.id and calls.appointment_id.
4. Create call_attempts and required indexes/constraints.
5. Implement schema version RPC and both RPCs with exact PostgREST argument names and types used by server.js.
6. Use p_call_schedule jsonb to insert precisely the schedule supplied by the API, with status='scheduled'; validate offsets and timestamps in Lagos call window.
7. Remove estimated-DOB generation from the API and RPC contract.
8. Map only unambiguous historical values. In particular, never treat legacy appointment.status='scheduled' or vaccine='Next dose due' as an administered vaccination.
9. Preserve consent evidence as recorded; do not manufacture consent timestamps or versions for historical rows.
10. Add callback danger booleans while preserving legacy danger_signs text and reason/notes.
11. Keep assigned_to text for backward compatibility until values are audited; add a separate typed assignee field if needed.
12. Add compatibility tests for exact RPC signatures, return JSON shape, inserts, and transaction rollback.

## Validation status

This is a source-level contract review only. No SQL was applied, no backend source file was changed, no production data was modified, no PR or deployment was created, and outbound calls remain paused.
