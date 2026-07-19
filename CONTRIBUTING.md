# Contributing to Workflow Metrics

Thank you for your interest in contributing. Please read this guide before opening a pull request.

## How to contribute

1. **Fork** the repository by clicking the "Fork" button on GitHub.
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/workflow-metrics.git
   cd workflow-metrics
   ```
3. **Create a branch** for your change:
   ```bash
   git checkout -b feat/my-feature
   # or
   git checkout -b fix/my-bug
   ```
4. **Install dependencies** and set up the project (see [Setup](#setup) below).
5. **Make your changes**, following the [coding standards](#coding-standards).
6. **Test** your changes locally (see [Test](#test) below).
7. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```bash
   git commit -m "feat: add DORA metrics export to CSV"
   git commit -m "fix: resolve crash when repository has no workflow runs"
   ```
8. **Push** your branch to your fork:
   ```bash
   git push origin feat/my-feature
   ```
9. **Open a Pull Request** against the `main` branch of this repository. Fill in the PR template that appears automatically.

The CI pipeline will run lint, tests, and a build check on your PR. All checks must pass before the PR can be merged.

## Coding standards

- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages — this drives automated versioning and changelog generation.
- Write strict TypeScript; avoid `any`.
- Keep server-side logic (GitHub API, Supabase, AI calls) in `src/lib/server/`. Keep UI logic in `src/lib/components/` and route files. Do not mix them.
- Add or update tests for any logic change in `src/lib/server/` or `src/lib/utils.ts`.
- Maintain coverage thresholds: lines/functions/statements ≥ 80%, branches ≥ 70%.
- Update `README.md` if your change adds a feature or modifies existing behaviour.

## Prerequisites

- Node.js >= 24
- PNPM >= 10
- A [Supabase](https://supabase.com/) project (for auth and database)
- A GitHub OAuth App (for read-only GitHub login and repository data access)

## Setup

```bash
pnpm install
```

Copy the example environment file and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:

| Variable                    | Description                                                                 |
| --------------------------- | --------------------------------------------------------------------------- |
| `PUBLIC_SUPABASE_URL`       | Your Supabase project URL                                                   |
| `PUBLIC_SUPABASE_ANON_KEY`  | Your Supabase publishable (or legacy anon) key                              |
| `SUPABASE_SERVICE_ROLE_KEY` | Your Supabase secret (or legacy service-role) key; server-only              |
| `REDIS_URL`                 | Required Redis connection URL                                               |
| `SECRETS_ENCRYPTION_KEY`    | Base64url-encoded 32-byte credential-encryption key; server-only            |

Generate `SECRETS_ENCRYPTION_KEY` with Node's built-in crypto module, and keep the output only in
server-side secret storage:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Do not change or lose this key after credentials have been stored; it is required to decrypt them.
For the required `021` → script dry run → script → `022` migration sequence and hosted-database
caution, see [LOCAL_SETUP.md](LOCAL_SETUP.md#migrate-existing-credentials).

## Development

```bash
pnpm dev
```

The app will be available at `http://localhost:5173`.

## Build

```bash
pnpm build
```

## Test

```bash
pnpm test
pnpm lint
pnpm check
```

To run tests with coverage:

```bash
pnpm test:coverage
```

Coverage is enforced at: lines/functions/statements ≥ 80%, branches ≥ 70%.

## CI (Pull request checks)

On every pull request to `main`, GitHub Actions runs:

- **Check**: Svelte and TypeScript diagnostics
- **Lint**: ESLint (TypeScript + Svelte)
- **Test**: Vitest unit suite
- **Build**: SvelteKit build check

Workflow file: [.github/workflows/ci.yml](.github/workflows/ci.yml).

### Deployment

The application supports Vercel and the production Node container. Both runtimes use Supabase and
Redis with the same application environment variables; managed Redis endpoints must use TLS.
`CI_OBSERVE_IMAGE=workflow-metrics:local docker compose up -d --build` starts the self-hosted stack.

## Stack

- **Framework**: Svelte 5 + SvelteKit 2
- **Styling**: Tailwind CSS 4
- **UI Components**: [bits-ui](https://www.bits-ui.com/), [lucide-svelte](https://lucide.dev/), [layerchart](https://layerchart.com/)
- **Auth & Database**: [Supabase](https://supabase.com/) (GitHub OAuth + PostgreSQL)
- **GitHub API**: [@octokit/rest](https://github.com/octokit/rest.js)
- **AI**: [Vercel AI SDK](https://sdk.vercel.ai/) + [@ai-sdk/mistral](https://sdk.vercel.ai/providers/ai-sdk-providers/mistral)
- **Graph Visualization**: [@xyflow/svelte](https://svelteflow.dev/)
- **Deployment**: Vercel or Node 24 container, backed by Redis 8
- **Testing**: [Vitest 3](https://vitest.dev/) + v8 coverage
- **Linting**: ESLint 9 + `eslint-plugin-svelte` + `typescript-eslint`
- **Packaging**: PNPM 10
