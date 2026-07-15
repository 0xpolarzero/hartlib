create table if not exists client_company_public_source_settings (
  client_company_id uuid not null references client_companies (id) on delete cascade,
  source_id text not null references public_sources (source_id) on delete cascade,
  enabled boolean not null default false,
  updated_by_user_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (client_company_id, source_id),
  constraint client_company_public_source_settings_actor_nonempty check (
    btrim(updated_by_user_id) <> ''
  )
);

create index if not exists client_company_public_source_settings_enabled_idx
  on client_company_public_source_settings (client_company_id, source_id)
  where enabled;
