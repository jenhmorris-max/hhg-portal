-- ============================================================
--  ALL MIGRATIONS 002 → 008 in order. Safe to re-run.
--  Run AFTER schema.sql: Supabase → SQL Editor → paste → Run
-- ============================================================


-- ===================== 002_employees.sql =====================
-- ============================================================
--  002 — Employees (HRIS) + onboarding checklist
--  Run after schema.sql: Supabase → SQL Editor → paste → Run
--  Admin-only (JHM admin + client admin). Client staff never see this data.
-- ============================================================

do $$ begin
  create type public.employee_status as enum ('onboarding', 'active', 'leave', 'terminated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.task_status as enum ('pending', 'in_progress', 'complete', 'na');
exception when duplicate_object then null; end $$;

create table if not exists public.employees (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  -- personal
  first_name       text not null,
  middle_name      text,
  last_name        text not null,
  preferred_name   text,
  date_of_birth    date,
  gender           text,
  marital_status   text,
  -- contact
  personal_email   text,
  work_email       text,
  mobile_phone     text,
  home_phone       text,
  address1         text,
  address2         text,
  city             text,
  state            text,
  zip              text,
  -- employment
  status           public.employee_status not null default 'onboarding',
  hire_date        date,
  start_date       date,
  termination_date date,
  termination_reason text,
  employee_type    text,          -- Full-time, Part-time, Temporary, Seasonal, Intern, Contractor
  flsa_class       text,          -- Exempt / Non-exempt
  job_title        text,
  department       text,
  work_location    text,
  manager_id       uuid references public.employees(id) on delete set null,
  pay_type         text,          -- Hourly / Salary
  pay_rate         numeric(12,2),
  pay_frequency    text,          -- Weekly, Bi-weekly, Semi-monthly, Monthly
  scheduled_hours  numeric(5,2),
  notes            text,
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.emergency_contacts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  full_name     text not null,
  relationship  text,
  phone         text,
  alt_phone     text,
  email         text,
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now()
);

create table if not exists public.dependents (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  full_name     text not null,
  relationship  text,              -- Spouse, Child, Domestic partner...
  date_of_birth date,
  created_at    timestamptz not null default now()
);

-- onboarding / HR tasks per employee; file_path points at org-files/<org>/employees/<employee>/...
create table if not exists public.employee_tasks (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  employee_id    uuid not null references public.employees(id) on delete cascade,
  task_key       text not null,     -- job_description, guidebook, personal_info, emergency_contact, eeoc, w4, i9, state_new_hire, custom
  label          text not null,
  description    text,
  sort_order     int not null default 100,
  status         public.task_status not null default 'pending',
  due_date       date,
  completed_at   timestamptz,
  completed_by   uuid references public.profiles(id) on delete set null,
  file_path      text,
  file_name      text,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- any other employee document (performance reviews, write-ups, certifications...)
create table if not exists public.employee_files (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  title         text not null,
  category      text,              -- Review, Disciplinary, Certification, Benefits, Other
  file_path     text not null,
  file_name     text not null,
  uploaded_by   uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);

create index if not exists employees_org_idx on public.employees(org_id, status);
create index if not exists emerg_emp_idx on public.emergency_contacts(employee_id);
create index if not exists deps_emp_idx on public.dependents(employee_id);
create index if not exists emp_tasks_emp_idx on public.employee_tasks(employee_id, sort_order);
create index if not exists emp_files_emp_idx on public.employee_files(employee_id);

drop trigger if exists employees_updated_at on public.employees;
create trigger employees_updated_at before update on public.employees
  for each row execute function public.set_updated_at();
drop trigger if exists employee_tasks_updated_at on public.employee_tasks;
create trigger employee_tasks_updated_at before update on public.employee_tasks
  for each row execute function public.set_updated_at();

-- ---------- default onboarding checklist, created with each new employee ----------
create or replace function public.add_business_days(d date, n int) returns date
language plpgsql immutable as $$
declare r date := d; i int := 0;
begin
  if d is null then return null; end if;
  while i < n loop
    r := r + 1;
    if extract(isodow from r) < 6 then i := i + 1; end if;
  end loop;
  return r;
end $$;

create or replace function public.seed_onboarding_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
declare sd date := coalesce(new.start_date, new.hire_date, current_date);
begin
  insert into public.employee_tasks (org_id, employee_id, task_key, label, description, sort_order, due_date) values
    (new.org_id, new.id, 'job_description', 'Job Description acknowledgment', 'Signed job description on file.', 10, sd),
    (new.org_id, new.id, 'guidebook',       'Employee Guidebook acknowledgment', 'Signed handbook/guidebook receipt.', 20, sd),
    (new.org_id, new.id, 'personal_info',   'Personal information', 'Address, phone and personal email entered on the profile.', 30, sd),
    (new.org_id, new.id, 'emergency_contact','Emergency contact', 'At least one emergency contact entered.', 40, sd),
    (new.org_id, new.id, 'eeoc',            'EEOC voluntary self-identification', 'Completed form uploaded (voluntary — may be declined).', 50, sd),
    (new.org_id, new.id, 'w4',              'Form W-4', 'Completed W-4 uploaded; copy to payroll.', 60, sd),
    (new.org_id, new.id, 'i9',              'Form I-9', 'Section 1 by day 1; Section 2 within 3 business days of start.', 70, public.add_business_days(sd, 3)),
    (new.org_id, new.id, 'state_new_hire',  'State new-hire report', 'Report to the state new-hire registry within 20 days of hire (Florida).', 80, coalesce(new.hire_date, sd) + 20);
  return new;
end $$;

drop trigger if exists employees_seed_tasks on public.employees;
create trigger employees_seed_tasks after insert on public.employees
  for each row execute function public.seed_onboarding_tasks();

-- ---------- RLS: admins only ----------
alter table public.employees          enable row level security;
alter table public.emergency_contacts enable row level security;
alter table public.dependents         enable row level security;
alter table public.employee_tasks     enable row level security;
alter table public.employee_files     enable row level security;

drop policy if exists employees_admin on public.employees;
create policy employees_admin on public.employees for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists emerg_admin on public.emergency_contacts;
create policy emerg_admin on public.emergency_contacts for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists deps_admin on public.dependents;
create policy deps_admin on public.dependents for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists emp_tasks_admin on public.employee_tasks;
create policy emp_tasks_admin on public.employee_tasks for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists emp_files_admin on public.employee_files;
create policy emp_files_admin on public.employee_files for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
-- storage: files under <org>/employees/... are already admin-only via can_read_path/can_write_path.


-- ===================== 003_requests.sql =====================
-- ============================================================
--  003 — Support requests ("Ask JHM" contact form) + new default accent
--  Run after 002: Supabase → SQL Editor → paste → Run
-- ============================================================

do $$ begin
  create type public.request_status as enum ('new', 'in_progress', 'resolved');
exception when duplicate_object then null; end $$;

create table if not exists public.requests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  category     text not null default 'General question',
  subject      text not null,
  body         text not null,
  urgency      text not null default 'Normal',     -- Low / Normal / Urgent
  status       public.request_status not null default 'new',
  response     text,                                -- JHM's reply, visible to the requester
  responded_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists requests_org_idx on public.requests(org_id, status, created_at desc);

drop trigger if exists requests_updated_at on public.requests;
create trigger requests_updated_at before update on public.requests
  for each row execute function public.set_updated_at();

alter table public.requests enable row level security;

-- anyone in the org can file one, as themselves
drop policy if exists requests_insert on public.requests;
create policy requests_insert on public.requests for insert
  with check (public.is_org_member(org_id) and user_id = auth.uid());
-- requester sees their own; org admins see their company's; JHM sees all (via is_org_admin -> super)
drop policy if exists requests_select on public.requests;
create policy requests_select on public.requests for select
  using (user_id = auth.uid() or public.is_org_admin(org_id));
-- only JHM (super admin) updates status / replies
drop policy if exists requests_super_update on public.requests;
create policy requests_super_update on public.requests for update
  using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists requests_delete on public.requests;
create policy requests_delete on public.requests for delete
  using (public.is_super_admin());

grant select, insert, update, delete on all tables in schema public to authenticated;

-- new default accent (navy) for the portal; move existing clients off the old green
alter table public.organizations alter column accent set default '#23305a';
update public.organizations set accent = '#23305a' where accent = '#1f4d3a';


-- ===================== 004_job_files.sql =====================
-- ============================================================
--  004 — Attachments on job orders (full descriptions, interview guides, scorecards)
--  Run after 003: Supabase → SQL Editor → paste → Run
-- ============================================================

create table if not exists public.job_order_files (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  job_order_id   uuid not null references public.job_orders(id) on delete cascade,
  title          text not null,
  file_path      text not null,
  file_name      text not null,
  size_bytes     bigint,
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index if not exists job_files_job_idx on public.job_order_files(job_order_id);

alter table public.job_order_files enable row level security;
drop policy if exists job_files_admin on public.job_order_files;
create policy job_files_admin on public.job_order_files for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

grant select, insert, update, delete on all tables in schema public to authenticated;


-- ===================== 005_roles.sql =====================
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



-- ===================== 006_signatures.sql =====================
-- ============================================================
--  006 — Onboarding templates (document per task) + e-signatures
--  Run after 005: Supabase → SQL Editor → paste → Run
-- ============================================================

-- per-client onboarding template: which document backs each task, and whether it needs a signature
create table if not exists public.task_templates (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  task_key            text not null,
  label               text not null,
  description         text,
  sort_order          int not null default 100,
  document_id         uuid references public.documents(id) on delete set null,
  requires_signature  boolean not null default false,
  due_rule            text not null default 'start',   -- start | start+3bd | hire+20 | none
  enabled             boolean not null default true,
  created_at          timestamptz not null default now(),
  unique (org_id, task_key)
);
alter table public.task_templates enable row level security;
drop policy if exists task_templates_staff on public.task_templates;
create policy task_templates_staff on public.task_templates for all
  using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists task_templates_read on public.task_templates;
create policy task_templates_read on public.task_templates for select using (public.is_org_member(org_id));

-- signature fields on tasks
alter table public.employee_tasks
  add column if not exists template_doc_id    uuid references public.documents(id) on delete set null,
  add column if not exists requires_signature boolean not null default false,
  add column if not exists signed_at          timestamptz,
  add column if not exists signed_name        text,
  add column if not exists signed_by          uuid references public.profiles(id) on delete set null,
  add column if not exists signature_path     text,      -- PNG of the drawn signature
  add column if not exists signed_file_path   text,      -- stamped PDF (original + certificate page)
  add column if not exists signed_file_name   text;

-- default templates for an org, created on first use
create or replace function public.ensure_task_templates(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.task_templates (org_id, task_key, label, description, sort_order, requires_signature, due_rule) values
    (p_org, 'job_description',  'Job Description acknowledgment',     'Review and sign the job description.', 10, true,  'start'),
    (p_org, 'guidebook',        'Employee Guidebook acknowledgment',  'Review and sign the handbook/guidebook receipt.', 20, true, 'start'),
    (p_org, 'personal_info',    'Personal information',               'Address, phone and personal email on the profile.', 30, false, 'start'),
    (p_org, 'emergency_contact','Emergency contact',                  'At least one emergency contact entered.', 40, false, 'start'),
    (p_org, 'eeoc',             'EEOC voluntary self-identification', 'Voluntary — may be declined.', 50, true, 'start'),
    (p_org, 'w4',               'Form W-4',                           'Completed W-4; copy to payroll.', 60, true, 'start'),
    (p_org, 'i9',               'Form I-9',                           'Section 1 by day 1; Section 2 within 3 business days.', 70, true, 'start+3bd'),
    (p_org, 'state_new_hire',   'State new-hire report',              'Report within 20 days of hire (Florida).', 80, false, 'hire+20')
  on conflict (org_id, task_key) do nothing;
end $$;

-- new employees get their checklist from the org's templates
create or replace function public.seed_onboarding_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
declare sd date := coalesce(new.start_date, new.hire_date, current_date); hd date := coalesce(new.hire_date, sd);
begin
  perform public.ensure_task_templates(new.org_id);
  insert into public.employee_tasks (org_id, employee_id, task_key, label, description, sort_order, due_date, template_doc_id, requires_signature)
  select t.org_id, new.id, t.task_key, t.label, t.description, t.sort_order,
         case t.due_rule when 'start' then sd when 'start+3bd' then public.add_business_days(sd, 3) when 'hire+20' then hd + 20 else null end,
         t.document_id, t.requires_signature
  from public.task_templates t where t.org_id = new.org_id and t.enabled
  order by t.sort_order;
  return new;
end $$;

-- employees may update only signature-related fields on their own tasks
create or replace function public.guard_task_self_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_org_staff(old.org_id) or auth.uid() is null then return new; end if;
  -- non-staff: keep everything except the signing fields + status/completion
  new.org_id = old.org_id; new.employee_id = old.employee_id; new.task_key = old.task_key; new.label = old.label;
  new.description = old.description; new.sort_order = old.sort_order; new.due_date = old.due_date; new.notes = old.notes;
  new.file_path = old.file_path; new.file_name = old.file_name; new.template_doc_id = old.template_doc_id; new.requires_signature = old.requires_signature;
  if new.status not in ('complete', 'in_progress') then new.status = old.status; end if;
  return new;
end $$;
drop trigger if exists employee_tasks_self_guard on public.employee_tasks;
create trigger employee_tasks_self_guard before update on public.employee_tasks
  for each row execute function public.guard_task_self_update();

drop policy if exists emp_tasks_self_update on public.employee_tasks;
create policy emp_tasks_self_update on public.employee_tasks for update
  using (employee_id = public.my_employee_id(org_id)) with check (employee_id = public.my_employee_id(org_id));

-- employees can read documents attached to their own tasks (even HR-only ones), and the files behind them
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select
  using (public.is_org_staff(org_id) or (staff_visible and public.is_org_member(org_id))
         or exists (select 1 from public.employee_tasks t where t.template_doc_id = documents.id and t.employee_id = public.my_employee_id(documents.org_id)));

create or replace function public.can_read_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid; area text; me uuid;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  area := split_part(p_path, '/', 2);
  if public.is_org_staff(org) then return true; end if;
  if not public.is_org_member(org) then return false; end if;
  if area = 'branding' then return true; end if;
  me := public.my_employee_id(org);
  if area = 'documents' then
    return exists (select 1 from public.documents d where d.file_path = p_path and d.org_id = org
                   and (d.staff_visible or exists (select 1 from public.employee_tasks t where t.template_doc_id = d.id and t.employee_id = me)));
  end if;
  if area = 'employees' and me is not null and split_part(p_path, '/', 3) = me::text then
    return exists (select 1 from public.employee_tasks t where t.employee_id = me and (t.signed_file_path = p_path or t.signature_path = p_path));
  end if;
  return false;
end $$;

create or replace function public.can_write_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid; me uuid;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  if public.is_org_staff(org) then return true; end if;
  me := public.my_employee_id(org);
  -- employees may write only into their own signatures folder
  return me is not null and split_part(p_path, '/', 2) = 'employees' and split_part(p_path, '/', 3) = me::text and split_part(p_path, '/', 4) = 'signatures';
end $$;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;



-- ===================== 007_activation_privacy.sql =====================
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



-- ===================== 008_workflows.sql =====================
-- ============================================================
--  008 — Forms & workflows (generalises the onboarding checklist)
--  Run after 007: Supabase → SQL Editor → paste → Run
-- ============================================================

create table if not exists public.workflows (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organizations(id) on delete cascade,
  name         text not null,
  description  text,
  trigger      text not null default 'manual' check (trigger in ('manual', 'on_hire', 'on_termination')),
  enabled      boolean not null default true,
  sort_order   int not null default 100,
  created_at   timestamptz not null default now()
);

create table if not exists public.workflow_steps (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references public.organizations(id) on delete cascade,
  workflow_id         uuid not null references public.workflows(id) on delete cascade,
  label               text not null,
  description         text,
  step_type           text not null default 'checklist' check (step_type in ('review', 'sign', 'form', 'upload', 'checklist')),
  document_id         uuid references public.documents(id) on delete set null,
  requires_signature  boolean not null default false,
  assignee            text not null default 'hr' check (assignee in ('hr', 'manager', 'employee')),
  due_offset_days     int not null default 0,          -- relative to the run's anchor date
  due_business_days   boolean not null default false,
  due_anchor          text not null default 'start' check (due_anchor in ('start', 'hire', 'run', 'termination')),
  form_schema         jsonb,                           -- [{key,label,type,required,options:[...]}]
  sort_order          int not null default 100,
  created_at          timestamptz not null default now()
);

create table if not exists public.workflow_runs (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  workflow_id   uuid references public.workflows(id) on delete set null,
  workflow_name text not null,
  employee_id   uuid not null references public.employees(id) on delete cascade,
  anchor_date   date not null default current_date,
  started_by    uuid references public.profiles(id) on delete set null,
  started_at    timestamptz not null default now(),
  completed_at  timestamptz
);

alter table public.employee_tasks
  add column if not exists run_id       uuid references public.workflow_runs(id) on delete cascade,
  add column if not exists step_type    text not null default 'checklist',
  add column if not exists assignee     text not null default 'hr',
  add column if not exists form_schema  jsonb,
  add column if not exists form_data    jsonb;

create index if not exists wf_steps_wf_idx on public.workflow_steps(workflow_id, sort_order);
create index if not exists wf_runs_emp_idx on public.workflow_runs(employee_id);
create index if not exists emp_tasks_run_idx on public.employee_tasks(run_id);

alter table public.workflows      enable row level security;
alter table public.workflow_steps enable row level security;
alter table public.workflow_runs  enable row level security;
drop policy if exists workflows_staff on public.workflows;
create policy workflows_staff on public.workflows for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists workflows_read on public.workflows;
create policy workflows_read on public.workflows for select using (public.is_org_member(org_id));
drop policy if exists wf_steps_staff on public.workflow_steps;
create policy wf_steps_staff on public.workflow_steps for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists wf_steps_read on public.workflow_steps;
create policy wf_steps_read on public.workflow_steps for select using (public.is_org_member(org_id));
drop policy if exists wf_runs_staff on public.workflow_runs;
create policy wf_runs_staff on public.workflow_runs for all using (public.is_org_staff(org_id)) with check (public.is_org_staff(org_id));
drop policy if exists wf_runs_self on public.workflow_runs;
create policy wf_runs_self on public.workflow_runs for select using (employee_id = public.my_employee_id(org_id));

-- ---------- start a workflow for an employee ----------
create or replace function public.start_workflow(p_workflow uuid, p_employee uuid, p_anchor date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare w public.workflows; e public.employees; run_id uuid; anchor date; st public.workflow_steps; base date; due date;
begin
  select * into w from public.workflows where id = p_workflow;
  select * into e from public.employees where id = p_employee;
  if w.id is null or e.id is null or w.org_id <> e.org_id then raise exception 'workflow/employee mismatch'; end if;
  if not public.is_org_staff(w.org_id) and auth.uid() is not null then raise exception 'not allowed'; end if;
  anchor := coalesce(p_anchor, e.start_date, e.hire_date, current_date);
  insert into public.workflow_runs (org_id, workflow_id, workflow_name, employee_id, anchor_date, started_by)
  values (w.org_id, w.id, w.name, e.id, anchor, auth.uid()) returning id into run_id;
  for st in select * from public.workflow_steps where workflow_id = w.id order by sort_order loop
    base := case st.due_anchor when 'hire' then coalesce(e.hire_date, anchor) when 'termination' then coalesce(e.termination_date, anchor) when 'run' then current_date else anchor end;
    due := case when st.due_business_days then public.add_business_days(base, st.due_offset_days) else base + st.due_offset_days end;
    insert into public.employee_tasks (org_id, employee_id, run_id, task_key, label, description, sort_order, due_date, template_doc_id, requires_signature, step_type, assignee, form_schema)
    values (w.org_id, e.id, run_id, 'wf_' || st.id, st.label, st.description, st.sort_order, due, st.document_id,
            st.requires_signature or st.step_type = 'sign', st.step_type, st.assignee, st.form_schema);
  end loop;
  return run_id;
end $$;

-- ---------- default workflows (created on first use; migrates the old checklist templates) ----------
create or replace function public.ensure_workflows(p_org uuid) returns void
language plpgsql security definer set search_path = public as $$
declare wid uuid; t public.task_templates; n int := 0;
begin
  if exists (select 1 from public.workflows where org_id = p_org) then return; end if;
  perform public.ensure_task_templates(p_org);
  insert into public.workflows (org_id, name, description, trigger, sort_order)
  values (p_org, 'Onboarding', 'Starts automatically when an employee is added.', 'on_hire', 10) returning id into wid;
  for t in select * from public.task_templates where org_id = p_org and enabled order by sort_order loop
    n := n + 1;
    insert into public.workflow_steps (org_id, workflow_id, label, description, step_type, document_id, requires_signature, assignee, due_offset_days, due_business_days, due_anchor, sort_order, form_schema)
    values (p_org, wid, t.label, t.description,
      case when t.task_key = 'personal_info' then 'form' when t.task_key = 'emergency_contact' then 'form' when t.requires_signature then 'sign' when t.task_key = 'state_new_hire' then 'checklist' else 'review' end,
      t.document_id, t.requires_signature,
      case when t.task_key in ('state_new_hire') then 'hr' else 'employee' end,
      case t.due_rule when 'start+3bd' then 3 when 'hire+20' then 20 else 0 end,
      t.due_rule = 'start+3bd',
      case t.due_rule when 'hire+20' then 'hire' else 'start' end,
      n * 10,
      case t.task_key
        when 'personal_info' then '[{"key":"address1","label":"Street address","type":"text","required":true},{"key":"address2","label":"Apt / Suite","type":"text"},{"key":"city","label":"City","type":"text","required":true},{"key":"state","label":"State","type":"text","required":true},{"key":"zip","label":"ZIP","type":"text","required":true},{"key":"mobile_phone","label":"Mobile phone","type":"text","required":true},{"key":"personal_email","label":"Personal email","type":"text","required":true}]'::jsonb
        when 'emergency_contact' then '[{"key":"ec_name","label":"Contact full name","type":"text","required":true},{"key":"ec_relationship","label":"Relationship","type":"select","options":["Spouse","Partner","Parent","Child","Sibling","Friend","Other"],"required":true},{"key":"ec_phone","label":"Phone","type":"text","required":true},{"key":"ec_alt_phone","label":"Alternate phone","type":"text"},{"key":"ec_email","label":"Email","type":"text"}]'::jsonb
        else null end);
  end loop;
  insert into public.workflows (org_id, name, description, trigger, sort_order)
  values (p_org, 'Offboarding', 'Starts automatically when an employee is marked Terminated.', 'on_termination', 20) returning id into wid;
  insert into public.workflow_steps (org_id, workflow_id, label, description, step_type, assignee, due_offset_days, due_anchor, sort_order, form_schema) values
    (p_org, wid, 'Return of company property', 'Keys, badge, laptop, phone, uniforms.', 'form', 'manager', 0, 'termination', 10,
      '[{"key":"items","label":"Items returned","type":"textarea","required":true},{"key":"all_returned","label":"Everything returned?","type":"yesno","required":true},{"key":"notes","label":"Notes","type":"textarea"}]'::jsonb),
    (p_org, wid, 'Final paycheck issued', 'Florida has no final-pay statute — pay by the next regular payday.', 'checklist', 'hr', 0, 'termination', 20, null),
    (p_org, wid, 'Benefits termination & COBRA / state continuation notice', 'Federal COBRA at 20+ employees; Florida mini-COBRA under 20.', 'checklist', 'hr', 14, 'termination', 30, null),
    (p_org, wid, 'Revoke system access', 'Email, payroll, software, building access.', 'checklist', 'hr', 0, 'termination', 40, null),
    (p_org, wid, 'Exit interview', NULL, 'form', 'hr', 5, 'termination', 50,
      '[{"key":"reason","label":"Primary reason for leaving","type":"select","options":["New opportunity","Compensation","Management","Relocation","Personal","Performance","Layoff","Other"]},{"key":"would_return","label":"Would rehire / would return?","type":"yesno"},{"key":"feedback","label":"Feedback","type":"textarea"}]'::jsonb);
end $$;

-- new employees: run every enabled on_hire workflow (replaces the old template seeding)
create or replace function public.seed_onboarding_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  perform public.ensure_workflows(new.org_id);
  for w in select id from public.workflows where org_id = new.org_id and trigger = 'on_hire' and enabled order by sort_order loop
    perform public.start_workflow(w.id, new.id, coalesce(new.start_date, new.hire_date, current_date));
  end loop;
  return new;
end $$;

-- termination: run on_termination workflows once
create or replace function public.on_employee_terminated() returns trigger
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  if new.status = 'terminated' and old.status is distinct from 'terminated' then
    perform public.ensure_workflows(new.org_id);
    for w in select id, name from public.workflows where org_id = new.org_id and trigger = 'on_termination' and enabled order by sort_order loop
      if not exists (select 1 from public.workflow_runs r where r.employee_id = new.id and r.workflow_id = w.id and r.completed_at is null) then
        perform public.start_workflow(w.id, new.id, coalesce(new.termination_date, current_date));
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists employees_terminated on public.employees;
create trigger employees_terminated after update of status on public.employees
  for each row execute function public.on_employee_terminated();

-- close a run when all of its tasks are done; keep auto-activation
create or replace function public.activate_when_onboarded() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('complete', 'na') and (old.status is distinct from new.status) then
    if new.run_id is not null and not exists (select 1 from public.employee_tasks t where t.run_id = new.run_id and t.status in ('pending', 'in_progress')) then
      update public.workflow_runs set completed_at = now() where id = new.run_id and completed_at is null;
    end if;
    if not exists (select 1 from public.employee_tasks t join public.workflow_runs r on r.id = t.run_id
                   join public.workflows w on w.id = r.workflow_id
                   where t.employee_id = new.employee_id and w.trigger = 'on_hire' and t.status in ('pending', 'in_progress')) then
      update public.employees set status = 'active' where id = new.employee_id and status = 'onboarding';
    end if;
  end if;
  return new;
end $$;

-- employees may also fill form data on their own tasks, and apply profile/emergency-contact forms to their record
create or replace function public.guard_task_self_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.is_org_staff(old.org_id) or auth.uid() is null then return new; end if;
  new.org_id = old.org_id; new.employee_id = old.employee_id; new.task_key = old.task_key; new.label = old.label;
  new.description = old.description; new.sort_order = old.sort_order; new.due_date = old.due_date; new.notes = old.notes;
  new.template_doc_id = old.template_doc_id; new.requires_signature = old.requires_signature; new.step_type = old.step_type;
  new.assignee = old.assignee; new.form_schema = old.form_schema; new.run_id = old.run_id;
  if new.status not in ('complete', 'in_progress') then new.status = old.status; end if;
  return new;
end $$;

-- employees may upload into their own uploads folder too
create or replace function public.can_write_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid; me uuid;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  if public.is_org_staff(org) then return true; end if;
  me := public.my_employee_id(org);
  return me is not null and split_part(p_path, '/', 2) = 'employees' and split_part(p_path, '/', 3) = me::text and split_part(p_path, '/', 4) in ('signatures', 'uploads');
end $$;
create or replace function public.can_read_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid; area text; me uuid;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  area := split_part(p_path, '/', 2);
  if public.is_org_staff(org) then return true; end if;
  if not public.is_org_member(org) then return false; end if;
  if area = 'branding' then return true; end if;
  me := public.my_employee_id(org);
  if area = 'documents' then
    return exists (select 1 from public.documents d where d.file_path = p_path and d.org_id = org
                   and (d.staff_visible or exists (select 1 from public.employee_tasks t where t.template_doc_id = d.id and t.employee_id = me)));
  end if;
  if area = 'employees' and me is not null and split_part(p_path, '/', 3) = me::text then
    return exists (select 1 from public.employee_tasks t where t.employee_id = me and (t.signed_file_path = p_path or t.signature_path = p_path or t.file_path = p_path));
  end if;
  return false;
end $$;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- apply a completed form to the employee record (profile fields and emergency contact), for staff or the employee themself
create or replace function public.apply_task_form(p_task uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t public.employee_tasks; d jsonb; me uuid;
begin
  select * into t from public.employee_tasks where id = p_task;
  if t.id is null then return; end if;
  me := public.my_employee_id(t.org_id);
  if not (public.is_org_staff(t.org_id) or t.employee_id = me) then raise exception 'not allowed'; end if;
  d := coalesce(t.form_data, '{}'::jsonb);
  update public.employees set
    address1 = coalesce(nullif(d->>'address1', ''), address1), address2 = coalesce(nullif(d->>'address2', ''), address2),
    city = coalesce(nullif(d->>'city', ''), city), state = coalesce(nullif(d->>'state', ''), state), zip = coalesce(nullif(d->>'zip', ''), zip),
    mobile_phone = coalesce(nullif(d->>'mobile_phone', ''), mobile_phone), home_phone = coalesce(nullif(d->>'home_phone', ''), home_phone),
    personal_email = coalesce(nullif(d->>'personal_email', ''), personal_email), date_of_birth = coalesce(nullif(d->>'date_of_birth', '')::date, date_of_birth)
  where id = t.employee_id;
  if nullif(d->>'ec_name', '') is not null then
    insert into public.emergency_contacts (org_id, employee_id, full_name, relationship, phone, alt_phone, email, is_primary)
    values (t.org_id, t.employee_id, d->>'ec_name', nullif(d->>'ec_relationship', ''), nullif(d->>'ec_phone', ''), nullif(d->>'ec_alt_phone', ''), nullif(d->>'ec_email', ''),
            not exists (select 1 from public.emergency_contacts where employee_id = t.employee_id));
  end if;
end $$;
grant execute on all functions in schema public to authenticated;



-- ===================== 009_actor_names.sql =====================
-- ============================================================
--  009 — JHM admin names visible to all clients (audit trail / replies)
-- ============================================================
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (
    id = auth.uid()
    or public.is_super_admin()
    or profiles.is_super_admin            -- JHM admins are visible to everyone (they appear in activity and replies)
    or exists (select 1 from public.memberships m1
               join public.memberships m2 on m1.org_id = m2.org_id
               where m1.user_id = auth.uid() and m2.user_id = profiles.id)
  );


-- ===================== 010_text_documents.sql =====================
-- ============================================================
--  010 — Documents written in the portal (pasted / typed), stored as HTML
-- ============================================================
alter table public.documents add column if not exists body_html text;
alter table public.documents alter column file_path drop not null;
alter table public.documents alter column file_name drop not null;

notify pgrst, 'reload schema';
