-- Serve the fully derived dashboard from cache so normal navigation does not
-- repeat GitHub workflow-content requests or aggregation work.
alter table workflow_runs_cache
  add column if not exists dashboard_data jsonb;

-- The previous default imported all available Actions history, which makes a
-- first dashboard render scale with repository age instead of current usage.
alter table user_settings
  alter column actions_lookback set default '30';

update user_settings
  set actions_lookback = '30', updated_at = now()
  where actions_lookback = 'all';
