# Local Setup (Local Supabase, step by step)

Complete, from-zero instructions for running Workflow Metrics locally against a **local Supabase
stack** (not a hosted Supabase project). Written to be followed exactly by a human or an AI coding
agent — every command is copy-pasteable and every value referenced is either a fixed local default
or explicitly retrieved by an earlier step.

If you'd rather use a hosted Supabase project instead of running Supabase locally, use the
[README's Getting Started section](README.md#getting-started) instead — this doc is specifically
for the local-Supabase workflow.

## Prerequisites

- Node.js >= 24
- PNPM >= 10
- Docker Desktop (running) — both the Supabase CLI and this app's optional `docker compose` setup
  depend on it
- [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) (`brew
install supabase/tap/supabase` on macOS)
- A GitHub account with permission to create OAuth Apps and GitHub Apps

## 1. Clone and install

```bash
git clone https://github.com/timoa/workflow-metrics.git
cd workflow-metrics
pnpm install
```

## 2. Start local Supabase

```bash
supabase start
```

This boots Postgres, Auth, Storage, Realtime, Kong, and Studio in Docker containers, and applies
every migration in `supabase/migrations/` automatically.

When it finishes, print the local connection details:

```bash
supabase status
```

Keep this output handy — you'll copy values from it into `.env` in step 5. The relevant ones:

| `supabase status` key | Fixed local value                                                        |
| --------------------- | ------------------------------------------------------------------------ |
| `API_URL`             | `http://127.0.0.1:54321`                                                 |
| `ANON_KEY`            | (long JWT, starts with `eyJ...`, role `anon`)                            |
| `SERVICE_ROLE_KEY`    | (long JWT, starts with `eyJ...`, role `service_role`)                    |
| `STUDIO_URL`          | `http://127.0.0.1:54323` — local dashboard, useful for inspecting tables |

If some services (e.g. `pooler`, `imgproxy`) show as stopped, that's normal — this app doesn't use
them. Only `db`, `auth`, `rest`, `kong`, `storage`, `realtime` need to be healthy:

```bash
docker ps --filter "name=supabase" --format "table {{.Names}}\t{{.Status}}"
```

## 3. Create a GitHub OAuth App (for login)

This is a GitHub **OAuth App**, not a GitHub App (that's step 4).

1. Go to [GitHub → Settings → Developer settings → OAuth Apps → New OAuth
   App](https://github.com/settings/applications/new).
2. **Homepage URL**: `http://localhost:5173`
3. **Authorization callback URL** — must point at your **local Supabase's** auth callback, not the
   app itself:
   ```
   http://127.0.0.1:54321/auth/v1/callback
   ```
4. Create the app, then copy the **Client ID** and generate/copy a **Client secret**.
5. Configure the local Supabase Auth server with these values. Open
   `supabase/config.toml` and confirm/set:
   ```toml
   [auth.external.github]
   enabled = true
   client_id = "env(SUPABASE_AUTH_GITHUB_CLIENT_ID)"
   secret = "env(SUPABASE_AUTH_GITHUB_SECRET)"
   ```
   Then export the values before (re)starting Supabase, e.g. in `supabase/.env` (gitignored):
   ```env
   SUPABASE_AUTH_GITHUB_CLIENT_ID=your-oauth-client-id
   SUPABASE_AUTH_GITHUB_SECRET=your-oauth-client-secret
   ```
   Restart so the config takes effect:
   ```bash
   supabase stop && supabase start
   ```

## 4. Create a GitHub App (for "Apply as PR")

Separate from the OAuth App above — this one lets the app push AI optimization suggestions as a
pull request.

1. Go to [GitHub → Settings → Developer settings → GitHub Apps → New GitHub
   App](https://github.com/settings/apps/new).
2. Fill in:
   - **GitHub App name**: e.g. `workflow-metrics-bot-dev`
   - **Homepage URL**: `http://localhost:5173`
   - **Callback URL**: `http://localhost:5173/auth/github-app/callback`
   - **Webhook**: uncheck **Active** (not needed)
3. **Repository permissions**:
   - **Contents**: Read & Write
   - **Pull requests**: Read & Write
   - **Workflows**: Read & Write
   - **Actions**: Read
4. Create the app. On its settings page, note:
   - **App ID** → `GITHUB_APP_ID`
   - **App slug** from the URL (`github.com/apps/<slug>`) → `GITHUB_APP_SLUG`
5. Scroll to **Private keys** → **Generate a private key** (downloads a `.pem`). Collapse it to a
   single-line secret:
   ```bash
   awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' your-app.pem
   ```
   Use the output as `GITHUB_APP_PRIVATE_KEY`.

## 5. Configure `.env`

```bash
cp .env.example .env
```

Fill in with the **local** Supabase values from `supabase status` (step 2) and the GitHub App
values from step 4:

```env
PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
PUBLIC_SUPABASE_ANON_KEY=<ANON_KEY from supabase status>
SUPABASE_SERVICE_ROLE_KEY=<SERVICE_ROLE_KEY from supabase status>
REDIS_URL=redis://127.0.0.1:6379

GITHUB_APP_ID=<from step 4>
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_SLUG=<from step 4>
```

Leave `PUBLIC_APP_URL` commented out — local dev uses the request origin automatically.

## 6. Run the app

You have two options. Prefer option A unless you specifically need to run inside Docker.

### Option A — direct (simplest, no networking gotchas)

Start a loopback-only Redis 8 container and keep `REDIS_URL=redis://127.0.0.1:6379` in `.env`:

```bash
docker run -d --name workflow-metrics-redis \
  -p 127.0.0.1:6379:6379 \
  redis:8-alpine redis-server --maxmemory 384mb --maxmemory-policy allkeys-lru
```

```bash
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) and sign in with GitHub.
Stop the standalone Redis container later with `docker rm -f workflow-metrics-redis`.

### Option B — Docker Compose

For local Supabase, keep `PUBLIC_SUPABASE_URL=http://127.0.0.1:54321` for the browser and set
`SUPABASE_INTERNAL_URL=http://host.docker.internal:54321` for the app container. Hosted Supabase
URLs need no internal override.

```bash
CI_OBSERVE_IMAGE=workflow-metrics:local docker compose up -d --build
docker compose ps
```

Open [http://localhost:5173](http://localhost:5173).

**Why this needs an extra step:** the app runs inside a container, but local Supabase runs on your
host machine (accessible to containers as `host.docker.internal`, not `127.0.0.1` — inside a
container, `127.0.0.1` means the container itself).

## Troubleshooting

**`[TypeError: fetch failed] ... ECONNREFUSED 127.0.0.1:54321` in `docker compose` logs**
The container is trying to reach Supabase at `127.0.0.1`, which inside a container refers to
itself. Confirm `.env` keeps `PUBLIC_SUPABASE_URL=http://127.0.0.1:54321`, adds
`SUPABASE_INTERNAL_URL=http://host.docker.internal:54321`, and that `supabase status` shows
Supabase running.

**Sign-in redirects to GitHub but then fails / redirect_uri mismatch**
The OAuth App's callback URL must be your local Supabase's callback
(`http://127.0.0.1:54321/auth/v1/callback`), **not** `http://localhost:5173/...`. Only the GitHub
App (step 4) uses the `localhost:5173` callback.

**Migrations seem out of date after pulling latest `main`**

```bash
supabase stop
supabase start
```

`supabase start` re-applies all migrations under `supabase/migrations/` from scratch each time the
local stack is (re)created.

**Force a completely cold workflow-run import**

```bash
docker compose down -v
CI_OBSERVE_IMAGE=workflow-metrics:local docker compose up -d --build
```

This deletes the disposable Redis cache. Normal `docker compose down` keeps it, so restarting or
recreating the app does not require importing all workflow runs again.

## Verifying the setup works

1. `supabase status` shows `db`, `auth`, `rest`, `kong` healthy.
2. `pnpm dev` (or the local-image Compose command above) starts without fetch errors in the console.
3. Visiting `http://localhost:5173` and clicking "Sign in with GitHub" redirects to GitHub, then
   back to the app, landing on the dashboard.
4. Open [http://127.0.0.1:54323](http://127.0.0.1:54323) (Supabase Studio) and confirm a row
   appears in `github_connections` after sign-in.
