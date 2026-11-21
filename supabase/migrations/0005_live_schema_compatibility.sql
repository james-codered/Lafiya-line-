-- Lafiya Line additive compatibility migration for the existing live schema.
-- Preserve legacy columns and records. Do not run against production until tested on a
-- separately activated Supabase test branch and reviewed.
begin;

-- Facilities: add the fields consumed by the current API. Existing location data stays intact.
alter table public.facilities
  add column if not exists code text,
  add column if not exists address text,
  add column if not exists is_active boolean not null default true;

-- Profiles already has full_name/is_active in the live schema. Keep this defensive and additive.
alter table public.profiles
  add column if not exists is_active boolean not null default true;

create unique index if not exists facilities_code_compat_uq
  on public.facilities(code) where code is not null;

-- Caregivers: retain name/language/consent as legacy source columns.
alter table public.caregivers
  add column if not exists full_name text,
  add column if not exists preferred_language text,
  add column if not exists consent_given boolean not null default false,
  add column if not exists consent_given_at timestamptz,
  add column if not exists consent_withdrawn_at timestamptz,
  add column if not exists consent_version text;

update public.caregivers
set full_name = coalesce(full_name, name),
    preferred_language = coalesce(
      preferred_language,
      case lower(coalesce(language, ''))
        when 'hausa' then 'ha'
        when 'ha' then 'ha'
        when 'kanuri' then 'kr'
        when 'kr' then 'kr'
        when 'english' then 'en'
        when 'en' then 'en'
        else null
      end
    ),
    consent_given = case
      -- The newly-added column defaults to false. Copy the legacy consent value
      -- only while no newer consent lifecycle metadata exists.
      when consent_given_at is null
       and consent_withdrawn_at is null
       and consent_version is null
      then coalesce(consent, false)
      else consent_given
    end
where full_name is null
   or preferred_language is null
   or (
     consent_given_at is null
     and consent_withdrawn_at is null
     and consent_version is null
     and consent_given is distinct from coalesce(consent, false)
   );

-- Children: age is retained as reported; date_of_birth remains an actual recorded DOB only.
alter table public.children
  add column if not exists age_value integer,
  add column if not exists age_unit text,
  add column if not exists enrolled_at date,
  add column if not exists is_active boolean not null default true;

-- Appointment: do not reinterpret legacy vaccine/status/appointment_date values as administered doses.
-- The bigint primary key is intentionally preserved.
alter table public.appointment
  add column if not exists vaccine_type text,
  add column if not exists vaccinated_at timestamptz,
  add column if not exists next_dose_stage text,
  add column if not exists next_dose_due_at timestamptz,
  add column if not exists schedule_complete boolean not null default false,
  add column if not exists schedule_completed_at timestamptz,
  add column if not exists recorded_by uuid;

-- Enforce one recorded instance of each new vaccine stage per child. Legacy rows
-- with vaccine_type NULL remain untouched and do not conflict with this constraint.
do $
begin
  if exists (
    select 1 from public.appointment
    where vaccine_type is not null
    group by child_id, vaccine_type
    having count(*) > 1
  ) then
    raise exception 'duplicate child vaccine stages exist; review them before adding the unique index';
  end if;
end;
$;

create unique index if not exists appointment_child_stage_once_uq
  on public.appointment(child_id, vaccine_type);

create or replace function public.validate_completed_vaccination_schedule()
returns trigger
language plpgsql
set search_path = ''
as $
begin
  if new.schedule_complete and new.vaccine_type <> '15 months - Nine-month' then
    raise exception 'only the administered 15-month final dose can complete the schedule';
  end if;
  return new;
end;
$;

drop trigger if exists appointment_completed_schedule_guard on public.appointment;
create trigger appointment_completed_schedule_guard
before insert or update of schedule_complete, vaccine_type
on public.appointment
for each row execute function public.validate_completed_vaccination_schedule();

-- Calls: new API-created calls are scheduled explicitly and carry their follow-up interval.
alter table public.calls
  add column if not exists follow_up_hours integer,
  add column if not exists language_code text,
  add column if not exists completed_at timestamptz,
  add column if not exists retention_expires_at timestamptz;

alter table public.calls alter column status set default 'scheduled';

-- Call attempts are new; no legacy table or data is replaced.
create table if not exists public.call_attempts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  attempt_number integer not null check (attempt_number between 1 and 3),
  status text not null default 'initiated',
  twilio_call_sid text,
  provider_status text,
  keypad_sequence integer[] not null default '{}',
  response text,
  outcome text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer,
  retention_expires_at timestamptz,
  created_at timestamptz not null default now(),
  constraint call_attempts_call_attempt_once unique (call_id, attempt_number)
);

create index if not exists call_attempts_call_id_idx on public.call_attempts(call_id);
create index if not exists call_attempts_status_started_at_idx on public.call_attempts(status, started_at);

-- Keep call-attempt data inaccessible to direct client roles; the backend service role
-- is the only application actor that should read or write provider call metadata.
alter table public.call_attempts enable row level security;
revoke all on table public.call_attempts from public, anon, authenticated;
grant all on table public.call_attempts to service_role;

-- Callbacks: preserve reason, notes, danger_signs and assigned_to text for backward compatibility.
alter table public.callbacks
  add column if not exists source text,
  add column if not exists priority text,
  add column if not exists description text,
  add column if not exists created_by uuid,
  add column if not exists resolution text,
  add column if not exists called_back_at timestamptz,
  add column if not exists retention_expires_at timestamptz,
  add column if not exists danger_stopped_feeding boolean not null default false,
  add column if not exists danger_fits_or_shaking boolean not null default false,
  add column if not exists danger_vomiting_everything boolean not null default false,
  add column if not exists danger_unusually_sleepy_or_hard_to_wake boolean not null default false,
  add column if not exists danger_fast_or_difficult_breathing boolean not null default false,
  add column if not exists danger_yellow_eyes_or_skin boolean not null default false,
  add column if not exists danger_injection_site_large_hot_or_pus boolean not null default false;

-- Indexes used by the API/dispatcher. appointment.id remains bigint throughout.
create index if not exists calls_due_dispatch_idx
  on public.calls(status, scheduled_at)
  where follow_up_hours is not null;
create index if not exists appointment_child_id_compat_idx on public.appointment(child_id);
create index if not exists callbacks_call_id_compat_idx on public.callbacks(call_id);

-- Version endpoint used by the backend's schema readiness check.
create or replace function public.lafiya_schema_version()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select 'lafiya-2026-11-v1'::text;
$$;

revoke all on function public.lafiya_schema_version() from public, anon, authenticated;
grant execute on function public.lafiya_schema_version() to service_role;

-- Atomic registration. DOB is deliberately not an argument: reported age must never be
-- converted into an estimated date of birth.
create or replace function public.lafiya_register_enrolment(
  p_facility_id uuid,
  p_full_name text,
  p_phone text,
  p_language_code text,
  p_referred_by text,
  p_consent_given boolean,
  p_consent_version text,
  p_age_value integer,
  p_age_unit text,
  p_enrolled_at date,
  p_vaccine_type text,
  p_next_dose_stage text,
  p_next_dose_due_at timestamptz,
  p_schedule_complete boolean,
  p_recorded_by uuid,
  p_vaccinated_at timestamptz,
  p_call_schedule jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caregiver_id uuid;
  v_child_id uuid;
  v_appointment_id bigint;
  v_call_ids uuid[] := array[]::uuid[];
  v_call_id uuid;
  v_item jsonb;
  v_hours integer;
  v_at timestamptz;
begin
  if p_schedule_complete is null or p_enrolled_at is null or p_vaccinated_at is null
     or p_vaccine_type is null or length(btrim(p_vaccine_type)) = 0 then
    raise exception 'INVALID_VACCINATION: vaccination details are incomplete';
  end if;
  if p_facility_id is null or p_full_name is null or length(btrim(p_full_name)) < 2 then
    raise exception 'NAME_REQUIRED: caregiver name is required';
  end if;
  if p_consent_given is null then
    raise exception 'CONSENT_REQUIRED: consent state must be explicit';
  end if;
  if p_age_value is null or p_age_value < 0 or p_age_unit is null or p_age_unit not in ('weeks', 'months') then
    raise exception 'INVALID_AGE: reported age is invalid';
  end if;
  if p_language_code is null or p_language_code not in ('en', 'ha', 'kr') then
    raise exception 'INVALID_LANGUAGE: unsupported language code';
  end if;

  insert into public.caregivers (
    facility_id, full_name, name, phone, preferred_language, language,
    consent_given, consent, consent_given_at, consent_withdrawn_at,
    consent_version, referred_by
  ) values (
    p_facility_id, btrim(p_full_name), btrim(p_full_name), p_phone,
    p_language_code,
    case p_language_code when 'ha' then 'Hausa' when 'kr' then 'Kanuri' else 'English' end,
    p_consent_given, p_consent_given,
    case when p_consent_given then now() else null end,
    null, p_consent_version, p_referred_by
  ) returning id into v_caregiver_id;

  insert into public.children (
    caregiver_id, facility_id, age_value, age_unit, enrolled_at, is_active
  ) values (
    v_caregiver_id, p_facility_id, p_age_value, p_age_unit, p_enrolled_at, not p_schedule_complete
  ) returning id into v_child_id;

  insert into public.appointment (
    child_id, vaccine_type, vaccinated_at, next_dose_stage,
    next_dose_due_at, schedule_complete, schedule_completed_at, recorded_by
  ) values (
    v_child_id, p_vaccine_type, p_vaccinated_at, p_next_dose_stage,
    p_next_dose_due_at, p_schedule_complete,
    case when p_schedule_complete then p_vaccinated_at else null end,
    p_recorded_by
  ) returning id into v_appointment_id;

  if p_consent_given then
    if jsonb_typeof(coalesce(p_call_schedule, '[]'::jsonb)) <> 'array' then
      raise exception 'INVALID_CALL_SCHEDULE: schedule must be a JSON array';
    end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_call_schedule, '[]'::jsonb))
    loop
      v_hours := (v_item ->> 'hours')::integer;
      v_at := (v_item ->> 'at')::timestamptz;
      if v_hours is null or v_hours not in (24, 72) or v_at is null then
        raise exception 'INVALID_CALL_SCHEDULE: each item needs 24/72 hours and a timestamp';
      end if;
      insert into public.calls (appointment_id, follow_up_hours, scheduled_at, language_code, status)
      values (v_appointment_id, v_hours, v_at, p_language_code, 'scheduled')
      returning id into v_call_id;
      v_call_ids := array_append(v_call_ids, v_call_id);
    end loop;
  end if;

  return jsonb_build_object(
    'caregiver_id', v_caregiver_id,
    'child_id', v_child_id,
    'appointment_id', v_appointment_id,
    'call_ids', v_call_ids
  );
end;
$$;

revoke all on function public.lafiya_register_enrolment(uuid,text,text,text,text,boolean,text,integer,text,date,text,text,timestamptz,boolean,uuid,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.lafiya_register_enrolment(uuid,text,text,text,text,boolean,text,integer,text,date,text,text,timestamptz,boolean,uuid,timestamptz,jsonb) to service_role;

-- Atomic vaccination RPC. The bigint appointment key is preserved and the API-supplied
-- Lagos-adjusted schedule is authoritative.
create or replace function public.create_aftercare_vaccination(
  p_child_id uuid,
  p_vaccine_type text,
  p_vaccinated_at timestamptz,
  p_next_dose_stage text,
  p_next_dose_due_at timestamptz,
  p_schedule_complete boolean,
  p_schedule_completed_at timestamptz,
  p_recorded_by uuid,
  p_language_code text,
  p_create_calls boolean,
  p_call_schedule jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id bigint;
  v_call_ids uuid[] := array[]::uuid[];
  v_call_id uuid;
  v_item jsonb;
  v_hours integer;
  v_at timestamptz;
begin
  if p_schedule_complete is null or p_create_calls is null
     or p_vaccinated_at is null or p_vaccine_type is null
     or length(btrim(p_vaccine_type)) = 0 then
    raise exception 'INVALID_VACCINATION: vaccination details are incomplete';
  end if;
  if p_create_calls and (p_language_code is null or p_language_code not in ('en', 'ha', 'kr')) then
    raise exception 'INVALID_LANGUAGE: unsupported language code';
  end if;
  if p_child_id is null or not exists (select 1 from public.children where id = p_child_id) then
    raise exception 'CHILD_NOT_FOUND: child does not exist';
  end if;
  insert into public.appointment (
    child_id, vaccine_type, vaccinated_at, next_dose_stage,
    next_dose_due_at, schedule_complete, schedule_completed_at, recorded_by
  ) values (
    p_child_id, p_vaccine_type, p_vaccinated_at, p_next_dose_stage,
    p_next_dose_due_at, p_schedule_complete, p_schedule_completed_at, p_recorded_by
  ) returning id into v_appointment_id;

  if p_create_calls then
    if jsonb_typeof(coalesce(p_call_schedule, '[]'::jsonb)) <> 'array' then
      raise exception 'INVALID_CALL_SCHEDULE: schedule must be a JSON array';
    end if;
    for v_item in select value from jsonb_array_elements(coalesce(p_call_schedule, '[]'::jsonb))
    loop
      v_hours := (v_item ->> 'hours')::integer;
      v_at := (v_item ->> 'at')::timestamptz;
      if v_hours is null or v_hours not in (24, 72) or v_at is null then
        raise exception 'INVALID_CALL_SCHEDULE: each item needs 24/72 hours and a timestamp';
      end if;
      insert into public.calls (appointment_id, follow_up_hours, scheduled_at, language_code, status)
      values (v_appointment_id, v_hours, v_at, p_language_code, 'scheduled')
      returning id into v_call_id;
      v_call_ids := array_append(v_call_ids, v_call_id);
    end loop;
  end if;

  if p_schedule_complete then
    update public.children set is_active = false where id = p_child_id;
  end if;

  return jsonb_build_object('appointment_id', v_appointment_id, 'call_ids', v_call_ids);
end;
$$;

revoke all on function public.create_aftercare_vaccination(uuid,text,timestamptz,text,timestamptz,boolean,timestamptz,uuid,text,boolean,jsonb) from public, anon, authenticated;
grant execute on function public.create_aftercare_vaccination(uuid,text,timestamptz,text,timestamptz,boolean,timestamptz,uuid,text,boolean,jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
