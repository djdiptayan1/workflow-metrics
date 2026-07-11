alter table user_settings
	drop constraint if exists user_settings_ai_provider_check;

alter table user_settings
	add constraint user_settings_ai_provider_check
	check (ai_provider in ('openai', 'gemini', 'mistral'));
