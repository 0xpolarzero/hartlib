alter table public_sources
  add column if not exists country text not null default 'FR',
  add column if not exists language text not null default 'fr-FR';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_sources_country_valid'
  ) then
    alter table public_sources
      add constraint public_sources_country_valid check (country in ('FR', 'US'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'public_sources_language_valid'
  ) then
    alter table public_sources
      add constraint public_sources_language_valid check (language in ('fr-FR', 'en-US'));
  end if;
end
$$;
