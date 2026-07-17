# Workflow Metrics setup and operations runbook

This is the complete setup guide for a human or an AI coding agent starting from an empty machine.
Commands are run from the repository root unless a step says otherwise.

## Choose one setup

| Goal                         | Supabase                 | Application                            | Recommended for                 |
| ---------------------------- | ------------------------ | -------------------------------------- | ------------------------------- |
| Fastest working installation | Hosted Supabase          | Published Docker image + bundled Redis | Most users and servers          |
| Fully local installation     | Local Supabase CLI stack | Published Docker image + bundled Redis | Offline development and testing |
| Source development           | Hosted or local Supabase | `pnpm dev` + a local Redis container   | Contributors changing code      |

The application always needs:

- Supabase for authentication, settings, repositories, and preferences.
- Redis for disposable GitHub run and dashboard caches.
- A GitHub OAuth App for read-only login and access to GitHub repositories, Actions, pull requests, and logs.
- An AI provider key only if users need AI analysis or optimization.
- A server-only `SECRETS_ENCRYPTION_KEY` to encrypt GitHub OAuth tokens and AI provider keys at rest.

## Security rules

- Never commit `.env`, `supabase/.env`, Supabase secret keys, OAuth client secrets, encryption keys, or AI provider keys.
- `PUBLIC_SUPABASE_ANON_KEY` is a historical variable name. Put the current Supabase
  **publishable** key in it. This key is expected to be visible to the browser.
- `SUPABASE_SERVICE_ROLE_KEY` is also a historical variable name. Put the current Supabase
  **secret** key in it. It bypasses Row Level Security and must remain server-only.
- `SECRETS_ENCRYPTION_KEY` must be a base64url-encoded 32-byte key. It encrypts credentials at rest,
  must remain server-only, and must be retained securely: changing or losing it prevents decrypting
  existing credentials.
- Generate a key with Node's built-in crypto module:

  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  ```

- Legacy Supabase `anon` and `service_role` keys also work, but new hosted projects should prefer
  `sb_publishable_...` and `sb_secret_...` keys.
- Keep the root `.env` file readable only by the deployment user:

  ```bash
  chmod 600 .env
  ```

## 1. Prerequisites

All installations need:

- Git
- [Docker Desktop](https://docs.docker.com/desktop/), Docker Engine with Compose v2, or another
  Docker-compatible runtime
- A GitHub account

Fully local Supabase also needs the
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started).
The complete local Supabase stack recommends at least 7 GB of memory available to Docker.

Source development also needs:

- [Node.js 24](https://nodejs.org/en/download)
- pnpm 10

On macOS, install the Supabase CLI with Homebrew:

```bash
brew install supabase/tap/supabase
```

For Windows, Linux, or a project-scoped npm installation, follow the linked Supabase CLI guide.
Do not use `npm install -g supabase`; the npm distribution is intended to be a project dependency.

For source development, enable the pnpm version used by the Docker build:

```bash
corepack enable
corepack prepare pnpm@10.30.2 --activate
```

Verify what you installed:

```bash
git --version
docker --version
docker compose version
```

For local Supabase or hosted database migrations:

```bash
supabase --version
```

For source development:

```bash
node --version
pnpm --version
```

Docker must be running before continuing.

## 2. Clone the repository

```bash
git clone https://github.com/djdiptayan1/workflow-metrics.git
cd workflow-metrics
```

Do not run `pnpm install` when using only the published Docker image.

## 3. Set up Supabase

Choose exactly one path: hosted Supabase or local Supabase.

### Path A: hosted Supabase (recommended)

#### A1. Create the project

1. Open [Supabase Dashboard](https://supabase.com/dashboard).
2. Select an organization and click **New project**.
3. Choose a project name, database password, and a region close to the application server.
4. Save the database password in a password manager. The CLI asks for it when linking.
5. Wait until the project reports healthy.
6. Copy the project reference from the dashboard URL:
   `https://supabase.com/dashboard/project/<project-ref>`.

#### A2. Apply this repository's database migrations

Do not create the tables manually in the Table Editor. The migrations include the required tables,
indexes, constraints, grants, and Row Level Security policies.

```bash
supabase login
supabase link --project-ref <project-ref>
supabase db push
supabase migration list
```

Expected result for a fresh project: every migration under `supabase/migrations/` appears applied to
the linked remote project. Run `supabase db push` only from a trusted checkout because it changes the
linked database.

> **Existing hosted deployments:** do not apply migrations `021` and `022` together with a routine
> `supabase db push`. Migration `022` deliberately fails while plaintext credentials remain. Apply
> `021`, run the credential migration script and verify its dry run, then apply `022` as described in
> [Migrate existing credentials](#migrate-existing-credentials). Take a database backup and run this
> sequence in a maintenance window; it changes stored credentials and `022` permanently removes the
> plaintext columns.

#### A3. Get the project URL and API keys

1. Open the project in Supabase Dashboard.
2. Use the **Connect** dialog, or open **Settings → API Keys**.
3. Copy the project URL, normally `https://<project-ref>.supabase.co`.
4. Copy a **Publishable key** (`sb_publishable_...`).
5. Copy a **Secret key** (`sb_secret_...`). Create one if the project does not have one.

Map the values to the application's variables:

| Supabase value                           | Application variable        |
| ---------------------------------------- | --------------------------- |
| Project URL                              | `PUBLIC_SUPABASE_URL`       |
| Publishable key, or legacy `anon` key    | `PUBLIC_SUPABASE_ANON_KEY`  |
| Secret key, or legacy `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` |

Do not put the secret key in a browser, screenshot, issue, chat message, or Git repository.

#### A4. Configure the application URLs in Supabase Auth

Open **Authentication → URL Configuration**.

For a localhost installation:

- **Site URL:** `http://localhost:5173`
- **Redirect URL:** `http://localhost:5173/auth/callback`

For a production installation at `https://metrics.example.com`:

- **Site URL:** `https://metrics.example.com`
- **Redirect URL:** `https://metrics.example.com/auth/callback`

If the same Supabase project is used for local development and production, keep the production Site
URL and add both exact callback URLs to the redirect allow list.

#### A5. Create the GitHub OAuth App used for login

This is the application's only GitHub integration and is used for read-only access.

1. In Supabase, open **Authentication → Sign In / Providers → GitHub**.
2. Copy the callback URL shown there. It normally is:
   `https://<project-ref>.supabase.co/auth/v1/callback`.
3. Open [GitHub's New OAuth App page](https://github.com/settings/applications/new).
4. Enter:
   - **Application name:** a recognizable name such as `Workflow Metrics`.
   - **Homepage URL:** `http://localhost:5173` locally, or the public HTTPS application URL.
   - **Authorization callback URL:** the Supabase callback URL copied in step 2.
   - **Enable Device Flow:** off.
5. Register the application.
6. Copy the **Client ID**.
7. Click **Generate a new client secret** and copy the secret immediately.
8. Return to **Supabase → Authentication → Sign In / Providers → GitHub**.
9. Enable GitHub, paste the Client ID and Client secret, and save.

The OAuth client secret belongs in Supabase, not in the application's root `.env` file.

#### A6. Create the root `.env`

```bash
cp .env.example .env
```

For localhost with hosted Supabase, use:

```env
PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...

# Server-only; generate with Node's built-in crypto command in Security rules.
SECRETS_ENCRYPTION_KEY=<base64url-encoded 32-byte key>

# Used only by direct pnpm/Node runs. Compose replaces it with redis://redis:6379.
REDIS_URL=redis://127.0.0.1:6379

# Leave these commented on localhost.
# PUBLIC_APP_URL=https://metrics.example.com
# ORIGIN=https://metrics.example.com
```

For production, also set both public URL variables to the externally reachable HTTPS origin:

```env
PUBLIC_APP_URL=https://metrics.example.com
ORIGIN=https://metrics.example.com
```

Do not add `SUPABASE_INTERNAL_URL` when using hosted Supabase.

Continue at [Start with Docker Compose](#4-start-with-docker-compose).

### Path B: fully local Supabase

The repository already contains `supabase/config.toml` and all migrations. Do not run
`supabase init`.

#### B1. Create a separate local GitHub OAuth App

GitHub OAuth Apps accept only one callback URL, so use a separate OAuth App when you also have a
hosted Supabase project.

1. Open [GitHub's New OAuth App page](https://github.com/settings/applications/new).
2. Enter:
   - **Application name:** `Workflow Metrics Local` or another unique name.
   - **Homepage URL:** `http://localhost:5173`.
   - **Authorization callback URL:** `http://127.0.0.1:54321/auth/v1/callback`.
   - **Enable Device Flow:** off.
3. Register the application.
4. Copy the Client ID and generate a Client secret.

#### B2. Configure local Supabase's GitHub provider

Create `supabase/.env` with the exact names referenced by `supabase/config.toml`:

```env
GITHUB_OAUTH_CLIENT_ID=<GitHub OAuth App Client ID>
GITHUB_OAUTH_CLIENT_SECRET=<GitHub OAuth App Client secret>
```

Protect it:

```bash
chmod 600 supabase/.env
```

Do not rename these to `SUPABASE_AUTH_GITHUB_*`; those names are not used by this repository.

The Supabase CLI normally auto-loads the root `.env`. This guide keeps provider credentials in a
separate file so Compose does not pass the GitHub OAuth secret into the application container.

#### B3. Start local Supabase

Export the provider credentials into the current shell, then start Supabase:

```bash
set -a
. supabase/.env
set +a
supabase start
supabase status
```

The first start downloads several Docker images. It also applies every migration under
`supabase/migrations/` and the local seed file.

Copy these values from `supabase status` without sharing them:

| Status value                 | Typical local value           | Application variable        |
| ---------------------------- | ----------------------------- | --------------------------- |
| API URL                      | `http://127.0.0.1:54321`      | `PUBLIC_SUPABASE_URL`       |
| Publishable or `anon` key    | `sb_publishable_...` or a JWT | `PUBLIC_SUPABASE_ANON_KEY`  |
| Secret or `service_role` key | `sb_secret_...` or a JWT      | `SUPABASE_SERVICE_ROLE_KEY` |
| Studio URL                   | `http://127.0.0.1:54323`      | Not an environment variable |

If the OAuth App was added after Supabase was already running, restart the local stack:

```bash
supabase stop
set -a
. supabase/.env
set +a
supabase start
```

#### B4. Create the root `.env`

```bash
cp .env.example .env
```

Use the values printed by `supabase status`:

```env
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
PUBLIC_SUPABASE_ANON_KEY=<local Publishable or ANON key>
SUPABASE_SERVICE_ROLE_KEY=<local Secret or SERVICE_ROLE key>

# Server-only; generate with Node's built-in crypto command in Security rules.
SECRETS_ENCRYPTION_KEY=<base64url-encoded 32-byte key>

# The app container reaches services on the host through this address.
SUPABASE_INTERNAL_URL=http://host.docker.internal:54321

# Used only by direct pnpm/Node runs. Compose replaces it with redis://redis:6379.
REDIS_URL=redis://127.0.0.1:6379

# Leave these commented on localhost.
# PUBLIC_APP_URL=https://metrics.example.com
# ORIGIN=https://metrics.example.com
```

Why there are two Supabase URLs:

- The browser needs `PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`.
- Inside the app container, `127.0.0.1` means the app container itself, so server requests use
  `SUPABASE_INTERNAL_URL=http://host.docker.internal:54321`.

### Migrate existing credentials

A fresh local database applies all migrations during `supabase start`; no separate credential migration
is needed. For an **existing local database** that contains plaintext GitHub OAuth tokens or AI keys,
perform this sequence before starting the updated application:

1. Generate and securely retain `SECRETS_ENCRYPTION_KEY` as described in [Security rules](#security-rules).
2. Apply pending local migrations. This applies `021_create_encrypted_user_secrets.sql` and then stops
   at `022_remove_plaintext_credential_columns.sql` with the expected plaintext-credentials guard:

   ```bash
   supabase migration up --local
   ```

3. Run the credential migration in dry-run mode. Provide the local API URL, the service-role key from
   `supabase status`, and the **same** server-only encryption key that the application will use:

   ```bash
   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local-secret-key> SECRETS_ENCRYPTION_KEY=<base64url-encoded-32-byte-key> node scripts/migrate-user-secrets.mjs --dry-run
   ```

   Confirm that the reported `usersWithCredentials`, `githubTokens`, and `aiApiKeys` counts are expected.

4. Run the migration without `--dry-run`:

   ```bash
   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local-secret-key> SECRETS_ENCRYPTION_KEY=<base64url-encoded-32-byte-key> node scripts/migrate-user-secrets.mjs
   ```

5. Apply `022_remove_plaintext_credential_columns.sql`:

   ```bash
   supabase migration up --local
   ```

Do not rotate or replace `SECRETS_ENCRYPTION_KEY` after this migration without a planned credential
re-encryption process. The script reads plaintext columns, writes AES-256-GCM ciphertext through
service-role RPCs, and `022` removes the original columns.

## 4. Start with Docker Compose

Compose reads the root `.env` automatically and also passes it to the application container using
`env_file`. You do not need individual `-e` flags.

The application image is `djdiptayan/workflow-metrics:latest`. Redis runs only on Compose's
internal network; port 6379 is not published to the host.

### First start using the published image

```bash
docker compose pull
docker compose up -d --no-build
docker compose ps
```

Expected state: both `ci-observe` and `redis` show `healthy`.

Check the application health endpoint:

```bash
curl --fail http://localhost:5173/api/health
```

Expected response:

```json
{ "status": "ok" }
```

Open [http://localhost:5173](http://localhost:5173), click **Sign in with GitHub**, authorize the
requested `repo` and `read:org` scopes, then select repositories during onboarding.

### View logs

```bash
docker compose logs -f --tail=100 ci-observe
```

Press `Ctrl+C` to stop following logs; the containers keep running.

### Stop or restart

```bash
docker compose stop
docker compose start
```

To remove the containers while preserving the Redis cache volume:

```bash
docker compose down
```

Use `docker compose down -v` only when intentionally deleting the disposable Redis cache and
forcing a cold GitHub import.

## 5. Optional AI provider key

AI features do not need a server environment variable. Each signed-in user configures a provider
key in **Settings → AI Provider**.

Create a key from the provider's official console:

- [OpenAI API keys](https://platform.openai.com/api-keys)
- [Google AI Studio / Gemini API keys](https://aistudio.google.com/app/apikey)
- [Mistral Studio API keys](https://console.mistral.ai/api-keys)

Then:

1. Open Workflow Metrics **Settings**.
2. Select OpenAI, Google Gemini, or Mistral AI.
3. Paste the provider key.
4. Load/select an available model.
5. Save settings.

The key is encrypted before storage in the private `user_secrets` schema; only server-side code using
`SECRETS_ENCRYPTION_KEY` can decrypt it. Treat the database, encryption key, and backups as
secret-bearing infrastructure.

`AI_OPTIMIZATION_MODEL` is an optional server-side default-model override. Most installations do
not need it.

## 6. Source development instead of the published image

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Start a loopback-only Redis container:

```bash
docker run -d --name workflow-metrics-redis \
  -p 127.0.0.1:6379:6379 \
  redis:8-alpine redis-server --maxmemory 384mb --maxmemory-policy allkeys-lru
```

Keep `REDIS_URL=redis://127.0.0.1:6379` in the root `.env`, then run:

```bash
pnpm dev
```

For a local application image built from the checkout:

```bash
CI_OBSERVE_IMAGE=workflow-metrics:local docker compose build ci-observe
CI_OBSERVE_IMAGE=workflow-metrics:local docker compose up -d --no-build
```

Before committing application changes:

```bash
pnpm test
pnpm check
pnpm lint
pnpm build
```

## 7. Environment variable reference

| Variable                    | Required                     | Source and purpose                                                       |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| `PUBLIC_SUPABASE_URL`       | Yes                          | Supabase project API URL; browser-visible                                |
| `PUBLIC_SUPABASE_ANON_KEY`  | Yes                          | Supabase publishable key or legacy `anon` key; browser-visible           |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes                          | Supabase secret key or legacy `service_role`; server-only                |
| `SUPABASE_INTERNAL_URL`     | Local Supabase + Docker only | Container-reachable Supabase API URL                                     |
| `REDIS_URL`                 | Yes for direct runs          | Compose overrides it with `redis://redis:6379`                           |
| `PUBLIC_APP_URL`            | Production only              | Public HTTPS application origin used for OAuth return URLs               |
| `ORIGIN`                    | Production only              | Adapter Node origin; normally the same as `PUBLIC_APP_URL`               |
| `SECRETS_ENCRYPTION_KEY`    | Yes                          | Base64url-encoded 32-byte credential-encryption key; server-only        |
| `AI_OPTIMIZATION_MODEL`     | No                           | Optional default AI model override                                       |
| `CI_OBSERVE_IMAGE`          | No                           | Compose image override; defaults to `djdiptayan/workflow-metrics:latest` |

The GitHub OAuth Client ID and Client secret are deliberately absent from this table:

- Hosted Supabase stores them in **Authentication → Sign In / Providers → GitHub**.
- Local Supabase reads them from the shell as `GITHUB_OAUTH_CLIENT_ID` and
  `GITHUB_OAUTH_CLIENT_SECRET`; this runbook stores and sources them from `supabase/.env`.

## 8. Updating an installation

Pull the latest Compose and documentation changes, then pull and recreate the containers:

```bash
git pull --ff-only
docker compose pull
docker compose up -d --no-build
docker compose ps
```

The named Redis volume survives container recreation. Returning to the dashboard reads cached data
unless the configured freshness interval has expired.

After changing any root `.env` value, recreate the application container:

```bash
docker compose up -d --no-build --force-recreate ci-observe
```

## 9. Verification checklist

1. `docker compose ps` reports both services healthy.
2. `curl --fail http://localhost:5173/api/health` returns `{"status":"ok"}`.
3. GitHub login returns to `/auth/callback`, then onboarding or the dashboard.
4. A new row appears in Supabase `github_connections` after first login.
5. Onboarding lists repositories the GitHub user can access.
6. Opening a repository dashboard starts or reads the Redis-backed GitHub run cache.
7. Dashboard → Settings → Dashboard does not repaginate all GitHub workflow runs while the cache is
   fresh.
8. GitHub access remains read-only: the app can read the selected repository data but does not create
   branches, modify workflow files, or open pull requests.

For local Supabase, inspect data at [http://127.0.0.1:54323](http://127.0.0.1:54323).

## 10. Troubleshooting

### Login returns to `/auth/login`

Check all three URL layers:

1. GitHub OAuth App callback is the Supabase Auth callback, not the Workflow Metrics callback.
2. Supabase GitHub provider contains the same OAuth Client ID and Client secret.
3. Supabase Auth redirect allow list contains the exact Workflow Metrics callback:
   `http://localhost:5173/auth/callback` or `https://your-domain/auth/callback`.

Then inspect:

```bash
docker compose logs --tail=200 ci-observe
```

### `Invalid API key` after `.env` was corrected

The running container may still contain the previous value. Recreate it:

```bash
docker compose up -d --no-build --force-recreate ci-observe
```

Do not print complete keys in logs while debugging.

### Local Supabase fails with `ECONNREFUSED 127.0.0.1:54321`

When the app runs in Compose, confirm the root `.env` contains both:

```env
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_INTERNAL_URL=http://host.docker.internal:54321
```

Also confirm `supabase status` reports the local stack running.

### OAuth provider reports a callback mismatch

- Hosted Supabase callback: `https://<project-ref>.supabase.co/auth/v1/callback`
- This repository's local Supabase callback: `http://127.0.0.1:54321/auth/v1/callback`
- Workflow Metrics callback allowed by Supabase: `http://localhost:5173/auth/callback`

These URLs serve different hops and are not interchangeable.

### Private or organization repositories are missing

The login flow requests GitHub's `repo` and `read:org` scopes. Check whether the organization
requires an administrator to approve the OAuth App or requires SAML SSO authorization. If scopes
were denied, revoke the OAuth App under GitHub **Settings → Applications → Authorized OAuth Apps**
and sign in again.

### Redis or dashboard API returns `503`

```bash
docker compose ps
docker compose logs --tail=200 redis
docker compose restart redis
```

Redis is required. The application intentionally does not start an unbounded GitHub import when
Redis is unavailable.



### Migrations are missing locally

Resetting deletes local database data and reapplies migrations:

```bash
supabase db reset
```

Do not run `supabase db reset --linked` against production.

### Force a completely cold GitHub cache import

```bash
docker compose down -v
docker compose up -d --no-build
```

This deletes only the Compose Redis volume. It does not delete hosted Supabase data.

## Official references

- [Supabase local development](https://supabase.com/docs/guides/local-development)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
- [Supabase GitHub login](https://supabase.com/docs/guides/auth/social-login/auth-github)
- [Supabase database migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [GitHub OAuth App registration](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [Docker Compose environment variables](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)
