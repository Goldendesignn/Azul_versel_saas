-- Azul Gestao - eliminacao definitiva de uma conta cliente.
-- Executar no Supabase de teste e no Supabase de producao.

create or replace function public.admin_delete_client_account(
  p_organization_id uuid,
  p_confirmation text
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_organization record;
  v_user_ids uuid[];
  v_deletable_user_ids uuid[];
  v_table record;
  v_fk record;
  v_deleted_auth_users integer := 0;
  v_preserved_admin_users integer := 0;
begin
  if auth.uid() is null or public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if upper(trim(coalesce(p_confirmation, ''))) <> 'ELIMINAR' then
    raise exception 'CONFIRMATION_REQUIRED';
  end if;

  select o.id, o.name
    into v_organization
  from public.organizations o
  where o.id = p_organization_id
  for update;

  if v_organization.id is null then
    raise exception 'CLIENT_NOT_FOUND';
  end if;

  select array_agg(distinct user_source.user_id)
    into v_user_ids
  from (
    select p.auth_user_id as user_id
    from public.profiles p
    where p.organization_id = p_organization_id
      and p.auth_user_id is not null

    union

    select u.id
    from auth.users u
    where lower(coalesce(u.email, '')) in (
      select lower(p.email)
      from public.profiles p
      where p.organization_id = p_organization_id
        and nullif(trim(p.email), '') is not null

      union

      select lower(o.owner_email)
      from public.organizations o
      where o.id = p_organization_id
        and nullif(trim(o.owner_email), '') is not null
    )
  ) user_source
  where user_source.user_id is not null;

  select array_agg(user_id)
    into v_deletable_user_ids
  from unnest(coalesce(v_user_ids, array[]::uuid[])) as user_row(user_id)
  where not exists (
    select 1
    from public.admin_users au
    where au.user_id = user_id
      and coalesce(au.active, true) = true
  );

  select count(*)
    into v_preserved_admin_users
  from unnest(coalesce(v_user_ids, array[]::uuid[])) as user_row(user_id)
  where exists (
    select 1
    from public.admin_users au
    where au.user_id = user_id
      and coalesce(au.active, true) = true
  );

  -- Elimina primeiro tabelas filhas que referenciam tabelas da organizacao.
  for v_fk in
    select
      child_ns.nspname as child_schema,
      child.relname as child_table,
      child_col.attname as child_column,
      parent_ns.nspname as parent_schema,
      parent.relname as parent_table,
      parent_col.attname as parent_column
    from pg_constraint constraint_row
    join pg_class child on child.oid = constraint_row.conrelid
    join pg_namespace child_ns on child_ns.oid = child.relnamespace
    join pg_class parent on parent.oid = constraint_row.confrelid
    join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
    join pg_attribute child_col
      on child_col.attrelid = child.oid
     and child_col.attnum = constraint_row.conkey[1]
    join pg_attribute parent_col
      on parent_col.attrelid = parent.oid
     and parent_col.attnum = constraint_row.confkey[1]
    where constraint_row.contype = 'f'
      and array_length(constraint_row.conkey, 1) = 1
      and child_ns.nspname = 'public'
      and parent_ns.nspname = 'public'
      and exists (
        select 1
        from pg_attribute organization_column
        where organization_column.attrelid = parent.oid
          and organization_column.attname = 'organization_id'
          and organization_column.attnum > 0
          and not organization_column.attisdropped
      )
  loop
    execute format(
      'delete from %I.%I child_row using %I.%I parent_row
       where child_row.%I = parent_row.%I
         and parent_row.organization_id = $1',
      v_fk.child_schema,
      v_fk.child_table,
      v_fk.parent_schema,
      v_fk.parent_table,
      v_fk.child_column,
      v_fk.parent_column
    )
    using p_organization_id;
  end loop;

  -- Elimina todas as linhas publicas diretamente ligadas a organizacao.
  for v_table in
    select columns_row.table_schema, columns_row.table_name
    from information_schema.columns columns_row
    join information_schema.tables tables_row
      on tables_row.table_schema = columns_row.table_schema
     and tables_row.table_name = columns_row.table_name
     and tables_row.table_type = 'BASE TABLE'
    where columns_row.table_schema = 'public'
      and columns_row.column_name = 'organization_id'
      and columns_row.table_name <> 'organizations'
    group by columns_row.table_schema, columns_row.table_name
    order by columns_row.table_name
  loop
    execute format(
      'delete from %I.%I where organization_id = $1',
      v_table.table_schema,
      v_table.table_name
    )
    using p_organization_id;
  end loop;

  -- Remove perfis repetidos desses utilizadores noutras organizacoes.
  if coalesce(array_length(v_deletable_user_ids, 1), 0) > 0 then
    delete from public.profiles
    where auth_user_id = any(v_deletable_user_ids);
  end if;

  delete from public.organizations
  where id = p_organization_id;

  -- A eliminacao em auth.users remove identidades e sessoes associadas.
  if coalesce(array_length(v_deletable_user_ids, 1), 0) > 0 then
    delete from auth.users
    where id = any(v_deletable_user_ids);

    get diagnostics v_deleted_auth_users = row_count;
  end if;

  return jsonb_build_object(
    'deleted', true,
    'organization_id', p_organization_id,
    'organization_name', coalesce(v_organization.name, 'Cliente'),
    'deleted_auth_users', v_deleted_auth_users,
    'preserved_admin_users', v_preserved_admin_users
  );
end;
$$;

revoke all on function public.admin_delete_client_account(uuid, text) from public, anon;
grant execute on function public.admin_delete_client_account(uuid, text) to authenticated;
