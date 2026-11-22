# Lafiya Line integration repair checkpoint — 22 Nov 2026

## Verified on main

- Frontend repository: elijahamosdogo-afk/Lafiya-line- (standalone index.html)
- Backend repository: james-codered/Lafiya-line- (Express/Supabase/Twilio server)
- Frontend presently runs a seeded demo workflow using browser localStorage; its source does not implement the backend authentication/bootstrap/API contract.
- Backend expects Supabase Auth sign-in, /api/bootstrap, /api/register, /api/vaccinations, caregiver/callback/call endpoints and schema readiness RPC.
- Backend startup requires SUPABASE_URL and SUPABASE_SECRET_KEY. Twilio outbound calling is guarded by CALLS_ENABLED, AUDIO_APPROVED and Twilio credentials.
- Backend migration 0004 in main defines create_aftercare_vaccination with a 10-argument signature and creates the 24/72h calls internally using aftercare_scheduled_time. The current server.js call sends additional parameters p_schedule_complete and p_call_schedule. The live schema audit has already identified a compatibility migration/RPC gap. These files/signatures need to be reconciled before calling the API against a database.
- README and deployed frontend disagree with the actual standalone demo index. The integration must replace the demo login/data state with the real API, not attempt to merge browser seed data into live records.

## Safety status

- No production data was edited.
- No database migrations were applied.
- Outbound calls remain disabled pending audio, schema and deployment verification.
- The audit branch is isolated from main.

## Required implementation sequence

1. Create a real frontend API/auth client and replace demo-only seeded login and localStorage persistence with token-backed API calls and bootstrap data.
2. Align the RPC call signature and migrations, including the registration function, after validation against the draft database.
3. Exercise registration, dose tracking, callback creation, consent withdrawal, staff/facility scoping, login, bootstrap and call workflow in a test environment.
4. Validate Twilio/audio in a non-production test environment; keep calls disabled until scripts/assets and approval are complete.
5. Release via reviewed PRs and a deployment checklist. Never copy demo credentials or seed records into production.
