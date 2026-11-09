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
