-- Migration 014 only added SELECT policies, so every write to workflow_preferences and
-- repository_workflow_settings fell back to the admin (service-role) client — including
-- personal-mode writes, which have no reason to need it. Add write policies scoped to a
-- user's own tracked repositories so personal-mode pin/environment writes work over the
-- normal authenticated session. Shared-mode writes (user_id is null) still require the
-- admin client in application code, since no per-user RLS policy can authorize those.

create policy "Tracked users can insert their own workflow preferences"
  on workflow_preferences for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from repositories
      where repositories.github_repo_id = workflow_preferences.github_repo_id
        and repositories.user_id = auth.uid()
    )
  );

create policy "Tracked users can update their own workflow preferences"
  on workflow_preferences for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Tracked users can delete their own workflow preferences"
  on workflow_preferences for delete
  using (user_id = auth.uid());

-- repository_workflow_settings has no user_id column (one row per repo, not per user).
-- The application layer already verifies GitHub repo-admin status (requireAdmin) before
-- calling this write, so any user tracking the repo may perform the DB write itself.
create policy "Tracked users can insert repository workflow settings"
  on repository_workflow_settings for insert
  with check (
    exists (
      select 1 from repositories
      where repositories.github_repo_id = repository_workflow_settings.github_repo_id
        and repositories.user_id = auth.uid()
    )
  );

create policy "Tracked users can update repository workflow settings"
  on repository_workflow_settings for update
  using (
    exists (
      select 1 from repositories
      where repositories.github_repo_id = repository_workflow_settings.github_repo_id
        and repositories.user_id = auth.uid()
    )
  );
