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

## Follow-up static review — 21 November 2026

Additional findings and corrections:

1. Corrected the legacy consent backfill. The new `consent_given` column defaults to false, so a plain `coalesce(consent_given, consent, false)` would mask historical true consent. The migration now copies legacy `consent` only when no newer consent lifecycle metadata exists; it does not invent timestamps or consent versions.
2. Enabled RLS on the new `call_attempts` table, explicitly revoked direct access from `public`, `anon`, and `authenticated`, and granted table access to `service_role`.
3. Added explicit required-field and null validation to the registration and vaccination RPCs, including supported language validation when follow-up calls are requested.
4. Added a duplicate child/vaccine-stage preflight and unique index for new vaccine records. Legacy appointment rows with null `vaccine_type` are preserved.
5. Added a database trigger preventing a schedule from being marked complete unless the recorded vaccine stage is the final 15-month dose. The check also rejects a null vaccine stage.
6. Re-ran static text checks: consent backfill, call-attempt RLS/revokes, RPC null checks, bigint appointment ID, PostgREST schema reload, and absence of destructive table/column/data statements all passed.
7. The repository has no automated test script; `package.json` currently exposes only `npm start`. SQL has not been executed against a test database, so these are static-review results only.

The migration remains unapplied. Production database, Render services, and Twilio configuration were not changed. A paid Supabase test branch is still required for runtime validation.


## Frontend-to-backend integration review — 21 November 2026

Read-only review of Elijah's frontend repository `elijahamosdogo-afk/Lafiya-line-` (default branch `main`) against this backend's `server.js` API routes.

### Confirmed frontend state

- The frontend is a single-page HTML/JavaScript application in `index.html`.
- Its application records are loaded and saved through `localStorage` under `lafiya_v8`; no API `fetch()` calls were found.
- Login uses hard-coded demo accounts and passwords in the browser. The “forgot password” action is simulated.
- Enrolment, appointments, call records, and callbacks are generated and updated locally. The UI labels itself as a prototype/demo.
- The frontend currently derives a child DOB from reported age using an approximate day conversion. This must not be carried into live integration: only a caregiver-confirmed actual DOB may be submitted as DOB; otherwise leave DOB unknown and retain reported age separately.
- The frontend enrolment flow does not currently collect a caregiver's full name, while the backend `POST /api/register` requires `fullName`.

### Backend API available for integration

- `POST /api/auth/login` — email/password sign-in; returns access token and user profile.
- `GET /api/auth/me` — validates the current token and returns the staff profile.
- `GET /api/bootstrap` — facility-scoped dashboard snapshot (facilities, caregivers, children, appointments, calls, attempts, callbacks, profiles).
- `POST /api/register` — new caregiver/child enrolment and initial dose/call schedule.
- `POST /api/vaccinations` — records a subsequent administered dose.
- `PATCH /api/caregivers/:id` — caregiver updates and consent lifecycle actions.
- `POST /api/callbacks` and `PATCH /api/callbacks/:id` — create and manage callback tasks.
- Additional staff, facility, call-initiation, and appointment routes exist; appointment edits intentionally return HTTP 501 because vaccination events must not be rewritten.

### Integration blockers and required design

1. Replace browser demo credentials with backend email/password authentication. Keep the access token in memory; never store the Supabase service key in the browser.
2. Add the caregiver's full name to enrolment. Do not manufacture it from the phone number.
3. Remove approximate DOB generation. Collect actual DOB only when known and confirmed; otherwise preserve age value/unit without asserting a DOB.
4. Replace local application record persistence with authenticated API requests and bootstrap responses. Retain local storage only for non-sensitive preferences such as theme and optional remembered email.
5. Map frontend roles and field names to backend profile and record fields; backend remains authoritative for facility scoping and permissions.
6. Replace simulated call/appointment/callback outcomes with backend responses. The UI must show calling readiness as paused and must not trigger real calls during integration testing.
7. Add loading, validation, expired-session, permission-denied, and API-error states before enabling live data.

### Branch/access result and next implementation step

- Frontend default branch `main` and an existing `elijahamosdogo-afk-patch-1` branch were visible during read-only inspection.
- Creating `integration/live-api-connection-2026-11` failed with GitHub HTTP 403: `Resource not accessible by integration`. No frontend file or branch was changed.
- Next step: obtain GitHub write access for the connected integration, or have the frontend repository owner create/push the integration branch. Then implement authentication first, followed by bootstrap/data mapping and the enrolment flow.
- No PR, frontend commit, merge, Render deployment, database migration, or outbound call was made as part of this review.
