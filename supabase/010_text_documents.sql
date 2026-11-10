-- ============================================================
--  010 — Documents written in the portal (pasted / typed), stored as HTML
-- ============================================================
alter table public.documents add column if not exists body_html text;
alter table public.documents alter column file_path drop not null;
alter table public.documents alter column file_name drop not null;
notify pgrst, 'reload schema';
