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
