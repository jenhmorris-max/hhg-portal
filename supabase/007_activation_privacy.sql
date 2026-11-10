-- ============================================================
--  007 — Auto-activate after onboarding; employees see only themselves + direct reports
--  Run after 006: Supabase → SQL Editor → paste → Run
-- ============================================================

-- when the last open onboarding task closes, an 'onboarding' employee becomes 'active'
create or replace function public.activate_when_onboarded() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('complete', 'na') and (old.status is distinct from new.status) then
    if not exists (select 1 from public.employee_tasks t where t.employee_id = new.employee_id and t.status in ('pending', 'in_progress')) then
      update public.employees set status = 'active' where id = new.employee_id and status = 'onboarding';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists employee_tasks_activate on public.employee_tasks;
create trigger employee_tasks_activate after update of status on public.employee_tasks
  for each row execute function public.activate_when_onboarded();

-- directory: staff see everyone; an employee sees only their own card and their direct reports
create or replace view public.directory with (security_invoker = false) as
  select e.id, e.org_id, e.first_name, e.last_name, e.preferred_name, e.job_title, e.department,
         e.work_location, e.work_email, e.manager_id, e.status, e.start_date, e.user_id
  from public.employees e
  where e.status <> 'terminated'
    and public.is_org_member(e.org_id)
    and (public.is_org_staff(e.org_id)
         or e.user_id = auth.uid()
         or e.manager_id = public.my_employee_id(e.org_id));
grant select on public.directory to authenticated;

-- the same rule for the underlying table (self-service reads): own row + direct reports
drop policy if exists employees_self on public.employees;
create policy employees_self on public.employees for select
  using (user_id = auth.uid() or manager_id = public.my_employee_id(org_id));

notify pgrst, 'reload schema';
