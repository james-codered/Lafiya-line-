-- Keep one vaccination event and its independent 24h/72h call rows atomic.
-- The API service calls this function only after checking the signed-in staff
-- profile and facility. The service role is the only role allowed to execute it.

begin;

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
  p_create_calls boolean
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_appointment_id uuid;
  v_call_ids uuid[] := array[]::uuid[];
  v_call_id uuid;
  v_hours integer;
begin
  insert into public.appointment (
    child_id, vaccine_type, vaccinated_at, next_dose_stage,
    next_dose_due_at, schedule_complete, schedule_completed_at, recorded_by
  ) values (
    p_child_id, p_vaccine_type, p_vaccinated_at, p_next_dose_stage,
    p_next_dose_due_at, p_schedule_complete, p_schedule_completed_at, p_recorded_by
  ) returning id into v_appointment_id;

  if p_create_calls then
    foreach v_hours in array array[24, 72] loop
      insert into public.calls (appointment_id, follow_up_hours, scheduled_at, language_code)
      values (
        v_appointment_id,
        v_hours,
        public.aftercare_scheduled_time(p_vaccinated_at, v_hours),
        p_language_code
      ) returning id into v_call_id;
      v_call_ids := array_append(v_call_ids, v_call_id);
    end loop;
  end if;

  if p_schedule_complete then
    update public.children set is_active = false where id = p_child_id;
  end if;

  return jsonb_build_object('appointment_id', v_appointment_id, 'call_ids', v_call_ids);
end;
$$;

revoke all on function public.create_aftercare_vaccination(uuid,text,timestamptz,text,timestamptz,boolean,timestamptz,uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.create_aftercare_vaccination(uuid,text,timestamptz,text,timestamptz,boolean,timestamptz,uuid,text,boolean) to service_role;

commit;
