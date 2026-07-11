alter table user_settings
	add column if not exists actions_lookback text not null default 'all'
	check (actions_lookback in ('7', '30', '90', 'all'));
