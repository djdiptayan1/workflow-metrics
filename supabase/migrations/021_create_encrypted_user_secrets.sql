-- Credentials must never be readable through the Supabase Data API. Ciphertext is
-- stored in a private schema and may only be accessed through service-role-only RPCs.
-- The application encrypts/decrypts with SECRETS_ENCRYPTION_KEY before/after these RPCs.

create schema if not exists private;

revoke all on schema private from public, anon, authenticated;

create table if not exists private.user_secrets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  github_access_token_ciphertext text,
  ai_api_key_ciphertext text,
  encryption_version smallint not null default 1 check (encryption_version = 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (github_access_token_ciphertext is not null or ai_api_key_ciphertext is not null)
);

revoke all on private.user_secrets from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update, delete on private.user_secrets to service_role;

create or replace function private.set_user_secrets_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_user_secrets_updated_at on private.user_secrets;
create trigger set_user_secrets_updated_at
before update on private.user_secrets
for each row execute function private.set_user_secrets_updated_at();

create or replace function public.get_user_secret_ciphertexts(p_user_id uuid)
returns table (
  github_access_token_ciphertext text,
  ai_api_key_ciphertext text,
  encryption_version smallint
)
language sql
security definer
set search_path = private, pg_catalog
as $$
  select
    user_secrets.github_access_token_ciphertext,
    user_secrets.ai_api_key_ciphertext,
    user_secrets.encryption_version
  from private.user_secrets
  where user_secrets.user_id = p_user_id;
$$;

create or replace function public.upsert_user_secret_ciphertexts(
  p_user_id uuid,
  p_github_access_token_ciphertext text default null,
  p_ai_api_key_ciphertext text default null
)
returns void
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
begin
  if p_github_access_token_ciphertext is null and p_ai_api_key_ciphertext is null then
    raise exception 'at least one ciphertext is required';
  end if;

  insert into private.user_secrets (
    user_id,
    github_access_token_ciphertext,
    ai_api_key_ciphertext
  )
  values (
    p_user_id,
    p_github_access_token_ciphertext,
    p_ai_api_key_ciphertext
  )
  on conflict (user_id) do update set
    github_access_token_ciphertext = coalesce(
      excluded.github_access_token_ciphertext,
      private.user_secrets.github_access_token_ciphertext
    ),
    ai_api_key_ciphertext = coalesce(
      excluded.ai_api_key_ciphertext,
      private.user_secrets.ai_api_key_ciphertext
    );
end;
$$;

create or replace function public.clear_user_ai_api_key_ciphertext(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = private, pg_catalog
as $$
begin
  delete from private.user_secrets
  where user_id = p_user_id
    and github_access_token_ciphertext is null;

  update private.user_secrets
  set ai_api_key_ciphertext = null
  where user_id = p_user_id;
end;
$$;

revoke all on function public.get_user_secret_ciphertexts(uuid) from public, anon, authenticated;
revoke all on function public.upsert_user_secret_ciphertexts(uuid, text, text) from public, anon, authenticated;
revoke all on function public.clear_user_ai_api_key_ciphertext(uuid) from public, anon, authenticated;

grant execute on function public.get_user_secret_ciphertexts(uuid) to service_role;
grant execute on function public.upsert_user_secret_ciphertexts(uuid, text, text) to service_role;
grant execute on function public.clear_user_ai_api_key_ciphertext(uuid) to service_role;
