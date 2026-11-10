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

notify pgrst, 'reload schema';
