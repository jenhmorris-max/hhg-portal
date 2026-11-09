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
