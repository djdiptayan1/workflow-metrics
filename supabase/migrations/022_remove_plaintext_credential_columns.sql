-- Apply migration 021, then run:
--   node scripts/migrate-user-secrets.mjs --dry-run
--   node scripts/migrate-user-secrets.mjs
-- This guard intentionally blocks credential-column removal until every existing
-- plaintext credential has been copied into private.user_secrets as ciphertext.

do $$
begin
  if exists (select 1 from public.github_connections where access_token is not null)
    or exists (select 1 from public.user_settings where ai_api_key is not null) then
    raise exception 'Plaintext credentials remain. Run scripts/migrate-user-secrets.mjs before migration 022.';
  end if;
end;
$$;

alter table public.github_connections drop column access_token;
alter table public.user_settings
  drop column mistral_api_key,
  drop column ai_api_key,
  drop column github_write_token;
