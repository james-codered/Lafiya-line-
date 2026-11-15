-- Lafiya Line Supabase fresh-project initialization: 0001_init.sql
-- Target: Supabase PostgreSQL. Creates the eight application tables for a clean project.
-- It assumes Supabase's auth.users and auth.uid() are available.
-- Do not run this in any project where an earlier Lafiya Line schema was applied; obtain and review that project's actual DDL first.

begin;

create table public.facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  code text not null unique check (length(btrim(code)) > 0),
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'), -- facility duty phone; backend sends worried-response notification here
  address text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  facility_id uuid references public.facilities(id) on delete restrict,
  role text not null check (role in ('facility_admin', 'health_worker', 'system_admin')),
  full_name text not null check (length(btrim(full_name)) > 0),
  phone text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_role_facility_ck check (
    (role = 'system_admin' and facility_id is null)
    or (role in ('facility_admin', 'health_worker') and facility_id is not null)
  )
);

alter table public.facilities add column in_charge_profile_id uuid references public.profiles(id) on delete set null;
create unique index facilities_in_charge_profile_uq on public.facilities(in_charge_profile_id) where in_charge_profile_id is not null;

create function public.validate_facility_in_charge() returns trigger
language plpgsql set search_path = '' as $$
declare profile_facility uuid;
declare profile_role text;
begin
  if new.in_charge_profile_id is null then return new; end if;
  select p.facility_id, p.role into profile_facility, profile_role
  from public.profiles p where p.id = new.in_charge_profile_id;
  if profile_facility is distinct from new.id or profile_role not in ('facility_admin', 'health_worker') then
    raise exception 'facility in-charge must be an admin or health worker assigned to that facility';
  end if;
  return new;
end;
$$;
create trigger facilities_validate_in_charge before insert or update of in_charge_profile_id on public.facilities
for each row execute function public.validate_facility_in_charge();

create table public.caregivers (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  full_name text not null check (length(btrim(full_name)) > 0),
  phone text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'), -- required at enrolment; nullable only after recorded deletion
  preferred_language text not null check (preferred_language in ('en', 'ha', 'kr')), -- English, Hausa, Kanuri
  consent_given boolean not null default false,
  consent_given_at timestamptz,
  consent_withdrawn_at timestamptz,
  consent_version text check (consent_version is null or consent_version ~ '^consent-v[0-9]+$'),
  referred_by text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  phone_deleted_at timestamptz,
  -- Phone is required at enrolment; null is valid only after deletion is timestamped.
  constraint caregivers_phone_retention_ck check (
    (phone is not null and phone_deleted_at is null)
    or (phone is null and phone_deleted_at is not null)
  ),
  constraint caregivers_consent_timestamp_ck check (
    (consent_given_at is null and consent_withdrawn_at is null and consent_version is null and not consent_given)
    or (consent_given_at is not null and consent_version is not null and (
      (consent_given and consent_withdrawn_at is null)
      or (not consent_given and consent_withdrawn_at is not null and consent_withdrawn_at >= consent_given_at)
    ))
  )
);

-- Timestamp every phone removal and clear the timestamp if a replacement number is entered.
create function public.track_caregiver_phone_deletion() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.phone is not null then
    new.phone_deleted_at := null;
  elsif tg_op = 'UPDATE' then
    if old.phone is not null then
      new.phone_deleted_at := coalesce(new.phone_deleted_at, now());
    elsif old.phone_deleted_at is not null then
      new.phone_deleted_at := old.phone_deleted_at;
    elsif new.phone_deleted_at is not null then
      raise exception 'phone_deleted_at requires a previously stored phone number';
    end if;
  elsif tg_op = 'INSERT' and new.phone_deleted_at is not null then
    raise exception 'phone_deleted_at is set automatically when a stored phone is removed';
  end if;
  return new;
end;
$$;
create trigger caregivers_track_phone_deletion before insert or update of phone, phone_deleted_at
on public.caregivers for each row execute function public.track_caregiver_phone_deletion();

create table public.children (
  id uuid primary key default gen_random_uuid(),
  caregiver_id uuid not null references public.caregivers(id) on delete restrict,
  full_name text check (full_name is null or length(btrim(full_name)) > 0),
  age_value integer not null check (age_value > 0),
  age_unit text not null check (age_unit in ('weeks', 'months')),
  enrolled_at date not null default current_date,
  estimated_date_of_birth date generated always as (
    (enrolled_at - case when age_unit = 'weeks' then make_interval(weeks => age_value) else make_interval(months => age_value) end)::date
  ) stored,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.appointment (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null references public.children(id) on delete restrict,
  vaccine_type text not null check (vaccine_type in ('Birth - BCG', '6 weeks - Rotavirus', '10 weeks - Rotavirus', '14 weeks - Rotavirus', '9 months - Nine-month', '15 months - Nine-month')),
  vaccinated_at timestamptz not null,
  schedule_complete boolean not null default false,
  schedule_completed_at timestamptz,
  next_dose_stage text check (next_dose_stage in ('Birth - BCG', '6 weeks - Rotavirus', '10 weeks - Rotavirus', '14 weeks - Rotavirus', '9 months - Nine-month', '15 months - Nine-month')),
  next_dose_due_at timestamptz,
  recorded_by uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointment_schedule_completion_ck check (
    (schedule_complete and schedule_completed_at is not null and vaccine_type = '15 months - Nine-month'
      and next_dose_stage is null and next_dose_due_at is null)
    or (not schedule_complete and schedule_completed_at is null
      and next_dose_stage is not null and next_dose_due_at is not null)
  )
);

create unique index appointment_completed_schedule_once_uq on public.appointment(child_id)
where schedule_complete;

-- A schedule is complete only after all six listed dose stages are recorded for the child.
create function public.validate_completed_vaccination_schedule() returns trigger
language plpgsql set search_path = '' as $$
declare dose_stage_count integer;
begin
  if new.schedule_complete then
    select count(distinct a.vaccine_type) into dose_stage_count
    from public.appointment a where a.child_id = new.child_id;
    if new.vaccine_type <> '15 months - Nine-month' or dose_stage_count < 6 then
      raise exception 'schedule completion requires all six recorded stages including the 15-month stage';
    end if;
  end if;
  return new;
end;
$$;
create trigger appointment_validate_complete_schedule after insert or update of schedule_complete, vaccine_type, child_id
on public.appointment for each row execute function public.validate_completed_vaccination_schedule();

-- Once complete, lock every vaccination event for the child against later edits or deletion.
create function public.prevent_completed_schedule_changes() returns trigger
language plpgsql set search_path = '' as $$
declare completed_schedule_exists boolean;
begin
  select exists (
    select 1 from public.appointment a
    where a.child_id = old.child_id and a.schedule_complete
  ) into completed_schedule_exists;
  if completed_schedule_exists then
    raise exception 'vaccination records are locked after schedule completion; use an approved correction process';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger appointment_lock_completed_schedule before update or delete on public.appointment
for each row execute function public.prevent_completed_schedule_changes();

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointment(id) on delete restrict,
  follow_up_hours smallint not null check (follow_up_hours in (24, 72)),
  scheduled_at timestamptz not null,
  language_code text not null check (language_code in ('en', 'ha', 'kr')), -- English, Hausa, Kanuri
  status text not null default 'scheduled'
    check (status in ('scheduled', 'in_progress', 'answered_well', 'answered_worried', 'no_answer', 'failed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retention_expires_at timestamptz not null default (now() + interval '24 months'),
  constraint calls_one_each_followup_uq unique (appointment_id, follow_up_hours),
  constraint calls_terminal_timestamp_ck check (
    (status in ('scheduled', 'in_progress') and completed_at is null)
    or (status in ('answered_well', 'answered_worried', 'no_answer', 'failed', 'cancelled') and completed_at is not null)
  )
);

create table public.call_attempts (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete restrict,
  attempt_number smallint not null check (attempt_number >= 1),
  status text not null default 'initiated' check (status in ('initiated', 'ringing', 'completed')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  twilio_call_sid text unique,
  outcome text check (outcome in (
    'answered', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'failed', 'canceled', 'voicemail', 'unknown'
  )),
  keypad_sequence smallint[] not null default '{}',
  response text check (response in ('worried', 'well')),
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  provider_status text,
  retention_expires_at timestamptz not null default (now() + interval '24 months'),
  created_at timestamptz not null default now(),
  constraint call_attempts_number_uq unique (call_id, attempt_number),
  constraint call_attempts_time_ck check (ended_at is null or ended_at >= started_at),
  constraint call_attempts_status_outcome_ck check ((status = 'completed' and outcome is not null) or (status <> 'completed' and outcome is null)),
  constraint call_attempts_response_ck check (response is null or outcome = 'answered'),
  constraint call_attempts_keypad_sequence_ck check (
    cardinality(keypad_sequence) <= 20 and keypad_sequence <@ array[0,1,2,3,4,5,6,7,8,9]::smallint[]
  )
);

create table public.callbacks (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references public.facilities(id) on delete restrict,
  child_id uuid not null references public.children(id) on delete restrict,
  call_id uuid references public.calls(id) on delete restrict,
  source text not null check (source in ('worried_24h', 'worried_72h', 'manual')),
  priority text not null default 'normal' check (priority in ('normal', 'urgent')),
  status text not null default 'open' check (status in ('open', 'assigned', 'in_progress', 'completed', 'cancelled')),
  assigned_to uuid references public.profiles(id) on delete set null,
  description text,
  danger_stopped_feeding boolean not null default false,
  danger_fits_or_shaking boolean not null default false,
  danger_vomiting_everything boolean not null default false,
  danger_unusually_sleepy_or_hard_to_wake boolean not null default false,
  danger_fast_or_difficult_breathing boolean not null default false,
  danger_yellow_eyes_or_skin boolean not null default false,
  danger_injection_site_large_hot_or_pus boolean not null default false,
  resolution text check (resolution in ('reassured', 'come_in_today', 'escalated')),
  called_back_at timestamptz,
  duty_phone_notified_at timestamptz,
  duty_phone_twilio_sid text unique,
  created_by uuid references public.profiles(id) on delete set null,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  retention_expires_at timestamptz not null default (now() + interval '24 months'),
  constraint callbacks_completed_timestamp_ck check (
    (status = 'completed' and completed_at is not null)
    or (status <> 'completed' and completed_at is null)
  ),
  constraint callbacks_danger_urgent_ck check (source not in ('worried_24h', 'worried_72h') or priority = 'urgent'),
  constraint callbacks_danger_due_ck check (source not in ('worried_24h', 'worried_72h') or due_at = created_at + interval '2 hours'),
  constraint callbacks_resolution_ck check (status <> 'completed' or (resolution is not null and called_back_at is not null))
);

-- Worried callbacks are due two hours from creation and enter the urgent queue.
create function public.initialize_worried_callback() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_at := coalesce(new.created_at, now());
  if new.source in ('worried_24h', 'worried_72h') then
    new.priority := 'urgent';
    new.due_at := new.created_at + interval '2 hours';
  end if;
  return new;
end;
$$;
create trigger callbacks_initialize_worried before insert or update of source on public.callbacks
for each row execute function public.initialize_worried_callback();

create function public.validate_callback_links() returns trigger
language plpgsql set search_path = '' as $$
declare child_facility uuid;
declare assigned_facility uuid;
declare linked_child uuid;
begin
  select cg.facility_id into child_facility
  from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id
  where ch.id = new.child_id;
  if child_facility is distinct from new.facility_id then
    raise exception 'callback facility must match the child caregiver facility';
  end if;
  if new.assigned_to is not null then
    select p.facility_id into assigned_facility from public.profiles p
    where p.id = new.assigned_to and p.role in ('facility_admin', 'health_worker') and p.is_active;
    if assigned_facility is distinct from new.facility_id then
      raise exception 'callback assignee must be active staff at the same facility';
    end if;
  end if;
  if new.call_id is not null then
    select a.child_id into linked_child from public.calls c join public.appointment a on a.id = c.appointment_id
    where c.id = new.call_id;
    if linked_child is distinct from new.child_id then
      raise exception 'callback child must match the linked call child';
    end if;
  end if;
  return new;
end;
$$;
create trigger callbacks_validate_links before insert or update of facility_id, child_id, call_id, assigned_to
on public.callbacks for each row execute function public.validate_callback_links();

-- The clinical danger-sign vocabulary must be finalized by the clinical lead; validate it in backend until approved.

-- At most one auto-generated callback per scheduled call; manual callbacks may have no call.
create unique index callbacks_call_once_uq on public.callbacks(call_id) where call_id is not null;

create index caregivers_facility_idx on public.caregivers(facility_id);
create index children_caregiver_idx on public.children(caregiver_id);
create index appointment_child_vaccinated_idx on public.appointment(child_id, vaccinated_at desc);
create index calls_due_idx on public.calls(scheduled_at) where status = 'scheduled';
create index call_attempts_call_idx on public.call_attempts(call_id, attempt_number);
create index calls_retention_expiry_idx on public.calls(retention_expires_at);
create index call_attempts_retention_expiry_idx on public.call_attempts(retention_expires_at);
create index callbacks_retention_expiry_idx on public.callbacks(retention_expires_at);
create index callbacks_facility_queue_idx on public.callbacks(facility_id, status, priority, created_at);
create index callbacks_due_queue_idx on public.callbacks(facility_id, due_at) where status in ('open', 'assigned', 'in_progress');
create index callbacks_assignee_idx on public.callbacks(assigned_to) where assigned_to is not null;
create index profiles_facility_role_idx on public.profiles(facility_id, role);

-- Keep updated_at consistent on mutable records.
create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger facilities_set_updated_at before update on public.facilities for each row execute function public.set_updated_at();
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger caregivers_set_updated_at before update on public.caregivers for each row execute function public.set_updated_at();
create trigger children_set_updated_at before update on public.children for each row execute function public.set_updated_at();
create trigger appointment_set_updated_at before update on public.appointment for each row execute function public.set_updated_at();
create trigger calls_set_updated_at before update on public.calls for each row execute function public.set_updated_at();
create trigger callbacks_set_updated_at before update on public.callbacks for each row execute function public.set_updated_at();

-- Schedule at or after the offset, inside the pilot's 07:00-20:00 Africa/Lagos window.
create function public.aftercare_scheduled_time(vaccination_time timestamptz, offset_hours integer) returns timestamptz
language plpgsql immutable set search_path = '' as $$
declare target_time timestamptz;
declare local_target timestamp;
begin
  target_time := vaccination_time + make_interval(hours => offset_hours);
  local_target := target_time at time zone 'Africa/Lagos';
  if local_target::time < time '07:00' then
    return (local_target::date + time '07:00') at time zone 'Africa/Lagos';
  elsif local_target::time > time '20:00' then
    return (local_target::date + 1 + time '07:00') at time zone 'Africa/Lagos';
  end if;
  return target_time;
end;
$$;

-- Enforce both 24/72-hour anchors and the calling window.
create function public.validate_call_schedule() returns trigger
language plpgsql set search_path = '' as $$
declare vaccination_time timestamptz;
begin
  select a.vaccinated_at into vaccination_time
  from public.appointment a where a.id = new.appointment_id;
  if vaccination_time is null or new.scheduled_at <> public.aftercare_scheduled_time(vaccination_time, new.follow_up_hours) then
    raise exception 'scheduled_at must match the aftercare offset and 07:00-20:00 Africa/Lagos window';
  end if;
  return new;
end;
$$;
create trigger calls_validate_schedule before insert or update of appointment_id, follow_up_hours, scheduled_at
on public.calls for each row execute function public.validate_call_schedule();

-- If a vaccination timestamp is corrected before a call starts, keep scheduled calls aligned.
-- Once any call is no longer scheduled, require an explicit audited correction workflow instead.
create function public.reschedule_calls_after_vaccination_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.vaccinated_at is distinct from old.vaccinated_at then
    if exists (select 1 from public.calls c where c.appointment_id = new.id and c.status <> 'scheduled') then
      raise exception 'vaccinated_at cannot be changed after an aftercare call has started or become terminal';
    end if;
    update public.calls c
    set scheduled_at = public.aftercare_scheduled_time(new.vaccinated_at, c.follow_up_hours)
    where c.appointment_id = new.id and c.status = 'scheduled';
  end if;
  return new;
end;
$$;
create trigger appointment_reschedule_calls after update of vaccinated_at on public.appointment
for each row execute function public.reschedule_calls_after_vaccination_change();

-- SECURITY DEFINER helpers avoid recursive profile RLS lookups in policies.
create function public.current_app_role() returns text
language sql stable security definer set search_path = '' set row_security = off as $$
  select p.role from public.profiles p where p.id = (select auth.uid()) and p.is_active
$$;

create function public.current_facility_id() returns uuid
language sql stable security definer set search_path = '' set row_security = off as $$
  select p.facility_id from public.profiles p where p.id = (select auth.uid()) and p.is_active
$$;

create function public.is_system_admin() returns boolean
language sql stable security definer set search_path = '' set row_security = off as $$
  select coalesce(public.current_app_role() = 'system_admin', false)
$$;

revoke all on function public.current_app_role() from public;
revoke all on function public.current_facility_id() from public;
revoke all on function public.is_system_admin() from public;
grant execute on function public.current_app_role() to authenticated;
grant execute on function public.current_facility_id() to authenticated;
grant execute on function public.is_system_admin() to authenticated;

alter table public.facilities enable row level security;
alter table public.profiles enable row level security;
alter table public.caregivers enable row level security;
alter table public.children enable row level security;
alter table public.appointment enable row level security;
alter table public.calls enable row level security;
alter table public.call_attempts enable row level security;
alter table public.callbacks enable row level security;

-- System administrators are global. Facility staff see only their facility.
-- LGA personnel have no app role or database access; the facility in-charge reports the daily open-task list outside the app via an approved channel.
create policy facilities_select on public.facilities for select to authenticated
using (public.is_system_admin() or id = public.current_facility_id());
create policy facilities_insert on public.facilities for insert to authenticated
with check (public.is_system_admin());
create policy facilities_update on public.facilities for update to authenticated
using (public.is_system_admin()) with check (public.is_system_admin());

create policy profiles_select on public.profiles for select to authenticated
using (public.is_system_admin() or id = (select auth.uid()) or facility_id = public.current_facility_id());
create policy profiles_insert on public.profiles for insert to authenticated
with check (
  public.is_system_admin()
  or (public.current_app_role() = 'facility_admin' and role = 'health_worker' and facility_id = public.current_facility_id())
);
create policy profiles_update on public.profiles for update to authenticated
using ((public.is_system_admin() and id <> (select auth.uid())) or (public.current_app_role() = 'facility_admin' and role = 'health_worker' and facility_id = public.current_facility_id()))
with check ((public.is_system_admin() and id <> (select auth.uid())) or (public.current_app_role() = 'facility_admin' and role = 'health_worker' and facility_id = public.current_facility_id()));

create policy caregivers_select on public.caregivers for select to authenticated
using (public.is_system_admin() or facility_id = public.current_facility_id());
create policy caregivers_insert on public.caregivers for insert to authenticated
with check (public.is_system_admin() or (facility_id = public.current_facility_id() and public.current_app_role() in ('facility_admin','health_worker')));
create policy caregivers_update on public.caregivers for update to authenticated
using (public.is_system_admin() or (facility_id = public.current_facility_id() and public.current_app_role() in ('facility_admin','health_worker')))
with check (public.is_system_admin() or (facility_id = public.current_facility_id() and public.current_app_role() in ('facility_admin','health_worker')));

create policy children_select on public.children for select to authenticated
using (public.is_system_admin() or exists (
  select 1 from public.caregivers cg where cg.id = caregiver_id and cg.facility_id = public.current_facility_id()
));
create policy children_insert on public.children for insert to authenticated
with check ((public.is_system_admin() or public.current_app_role() in ('facility_admin','health_worker')) and exists (
  select 1 from public.caregivers cg where cg.id = caregiver_id and (public.is_system_admin() or cg.facility_id = public.current_facility_id())
));
create policy children_update on public.children for update to authenticated
using (public.is_system_admin() or exists (
  select 1 from public.caregivers cg where cg.id = caregiver_id and cg.facility_id = public.current_facility_id()
)) with check (public.is_system_admin() or exists (
  select 1 from public.caregivers cg where cg.id = caregiver_id and cg.facility_id = public.current_facility_id()
));

create policy appointment_select on public.appointment for select to authenticated
using (public.is_system_admin() or exists (
  select 1 from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id
  where ch.id = child_id and cg.facility_id = public.current_facility_id()
));
create policy appointment_insert on public.appointment for insert to authenticated
with check ((public.is_system_admin() or public.current_app_role() in ('facility_admin','health_worker')) and exists (
  select 1 from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id
  where ch.id = child_id and (public.is_system_admin() or cg.facility_id = public.current_facility_id())
));
create policy appointment_update on public.appointment for update to authenticated
using (public.is_system_admin() or exists (
  select 1 from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id where ch.id = child_id and cg.facility_id = public.current_facility_id()
)) with check (public.is_system_admin() or exists (
  select 1 from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id where ch.id = child_id and cg.facility_id = public.current_facility_id()
));

create policy calls_select on public.calls for select to authenticated
using (public.is_system_admin() or exists (
  select 1 from public.appointment a join public.children ch on ch.id = a.child_id join public.caregivers cg on cg.id = ch.caregiver_id
  where a.id = appointment_id and cg.facility_id = public.current_facility_id()
));
create policy attempts_select on public.call_attempts for select to authenticated
using (public.is_system_admin() or exists (
  select 1 from public.calls c join public.appointment a on a.id = c.appointment_id join public.children ch on ch.id = a.child_id join public.caregivers cg on cg.id = ch.caregiver_id
  where c.id = call_id and cg.facility_id = public.current_facility_id()
));

create policy callbacks_select on public.callbacks for select to authenticated
using (public.is_system_admin() or facility_id = public.current_facility_id());
create policy callbacks_insert on public.callbacks for insert to authenticated
with check ((public.is_system_admin() or (facility_id = public.current_facility_id() and public.current_app_role() in ('facility_admin','health_worker')))
  and exists (select 1 from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id where ch.id = child_id and (public.is_system_admin() or cg.facility_id = callbacks.facility_id)));
create policy callbacks_update on public.callbacks for update to authenticated
using (public.is_system_admin() or (facility_id = public.current_facility_id() and public.current_app_role() in ('facility_admin','health_worker')))
with check ((public.is_system_admin() or (facility_id = public.current_facility_id() and public.current_app_role() in ('facility_admin','health_worker')))
  and exists (select 1 from public.children ch join public.caregivers cg on cg.id = ch.caregiver_id where ch.id = child_id and (public.is_system_admin() or cg.facility_id = callbacks.facility_id)));

-- No DELETE policies are provided: archive/deactivate operational records instead.
-- Backend/service-role writes bypass RLS; keep the service role secret and authorize in the backend.

commit;
