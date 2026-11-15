-- Allows the final 15-month dose to complete the schedule when the child first
-- enters Lafiya Line at that visit. We do not invent or backfill earlier doses.
-- Apply once to the separate draft Supabase project before deploying the API.

begin;

create or replace function public.validate_completed_vaccination_schedule() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.schedule_complete and new.vaccine_type <> '15 months - Nine-month' then
    raise exception 'only the administered 15-month final dose can complete the schedule';
  end if;
  return new;
end;
$$;

do $$
begin
  if exists (
    select 1 from public.appointment
    group by child_id, vaccine_type
    having count(*) > 1
  ) then
    raise exception 'duplicate child vaccine stages exist; review them before adding the unique index';
  end if;
end;
$$;

create unique index if not exists appointment_child_stage_once_uq
  on public.appointment(child_id, vaccine_type);

commit;
