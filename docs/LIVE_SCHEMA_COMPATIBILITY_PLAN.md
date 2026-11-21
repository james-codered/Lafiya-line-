# Live Schema Compatibility Plan

Status: audit complete; implementation draft pending test-database validation.
Target branch: fix/live-schema-compatibility-2026-11
Production database and Render deployment: unchanged.
Outbound calling: remain paused.

## Verified live database facts

The live public schema contains seven tables: facilities, profiles, caregivers, children, appointment, calls, callbacks.

Current row counts at audit time:
- facilities: 1
- profiles: 1
- caregivers: 2
- children: 2
- appointment: 4
- calls: 0
- callbacks: 0

The live appointment primary key is bigint. Calls.appointment_id is bigint and references appointment.id. Do not convert either type.

Historical appointment values include two rows labelled "6 weeks dose" with status "attended", and two rows labelled "Next dose due" with status "scheduled". Preserve these legacy values. A scheduled next dose is not evidence that a vaccination was administered; do not transform it into an administered dose.

Both current children have an actual date_of_birth value. Retain those exact dates. Never calculate or backfill DOB from age.

Caregiver legacy language values include Hausa and Kanuri; consent is true for both current rows. Consent timestamps/version are not currently recorded. Do not invent historical consent timestamps or consent-version evidence.

## Confirmed API/database mismatches

- facilities: API expects code, address, is_active; live schema has location, operating_days, operating_hours and lacks code/address/is_active.
- caregivers: API expects full_name, preferred_language, consent_given, consent_given_at, consent_withdrawn_at, consent_version, is_active; live schema has name, language, consent.
- children: API expects facility_id, age_value, age_unit, enrolled_at, is_active and currently probes estimated_date_of_birth; live schema has child_name and actual date_of_birth. Do not infer DOB. Age fields are not present in legacy records.
- appointment: API expects vaccine_type, vaccinated_at, next_dose_stage, next_dose_due_at, schedule_complete, schedule_completed_at, recorded_by; live schema has vaccine, dose_number, appointment_date, status, returned. Preserve all legacy columns and records. appointment.id remains bigint.
- calls: API expects follow_up_hours, language_code, completed_at, retention_expires_at and scheduled status; live schema has call_type and pending as its default status. Calls currently has zero rows.
- call_attempts: missing; backend requires it.
- callbacks: API expects source, priority, description, created_by, assigned_to, resolution, called_back_at, completed_at, retention_expires_at and seven danger booleans. Legacy schema has reason, notes, danger_signs and assigned_to text. Preserve legacy columns; do not change assigned_to type until all legacy values are audited.

## Critical backend corrections required

1. Remove age-derived estimated DOB calculation and stop sending p_estimated_dob to the database. Keep actual DOB only when explicitly recorded.
2. Reconcile API fields with live columns through an additive migration or carefully controlled compatibility layer; do not rename/drop legacy columns.
3. Keep appointment.id and calls.appointment_id as bigint.
4. Update the vaccination RPC to accept the API's p_call_schedule JSONB argument and insert the supplied schedule, rather than independently inventing a different schedule.
5. Ensure new call rows use a dispatcher-compatible scheduled status and include follow_up_hours and language_code.
6. Create call_attempts with UUID primary key, call_id FK, attempt_number, and unique(call_id, attempt_number), plus fields used by webhook and retention code.
7. Add callback metadata and seven danger booleans additively. Preserve legacy reason/notes/danger_signs and text assigned_to.
8. Add the schema-version RPC expected by the backend, with a version constant that matches server.js.
9. Audit all inserts/updates and constraints before dropping unsafe gen_random_uuid() defaults from foreign-key columns. Do not change those defaults until this audit is complete.
10. Check all unique-dose and callback constraints against existing data before adding any uniqueness rules.

## Safety gates before any production migration

- Create/activate the separately billed Supabase test branch only when the owner is ready to incur the stated cost.
- Apply the additive migration to that test branch, never to production first.
- Run SQL preflight checks and confirm no rows are rewritten or lost.
- Test enrolment, returning-child vaccination, callbacks, consent withdrawal, bootstrap, and dispatcher selection with Twilio disabled.
- Verify service-role access and confirm anon/authenticated remain denied.
- Review migration diff and API changes before creating a PR.
- Do not merge or deploy without explicit release authorization.

## Current work status

This file records the verified compatibility plan only. No production DDL, application source edits, PR, merge, Render deployment, or outbound call was performed during this audit.
