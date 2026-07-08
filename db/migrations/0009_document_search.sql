create extension if not exists pg_trgm;

create or replace function language_to_regconfig(lang text)
returns regconfig
language sql
immutable
parallel safe
returns null on null input
as $$
  select case lower(split_part(lang, '-', 1))
    when 'fr' then 'french'::regconfig
    when 'en' then 'english'::regconfig
    else 'simple'::regconfig
  end;
$$;

alter table public_source_documents
  add column if not exists search_vector tsvector generated always as (
    setweight(to_tsvector(language_to_regconfig(language), title), 'A') ||
    setweight(to_tsvector(language_to_regconfig(language), text), 'B')
  ) stored;

create index if not exists public_source_documents_search_vector_idx on public_source_documents using gin (search_vector);

create index if not exists public_source_documents_title_trgm_idx on public_source_documents using gin (title gin_trgm_ops);
