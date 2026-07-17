-- Replace the broad grants from migration 019 with explicit privileges.
-- RLS remains the tenant-isolation control; these grants prevent anonymous access
-- and stop future public tables/functions from becoming callable by default.

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
revoke all on schema public from anon;

grant usage on schema public to authenticated;

grant select, insert, update on public.github_connections to authenticated;
grant select, insert, update on public.repositories to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant select, insert, update, delete on public.dora_workflows to authenticated;
grant select, insert, update, delete on public.optimization_history to authenticated;
grant select, insert, update, delete on public.workflow_preferences to authenticated;

revoke all on all functions in schema public from public;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
