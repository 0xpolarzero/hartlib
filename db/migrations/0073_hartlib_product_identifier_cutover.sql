-- Rename product-owned database identifiers for databases that passed the
-- earlier migrations before the Hartlib cutover.

do $$
declare
  old_table text;
  new_table text;
  table_name text;
  function_row record;
  relation_row record;
  constraint_row record;
  trigger_row record;
  new_name text;
  definition text;
begin
  for old_table, new_table in
    select *
    from (
      values
        ('brief_documents', 'hartlib_documents'),
        ('brief_document_versions', 'hartlib_document_versions'),
        ('brief_document_extractions', 'hartlib_document_extractions'),
        ('purged_brief_document_tombstones', 'purged_hartlib_document_tombstones')
    ) as rename_map(old_table, new_table)
  loop
    if to_regclass(format('public.%I', old_table)) is not null
      and to_regclass(format('public.%I', new_table)) is null
    then
      execute format('alter table public.%I rename to %I', old_table, new_table);
    end if;
  end loop;

  for table_name in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and a.attnum > 0
      and not a.attisdropped
      and a.attname = 'brief_document_id'
  loop
    execute format(
      'alter table public.%I rename column brief_document_id to hartlib_document_id',
      table_name
    );
  end loop;

  for function_row in
    select
      p.oid,
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid) as identity_arguments
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and p.proname like '%brief%'
    order by p.oid
  loop
    new_name := replace(function_row.proname, 'brief', 'hartlib');
    if not exists (
      select 1
      from pg_proc target
      where target.pronamespace = function_row.nspname::regnamespace
        and target.proname = new_name
        and pg_get_function_identity_arguments(target.oid) = function_row.identity_arguments
    ) then
      execute format(
        'alter function %I.%I(%s) rename to %I',
        function_row.nspname,
        function_row.proname,
        function_row.identity_arguments,
        new_name
      );
    end if;
  end loop;

  -- Some trigger functions have generic names, so the name-based rename above
  -- does not find them. Rewrite every public function body that still carries
  -- the old database namespace before the renamed tables receive writes.
  for function_row in
    select p.oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prokind = 'f'
      and position('brief' in pg_get_functiondef(p.oid)) > 0
  loop
    definition := pg_get_functiondef(function_row.oid);
    execute replace(definition, 'brief', 'hartlib');
  end loop;

  for relation_row in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'i'
      and c.relname like '%brief%'
  loop
    new_name := replace(relation_row.relname, 'brief', 'hartlib');
    if to_regclass(format('public.%I', new_name)) is null then
      execute format('alter index public.%I rename to %I', relation_row.relname, new_name);
    end if;
  end loop;

  for constraint_row in
    select c.oid, n.nspname, t.relname, c.conname
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and c.conname like '%brief%'
  loop
    new_name := replace(constraint_row.conname, 'brief', 'hartlib');
    if not exists (
      select 1
      from pg_constraint target
      where target.conrelid = format('%I.%I', constraint_row.nspname, constraint_row.relname)::regclass
        and target.conname = new_name
    ) then
      execute format(
        'alter table %I.%I rename constraint %I to %I',
        constraint_row.nspname,
        constraint_row.relname,
        constraint_row.conname,
        new_name
      );
    end if;
  end loop;

  for trigger_row in
    select tg.tgname, n.nspname, t.relname
    from pg_trigger tg
    join pg_class t on t.oid = tg.tgrelid
    join pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public'
      and not tg.tgisinternal
      and tg.tgname like '%brief%'
  loop
    new_name := replace(trigger_row.tgname, 'brief', 'hartlib');
    if not exists (
      select 1
      from pg_trigger target
      where target.tgrelid = format('%I.%I', trigger_row.nspname, trigger_row.relname)::regclass
        and target.tgname = new_name
    ) then
      execute format(
        'alter trigger %I on %I.%I rename to %I',
        trigger_row.tgname,
        trigger_row.nspname,
        trigger_row.relname,
        new_name
      );
    end if;
  end loop;
end
$$;

-- Existing Stripe operation keys are provider idempotency identities. Keep
-- retained pre-cutover rows unchanged while allowing new Hartlib keys.
do $$
begin
  if to_regclass('public.client_ai_checkout_requests') is not null then
    alter table public.client_ai_checkout_requests
      drop constraint if exists client_ai_checkout_requests_external_ids;
    alter table public.client_ai_checkout_requests
      add constraint client_ai_checkout_requests_external_ids check (
        length(stripe_customer_id) between 1 and 255
        and length(stripe_price_id) between 1 and 255
        and length(stripe_operation_key) between 1 and 255
        and stripe_operation_key ~ '^(brief|hartlib)-checkout:[A-Za-z0-9:_-]{1,230}:session$'
      );
  end if;
end
$$;
