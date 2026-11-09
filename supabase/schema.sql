-- ============================================================
--  HHG Client Portal — database schema + row-level security
--  Run this whole file once in Supabase: SQL Editor → New query → Run
-- ============================================================

create extension if not exists "pgcrypto";

-- ---------- enums ----------
do $$ begin
  create type public.org_role as enum ('admin', 'member');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.doc_category as enum
    ('handbook', 'policy', 'job_description', 'benefits', 'form', 'hiring_process', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.job_status as enum ('open', 'on_hold', 'filled', 'closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.candidate_stage as enum
    ('applied', 'screening', 'interview', 'offer', 'hired', 'passed');
exception when duplicate_object then null; end $$;

-- ---------- tables ----------
create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  logo_path   text,
  accent      text default '#23305a',
  created_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  email           text not null,
  full_name       text,
  is_super_admin  boolean not null default false,
  created_at      timestamptz not null default now()
);

create table if not exists public.memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  role        public.org_role not null default 'member',
  created_at  timestamptz not null default now(),
  unique (org_id, user_id)
);

create table if not exists public.invites (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.organizations(id) on delete cascade,
  email       text not null,
  role        public.org_role not null default 'member',
  invited_by  uuid references public.profiles(id) on delete set null,
  accepted_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (org_id, email)
);

create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  category       public.doc_category not null default 'other',
  title          text not null,
  description    text,
  file_path      text not null,          -- storage object path inside bucket org-files
  file_name      text not null,
  mime_type      text,
  size_bytes     bigint,
  version_label  text,                   -- e.g. "v3 — Nov 2026"
  staff_visible  boolean not null default false,  -- members can see it
  uploaded_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.job_orders (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references public.organizations(id) on delete cascade,
  title            text not null,
  department       text,
  location         text,
  employment_type  text,                 -- Full-time, Part-time, Contract...
  status           public.job_status not null default 'open',
  description      text,
  process_doc_id   uuid references public.documents(id) on delete set null,
  created_by       uuid references public.profiles(id) on delete set null,
  opened_at        date not null default current_date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table if not exists public.candidates (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organizations(id) on delete cascade,
  job_order_id   uuid not null references public.job_orders(id) on delete cascade,
  full_name      text not null,
  email          text,
  phone          text,
  source         text,                   -- Indeed, referral, LinkedIn...
  stage          public.candidate_stage not null default 'applied',
  resume_path    text,
  resume_name    text,
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table if not exists public.candidate_notes (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  candidate_id  uuid not null references public.candidates(id) on delete cascade,
  author_id     uuid references public.profiles(id) on delete set null,
  body          text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.activity_log (
  id           bigint generated always as identity primary key,
  org_id       uuid not null references public.organizations(id) on delete cascade,
  actor_id     uuid references public.profiles(id) on delete set null,
  entity_type  text not null,            -- document | job_order | candidate | membership
  entity_id    uuid,
  action       text not null,            -- created | updated | deleted | stage_changed | ...
  detail       jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists memberships_user_idx    on public.memberships(user_id);
create index if not exists documents_org_idx       on public.documents(org_id, category);
create index if not exists job_orders_org_idx      on public.job_orders(org_id, status);
create index if not exists candidates_job_idx      on public.candidates(job_order_id, stage);
create index if not exists notes_candidate_idx     on public.candidate_notes(candidate_id);
create index if not exists activity_org_idx        on public.activity_log(org_id, created_at desc);

-- ---------- updated_at trigger ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists documents_updated_at on public.documents;
create trigger documents_updated_at before update on public.documents
  for each row execute function public.set_updated_at();
drop trigger if exists job_orders_updated_at on public.job_orders;
create trigger job_orders_updated_at before update on public.job_orders
  for each row execute function public.set_updated_at();
drop trigger if exists candidates_updated_at on public.candidates;
create trigger candidates_updated_at before update on public.candidates
  for each row execute function public.set_updated_at();

-- ---------- new user → profile + redeem invites ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, lower(new.email), coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;

  -- any pending invites for this email become memberships
  insert into public.memberships (org_id, user_id, role)
  select i.org_id, new.id, i.role
  from public.invites i
  where lower(i.email) = lower(new.email) and i.accepted_at is null
  on conflict (org_id, user_id) do update set role = excluded.role;

  update public.invites set accepted_at = now()
  where lower(email) = lower(new.email) and accepted_at is null;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- If an invite is created for someone who ALREADY has an account, grant immediately.
create or replace function public.handle_new_invite() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select id into uid from public.profiles where lower(email) = lower(new.email);
  if uid is not null then
    insert into public.memberships (org_id, user_id, role)
    values (new.org_id, uid, new.role)
    on conflict (org_id, user_id) do update set role = excluded.role;
    new.accepted_at = now();
  end if;
  return new;
end $$;

drop trigger if exists on_invite_created on public.invites;
create trigger on_invite_created before insert on public.invites
  for each row execute function public.handle_new_invite();

-- ---------- access helper functions (security definer: no RLS recursion) ----------
create or replace function public.is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_super_admin from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.org_role(p_org uuid) returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.is_super_admin() then 'super'
    else (select role::text from public.memberships where org_id = p_org and user_id = auth.uid())
  end;
$$;

create or replace function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) is not null;
$$;

create or replace function public.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.org_role(p_org) in ('super', 'admin');
$$;

-- can the current user read this storage object path?  path = <org_id>/<area>/<file>
create or replace function public.can_read_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid; area text;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  area := split_part(p_path, '/', 2);
  if public.is_org_admin(org) then return true; end if;
  if not public.is_org_member(org) then return false; end if;
  -- members: branding always; documents only when flagged staff-visible
  if area = 'branding' then return true; end if;
  if area = 'documents' then
    return exists (select 1 from public.documents d
                   where d.file_path = p_path and d.org_id = org and d.staff_visible);
  end if;
  return false;
end $$;

create or replace function public.can_write_path(p_path text) returns boolean
language plpgsql stable security definer set search_path = public as $$
declare org uuid;
begin
  begin org := split_part(p_path, '/', 1)::uuid; exception when others then return false; end;
  return public.is_org_admin(org);
end $$;

-- ---------- row-level security ----------
alter table public.organizations   enable row level security;
alter table public.profiles        enable row level security;
alter table public.memberships     enable row level security;
alter table public.invites         enable row level security;
alter table public.documents       enable row level security;
alter table public.job_orders      enable row level security;
alter table public.candidates      enable row level security;
alter table public.candidate_notes enable row level security;
alter table public.activity_log    enable row level security;

-- organizations
drop policy if exists org_select on public.organizations;
create policy org_select on public.organizations for select
  using (public.is_org_member(id));
drop policy if exists org_super_write on public.organizations;
create policy org_super_write on public.organizations for all
  using (public.is_super_admin()) with check (public.is_super_admin());
drop policy if exists org_admin_update on public.organizations;
create policy org_admin_update on public.organizations for update
  using (public.is_org_admin(id)) with check (public.is_org_admin(id));

-- profiles: see yourself, anyone who shares an org with you, or everyone if super
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using (
    id = auth.uid()
    or public.is_super_admin()
    or exists (select 1 from public.memberships m1
               join public.memberships m2 on m1.org_id = m2.org_id
               where m1.user_id = auth.uid() and m2.user_id = profiles.id)
  );
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid()) with check (id = auth.uid());

-- nobody can promote themselves to super admin through the API
create or replace function public.guard_super_admin() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return new; end if;   -- SQL editor / service role: allowed
  if new.is_super_admin is distinct from old.is_super_admin and not public.is_super_admin() then
    new.is_super_admin = old.is_super_admin;
  end if;
  new.email = old.email;   -- email changes go through auth, not here
  return new;
end $$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles
  for each row execute function public.guard_super_admin();

-- memberships
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select
  using (public.is_org_member(org_id));
drop policy if exists memberships_admin_write on public.memberships;
create policy memberships_admin_write on public.memberships for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- invites
drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- documents
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select
  using (public.is_org_admin(org_id) or (staff_visible and public.is_org_member(org_id)));
drop policy if exists documents_admin_write on public.documents;
create policy documents_admin_write on public.documents for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- hiring: admins only (never client members)
drop policy if exists job_orders_admin on public.job_orders;
create policy job_orders_admin on public.job_orders for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists candidates_admin on public.candidates;
create policy candidates_admin on public.candidates for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));
drop policy if exists notes_admin on public.candidate_notes;
create policy notes_admin on public.candidate_notes for all
  using (public.is_org_admin(org_id)) with check (public.is_org_admin(org_id));

-- activity log: admins read; any member may write their own entries
drop policy if exists activity_select on public.activity_log;
create policy activity_select on public.activity_log for select
  using (public.is_org_admin(org_id));
drop policy if exists activity_insert on public.activity_log;
create policy activity_insert on public.activity_log for insert
  with check (public.is_org_member(org_id) and actor_id = auth.uid());

-- ---------- storage bucket + policies ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('org-files', 'org-files', false, 26214400)   -- 25 MB per file
on conflict (id) do update set public = false, file_size_limit = 26214400;

drop policy if exists "org-files read"   on storage.objects;
drop policy if exists "org-files insert" on storage.objects;
drop policy if exists "org-files update" on storage.objects;
drop policy if exists "org-files delete" on storage.objects;

create policy "org-files read" on storage.objects for select
  using (bucket_id = 'org-files' and public.can_read_path(name));
create policy "org-files insert" on storage.objects for insert
  with check (bucket_id = 'org-files' and public.can_write_path(name));
create policy "org-files update" on storage.objects for update
  using (bucket_id = 'org-files' and public.can_write_path(name));
create policy "org-files delete" on storage.objects for delete
  using (bucket_id = 'org-files' and public.can_write_path(name));

-- ---------- grants ----------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;

-- ============================================================
--  AFTER you sign up in the portal with your own email, run:
--    update public.profiles set is_super_admin = true where email = 'jen@hopeharvestgroup.com';
-- ============================================================
