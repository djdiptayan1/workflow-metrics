-- Shared workflow preferences relied on application-only GitHub-admin checks that
-- authenticated users could bypass through the Supabase Data API. Preferences are
-- now strictly personal and database-enforced by user_id = auth.uid().

delete from public.workflow_preferences where user_id is null;

drop policy if exists "Tracked users can read workflow preferences" on public.workflow_preferences;
drop policy if exists "Tracked users can insert their own workflow preferences" on public.workflow_preferences;
drop policy if exists "Tracked users can update their own workflow preferences" on public.workflow_preferences;
drop policy if exists "Tracked users can delete their own workflow preferences" on public.workflow_preferences;

create policy "Users can read their own workflow preferences"
  on public.workflow_preferences for select to authenticated
  using (user_id = auth.uid());

create policy "Users can insert their own workflow preferences"
  on public.workflow_preferences for insert to authenticated
  with check (user_id = auth.uid());

create policy "Users can update their own workflow preferences"
  on public.workflow_preferences for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can delete their own workflow preferences"
  on public.workflow_preferences for delete to authenticated
  using (user_id = auth.uid());

drop table if exists public.repository_workflow_settings;
drop table if exists public.github_app_installations;
