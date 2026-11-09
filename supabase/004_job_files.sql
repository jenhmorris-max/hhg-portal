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
