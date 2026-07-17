alter table user_settings
add column if not exists average_duration_window text not null default 'recent_150'
check (average_duration_window in ('recent_150', 'recent_14_days'));
