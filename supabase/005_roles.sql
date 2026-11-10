-- ============================================================
--  005 — Four clear roles, employee self-service linking, per-client modules
--  Run after 004: Supabase → SQL Editor → paste → Run
--
--  super (JHM admin)  → every client
--  owner              → the client's owner/admin: whole workspace, invites, settings
--  staff              → chosen staff: employees, hiring, tasks, all documents
--  employee           → self-service: own record, shared documents, Ask JHM
-- ============================================================

-- roles become plain text with a check (enum values can't be added and used in one script)
alter table public.memberships alter column role drop default;
alter table public.memberships alter column role type text using role::text;
alter table public.invites     alter column role drop default;
alter table public.invites     alter column role type text using role::text;
update public.memberships set role = 'owner'    where role = 'admin';
update public.memberships set role = 'employee' where role = 'member';
update public.invites     set role = 'owner'    where role = 'admin';
update public.invites     set role = 'employee' where role = 'member';
alter table public.memberships alter column role set default 'employee';
alter table public.invites     alter column role set default 'employee';
alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships add constraint memberships_role_check check (role in ('owner', 'staff', 'employee'));
alter table public.invites drop constraint if exists invites_role_check;
alter table public.invites add constraint invites_role_check check (role in ('owner', 'staff', 'employee'));

-- per-client modules (HiBob-style switches, managed by JHM)
alter table public.organizations add column if not exists modules jsonb not null default
  '{"documents": true, "employees": true, "hiring": true, "tasks": true, "requests": true}'::jsonb;

-- employee self-service: link a portal user to their employee record
alter table public.employees add column if not exists user_id uuid references public.profiles(id) on delete set null;
create unique index if not exists employees_user_idx on public.employees(org_id, user_id) where user_id is not null;

-- ---------- role helpers ----------
create or replace function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) in ('super', 'owner', 'admin');
$$;
create or replace function public.is_org_staff(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) in ('super', 'owner', 'admin', 'staff');
$$;
-- the employee record (if any) linked to the current user in this org
create or replace function public.my_employee_id(p_org uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.employees where org_id = p_org and user_id = auth.uid() limit 1;
$$;

-- link on membership creation (match work or personal email), and re-link if the record is added later
create or replace function public.link_employee_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare em text;
begin
  select lower(email) into em from public.profiles where id = new.user_id;
  if em is not null then
    update public.employees set user_id = new.user_id
    where org_id = new.org_id and user_id is null and (lower(work_email) = em or lower(personal_email) = em);
  end if;
  return new;
end $$;
drop trigger if exists memberships_link_employee on public.memberships;
create trigger memberships_link_employee after insert on public.memberships
  for each row execute function public.link_employee_user();

create or replace function public.link_employee_on_save() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.user_id is null then
    select m.user_id into new.user_id from public.memberships m join public.profiles p on p.id = m.user_id
    where m.org_id = new.org_id and (lower(p.email) = lower(new.work_email) or lower(p.email) = lower(new.personal_email)) limit 1;
  end if;
  return new;
end $$;
drop trigger if exists employees_link_user on public.employees;
create trigger employees_link_user before insert or update of work_email, personal_email on public.employees
  for each row execute function public.link_employee_on_save();

-- ---------- storage path rule: staff see HR files; employees see shared docs + branding ----------
create or replace function public.can_read_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid; area text;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  area := split_part(p_path, '/', 2);
  if public.is_org_staff(org) then return true; end if;
  if not public.is_org_member(org) then return false; end if;
  if area = 'branding' then return true; end if;
  if area = 'documents' then
    return exists (select 1 from public.documents d where d.file_path = p_path and d.org_id = org and d.staff_visible);
  end if;
  return false;
end $$;
create or replace function public.can_write_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  return public.is_org_staff(org);
end $$;

-- ---------- policies: staff-level for HR data, owner-level for users/settings ----------
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select
  using (public.is_org_staff(org_id) or (staff_visible and public.is_org_member(org_id)));
drop policy if exists documents_admin_write on public.documents;
create policy documents_admin_write on public.documents for all
  using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));

drop policy if exists job_orders_admin on public.job_orders;
create policy job_orders_admin on public.job_orders for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists candidates_admin on public.candidates;
create policy candidates_admin on public.candidates for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists notes_admin on public.candidate_notes;
create policy notes_admin on public.candidate_notes for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists job_files_admin on public.job_order_files;
create policy job_files_admin on public.job_order_files for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));

drop policy if exists employees_admin on public.employees;
create policy employees_admin on public.employees for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists employees_self on public.employees;
create policy employees_self on public.employees for select using (user_id = auth.uid());

drop policy if exists emerg_admin on public.emergency_contacts;
create policy emerg_admin on public.emergency_contacts for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists emerg_self on public.emergency_contacts;
create policy emerg_self on public.emergency_contacts for all
  using (employee_id = public.my_employee_id(org_id)) with check (employee_id = public.my_employee_id(org_id));

drop policy if exists deps_admin on public.dependents;
create policy deps_admin on public.dependents for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists deps_self on public.dependents;
create policy deps_self on public.dependents for all
  using (employee_id = public.my_employee_id(org_id)) with check (employee_id = public.my_employee_id(org_id));

drop policy if exists emp_tasks_admin on public.employee_tasks;
create policy emp_tasks_admin on public.employee_tasks for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists emp_tasks_self on public.employee_tasks;
create policy emp_tasks_self on public.employee_tasks for select using (employee_id = public.my_employee_id(org_id));

drop policy if exists emp_files_admin on public.employee_files;
create policy emp_files_admin on public.employee_files for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));

drop policy if exists activity_select on public.activity_log;
create policy activity_select on public.activity_log for select using (public.is_org_staff(org_id));

-- requests: staff can read the company's requests too
drop policy if exists requests_select on public.requests;
create policy requests_select on public.requests for select
  using (user_id = auth.uid() or public.is_org_staff(org_id));

-- memberships / invites / org settings stay owner-level (is_org_admin) — unchanged.
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- ---------- company directory / org chart (safe columns only; visible to every member of the org) ----------
create or replace view public.directory with (security_invoker = false) as
  select e.id, e.org_id, e.first_name, e.last_name, e.preferred_name, e.job_title, e.department,
         e.work_location, e.work_email, e.manager_id, e.status, e.start_date, e.user_id
  from public.employees e
  where e.status <> 'terminated' and public.is_org_member(e.org_id);
grant select on public.directory to authenticated;

notify pgrst, 'reload schema';
