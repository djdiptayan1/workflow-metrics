alter table user_settings
	add column if not exists ai_provider text not null default 'openai'
		check (ai_provider in ('openai', 'gemini')),
	add column if not exists ai_api_key text;
