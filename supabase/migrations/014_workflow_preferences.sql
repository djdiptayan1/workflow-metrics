-- Workflow preferences can be personal or shared by everyone tracking a GitHub repository.
create table if not exists repository_workflow_settings (
  github_repo_id bigint primary key,
  preferences_mode text not null default 'personal'
    check (preferences_mode in ('personal', 'shared')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists workflow_preferences (
  id uuid primary key default gen_random_uuid(),
  github_repo_id bigint not null,
  user_id uuid references auth.users(id) on delete cascade,
  workflow_id bigint not null,
  is_pinned boolean not null default false,
  environment text not null default 'unknown'
    check (environment in ('production', 'development', 'unknown')),
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (github_repo_id, user_id, workflow_id)
);

create index if not exists idx_workflow_preferences_repo on workflow_preferences(github_repo_id);
create index if not exists idx_workflow_preferences_user_repo on workflow_preferences(user_id, github_repo_id);

alter table repository_workflow_settings enable row level security;
alter table workflow_preferences enable row level security;

create policy "Tracked users can read repository workflow settings"
  on repository_workflow_settings for select
  using (exists (
    select 1 from repositories
    where repositories.github_repo_id = repository_workflow_settings.github_repo_id
      and repositories.user_id = auth.uid()
  ));

create policy "Tracked users can read workflow preferences"
  on workflow_preferences for select
  using (exists (
    select 1 from repositories
    where repositories.github_repo_id = workflow_preferences.github_repo_id
      and repositories.user_id = auth.uid()
  ));

comment on table repository_workflow_settings is 'Controls whether workflow preferences are personal or shared for a GitHub repository.';
comment on table workflow_preferences is 'Pins and environment classification for GitHub Actions workflows.';
