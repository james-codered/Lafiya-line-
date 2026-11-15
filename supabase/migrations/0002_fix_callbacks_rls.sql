-- Correct the callback INSERT and UPDATE policies in an already initialized
-- disposable draft project. Do not rerun 0001_init.sql on that project.
-- Apply and test this patch only in the separate draft Supabase project.

begin;

drop policy if exists callbacks_insert on public.callbacks;
create policy callbacks_insert on public.callbacks for insert to authenticated
with check (
  (
    public.is_system_admin()
    or (
      facility_id = public.current_facility_id()
      and public.current_app_role() in ('facility_admin', 'health_worker')
    )
  )
  and exists (
    select 1
    from public.children ch
    join public.caregivers cg on cg.id = ch.caregiver_id
    where ch.id = child_id
      and (
        public.is_system_admin()
        or cg.facility_id = callbacks.facility_id
      )
  )
);

drop policy if exists callbacks_update on public.callbacks;
create policy callbacks_update on public.callbacks for update to authenticated
using (
  public.is_system_admin()
  or (
    facility_id = public.current_facility_id()
    and public.current_app_role() in ('facility_admin', 'health_worker')
  )
)
with check (
  (
    public.is_system_admin()
    or (
      facility_id = public.current_facility_id()
      and public.current_app_role() in ('facility_admin', 'health_worker')
    )
  )
  and exists (
    select 1
    from public.children ch
    join public.caregivers cg on cg.id = ch.caregiver_id
    where ch.id = child_id
      and (
        public.is_system_admin()
        or cg.facility_id = callbacks.facility_id
      )
  )
);

commit;
