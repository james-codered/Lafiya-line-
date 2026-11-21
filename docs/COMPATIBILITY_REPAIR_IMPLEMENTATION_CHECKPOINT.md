# Compatibility Repair Implementation Checkpoint

Date: 2026-11-21
Branch: fix/live-schema-compatibility-2026-11

## Changes committed to this development branch

1. Added `docs/LIVE_SCHEMA_COMPATIBILITY_PLAN.md` with the live schema audit and safety gates.
2. Added `docs/BACKEND_RPC_MIGRATION_CONTRACT_REVIEW.md` documenting RPC/migration incompatibilities.
3. Updated `server.js`:
   - Removed the age-derived `p_estimated_dob` argument from enrolment.
   - Added a comment making the no-inferred-DOB rule explicit.
   - Changed the children schema probe to check the real `child_name` and `date_of_birth` columns, plus reported-age fields; it no longer expects `estimated_date_of_birth`.
   - Updated the missing schema-version diagnostic to refer to the live-schema compatibility migration.
4. Added `supabase/migrations/0005_live_schema_compatibility.sql`:
   - Additive columns only; preserves legacy columns.
   - Preserves `appointment.id` and `calls.appointment_id` as bigint.
   - Creates `call_attempts`.
   - Adds callback metadata and danger-sign booleans without changing legacy `reason`, `notes`, `danger_signs`, or text `assigned_to`.
   - Adds schema-version RPC and registration/vaccination RPCs with argument names/types matching the updated server.
   - Uses the API-supplied JSONB call schedule and explicitly creates calls with status `scheduled`.
   - Does not calculate or populate DOB from reported age.
   - Preserves legacy appointment rows without interpreting their old vaccine/status/date values as administered doses.

## Important migration behavior

- Existing caregiver `name`, `language`, and `consent` values are copied into the new API columns; original columns remain.
- Legacy language labels are normalized to `en`, `ha`, or `kr` only where the value is recognized.
- Historical consent timestamps and consent-version values are not fabricated.
- New consent timestamps are recorded only when consent is explicitly true at new enrolment.
- Existing child DOB values are not changed.
- Existing appointment rows are not backfilled into new vaccination columns because the old values are not semantically reliable.
- Existing calls status values are not rewritten; only the default for future inserts changes to `scheduled`.

## Validation and release status

- Source edits and migration are committed to the development branch.
- Read-only live-schema inspection confirmed legacy nullable fields required by the RPC inserts and confirmed the real DOB column exists.
- No migration has been applied to production.
- No Supabase paid test branch has been activated.
- No production data has been changed.
- No Render deployment or PR has been created.
- Twilio calls remain paused.

## Required before test or production application

1. Activate a Supabase test branch only when the owner is ready for its hourly cost.
2. Apply migration 0005 to that test branch and fix any SQL/runtime issues found there.
3. Test enrolment with consent true and false, both call-schedule entries, returning-child vaccination, final-dose completion, callbacks, consent withdrawal, staff/facility creation, and schema readiness.
4. Confirm no historical rows changed and the bigint appointment relationship remains intact.
5. Run a full source-level and database-level test suite with Twilio disabled.
6. Review the final diff before PR/merge. Production deployment requires separate explicit release authorization.

This checkpoint is a development implementation, not a claim that the database is already compatible or that the migration has passed execution tests.
