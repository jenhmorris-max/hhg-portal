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
notify pgrst, 'reload schema';
