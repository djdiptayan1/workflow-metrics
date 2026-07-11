alter table user_settings
  add column if not exists dashboard_refresh_interval text not null default '5'
  check (dashboard_refresh_interval in ('realtime', '5', '10', '15'));
