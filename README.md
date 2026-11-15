# Lafiya Line API

Express API for the Lafiya Line dashboard. Supabase is accessed only from this server; the Supabase service key must never be added to the static frontend.

## Database migrations

Apply these in order to the separate draft Supabase project before deploying this version:

1. `supabase/migrations/0001_init.sql` — fresh project initialization (already applied to the draft project).
2. `supabase/migrations/0002_fix_callbacks_rls.sql` — callback policy correction (already applied and access-tested).
3. `supabase/migrations/0003_final_dose_completion.sql` — permits a child first enrolled at the actual 15-month final dose to complete the schedule without inventing past vaccination rows; prevents duplicate dose-stage records per child.
4. `supabase/migrations/0004_atomic_aftercare_vaccination.sql` — inserts a vaccination event and its two call rows in one database transaction.

Migrations 0001 and 0002 are already applied in the separate draft project. Apply 0003 and 0004 there before enrolling a child at 15 months. Until 0004 is applied, earlier stages use the server’s guarded non-final-stage fallback.

Do not rerun `0001_init.sql` on an existing project.

## Render environment

Required for the API and authenticated dashboard:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` — server-side only
- `PUBLIC_BASE_URL` — `https://lafiya-line-voice.onrender.com`
- `FRONTEND_ORIGIN` — `https://elijahamosdogo-afk.github.io`
- `CONSENT_VERSION` — defaults to `consent-v1`

Twilio values can remain unset while calls are paused:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_PHONE_NUMBER`
- `CALLS_ENABLED=false`
- `AUDIO_APPROVED=false`

Keep both call flags false until the language recordings include the approved full script, the next-dose closer, and the final keypad prompt. This repository currently contains only the four English/Hausa master MP3s; Kanuri audio and dose closers are not present. No real call has been verified end to end.

## Live dashboard

The static site signs in through Supabase Auth via `/api/auth/login`. Each request carries a short-lived access token. The server checks the staff profile and facility on every protected request before returning records. The browser keeps live records and the token in memory; it does not save live caregiver or child data in local storage.

The first system-admin profile must already exist in Supabase Auth and `public.profiles`; after that account signs in, staff and facility setup can happen in the dashboard.

The API creates one child record per child, reuses a caregiver record by facility and normalized phone number, saves an actual vaccination event, and creates independent 24-hour and 72-hour call rows when consent is active. A returning child uses `/api/vaccinations` to add the next administered dose to the same child. Twilio webhooks record attempt SID, keypad sequence, response, duration and terminal status. Press 1 creates one facility callback task. Automatic retry ladders are disabled.

Render Free web services sleep when idle. The in-process due-call and retention timers therefore require an always-on service to run reliably; use an always-on web service or a separately scheduled job before relying on the pilot workflow.
