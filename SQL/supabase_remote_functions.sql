-- Supabase remote public functions export
-- Project: gtgfdxdximyshlusgyit / Azul_Gestao
-- Generated: 2026-05-28T14:24:47.159Z
-- Contains function/procedure definitions only. No table data.

-- ============================================================
-- Function: public.activate_license(p_license_key text, p_store_name text, p_owner_name text, p_owner_phone text, p_owner_email text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.activate_license(p_license_key text, p_store_name text, p_owner_name text, p_owner_phone text, p_owner_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_license record;
  v_org record;
  v_license_status text;
  v_org_status text;
begin
  select *
  into v_license
  from public.licenses
  where upper(license_key) = upper(trim(p_license_key))
  limit 1;

  if v_license.id is null then
    raise exception 'LICENCA_INVALIDA';
  end if;

  v_license_status := lower(coalesce(v_license.status, ''));

  if v_license_status in (
    'inactive',
    'disabled',
    'desactive',
    'desativada',
    'suspended',
    'blocked',
    'cancelled',
    'canceled',
    'expired'
  ) then
    raise exception 'LICENCA_INATIVA';
  end if;

  if v_license.expires_at is not null and v_license.expires_at < now() then
    raise exception 'LICENCA_EXPIRADA';
  end if;

  select *
  into v_org
  from public.organizations
  where id = v_license.organization_id
  limit 1;

  if v_org.id is null then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  v_org_status := lower(coalesce(v_org.status, ''));

  if v_org_status in (
    'inactive',
    'disabled',
    'desactive',
    'desativada',
    'suspended',
    'blocked',
    'cancelled',
    'canceled'
  ) then
    raise exception 'LICENCA_INATIVA';
  end if;

  update public.organizations
  set
    status = 'active',
    name = coalesce(nullif(trim(p_store_name), ''), nullif(trim(p_owner_name), ''), name),
    owner_name = coalesce(nullif(trim(p_owner_name), ''), owner_name),
    owner_phone = coalesce(nullif(trim(p_owner_phone), ''), owner_phone),
    owner_email = lower(coalesce(nullif(trim(p_owner_email), ''), owner_email))
  where id = v_org.id;

  update public.licenses
  set
    status = 'used',
    activation_count = greatest(coalesce(activation_count, 0), 1)
  where id = v_license.id;

  select *
  into v_org
  from public.organizations
  where id = v_license.organization_id
  limit 1;

  return jsonb_build_object(
    'id', v_org.id,
    'name', coalesce(v_org.name, v_org.owner_name, 'Azul Gestao'),
    'status', v_org.status,
    'plan', coalesce(v_org.plan, 'starter'),
    'license_key', v_license.license_key,
    'device_limit', coalesce(v_org.device_limit, 1)
  );
end;
$function$;

-- ============================================================
-- Function: public.admin_create_license(p_expires_at timestamp with time zone, p_notes text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_license(p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  new_org public.organizations;
  new_license public.licenses;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  insert into public.organizations (
    name, status, plan, expires_at, notes
  )
  values (
    'Licence en attente', 'pending', 'starter', p_expires_at, p_notes
  )
  returning * into new_org;

  insert into public.licenses (
    organization_id, license_key, status, plan,
    expires_at, activation_limit, activation_count, notes
  )
  values (
    new_org.id, public.generate_license_key(), 'unused', 'starter',
    p_expires_at, 1, 0, p_notes
  )
  returning * into new_license;

  return new_license;
end;
$function$;

-- ============================================================
-- Function: public.admin_create_renewal_license(p_organization_id uuid, p_expires_at timestamp with time zone, p_notes text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_create_renewal_license(p_organization_id uuid, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_notes text DEFAULT NULL::text)
 RETURNS licenses
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  new_license public.licenses;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  insert into public.licenses (
    organization_id, license_key, status, plan,
    expires_at, activation_limit, activation_count, notes
  )
  values (
    p_organization_id, public.generate_license_key(), 'unused', 'starter',
    p_expires_at, 1, 0, p_notes
  )
  returning * into new_license;

  return new_license;
end;
$function$;

-- ============================================================
-- Function: public.admin_list_clients()
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_clients()
 RETURNS TABLE(id uuid, name text, phone text, email text, status text, plan text, created_at timestamp with time zone, expires_at timestamp with time zone, current_license_key text, current_license_status text, activation_count integer, activation_limit integer, active_devices integer, device_limit integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED';
  end if;

  return query
  select
    o.id,
    coalesce(o.name, o.owner_name, 'Cliente')::text,
    o.owner_phone::text,
    o.owner_email::text,
    o.status::text,
    coalesce(o.plan, 'starter')::text,
    o.created_at,
    l.expires_at,
    l.license_key::text,
    l.status::text,
    coalesce(l.activation_count, 0)::integer,
    coalesce(l.activation_limit, 1)::integer,
    coalesce(d.active_devices, 0)::integer,
    coalesce(o.device_limit, 1)::integer
  from public.organizations o
  left join lateral (
    select li.*
    from public.licenses li
    where li.organization_id = o.id
    order by li.created_at desc
    limit 1
  ) l on true
  left join lateral (
    select count(*)::integer as active_devices
    from public.organization_devices od
    where od.organization_id = o.id
      and od.active = true
  ) d on true
  order by o.created_at desc;
end;
$function$;

-- ============================================================
-- Function: public.admin_list_devices(p_organization_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_list_devices(p_organization_id uuid)
 RETURNS TABLE(organization_id uuid, device_id text, device_name text, active boolean, first_login_at timestamp with time zone, last_seen_at timestamp with time zone, last_seen_label text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  return query
  select
    od.organization_id,
    od.device_id::text,
    coalesce(od.device_name, 'Appareil')::text,
    coalesce(od.active, false),
    od.created_at,
    od.last_seen_at,
    case
      when od.last_seen_at is null then 'Jamais ouvert'
      when od.last_seen_at >= now() - interval '5 minutes' then 'En ligne maintenant'
      when od.last_seen_at >= now() - interval '1 hour' then 'Vu il y a ' || floor(extract(epoch from (now() - od.last_seen_at)) / 60)::int || ' min'
      when od.last_seen_at >= now() - interval '24 hours' then 'Vu il y a ' || floor(extract(epoch from (now() - od.last_seen_at)) / 3600)::int || ' h'
      else 'Vu le ' || to_char(od.last_seen_at, 'DD/MM/YYYY HH24:MI')
    end::text
  from public.organization_devices od
  where od.organization_id = p_organization_id
  order by coalesce(od.last_seen_at, od.created_at) desc;
end;
$function$;

-- ============================================================
-- Function: public.admin_set_device_limit(p_organization_id uuid, p_device_limit integer)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_device_limit(p_organization_id uuid, p_device_limit integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.is_admin() is not true then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if p_device_limit is null or p_device_limit < 1 then
    raise exception 'DEVICE_LIMIT_INVALID';
  end if;

  update public.organizations
  set device_limit = p_device_limit
  where id = p_organization_id;
end;
$function$;

-- ============================================================
-- Function: public.admin_set_organization_status(p_organization_id uuid, p_status text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.admin_set_organization_status(p_organization_id uuid, p_status text)
 RETURNS organizations
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  org public.organizations;
begin
  if not public.is_admin() then
    raise exception 'ADMIN_REQUIRED';
  end if;

  if p_status not in ('active', 'suspended', 'inactive', 'pending') then
    raise exception 'INVALID_STATUS';
  end if;

  update public.organizations
  set status = p_status
  where id = p_organization_id
  returning * into org;

  if org.id is null then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  return org;
end;
$function$;

-- ============================================================
-- Function: public.check_license_status(p_organization_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.check_license_status(p_organization_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org record;
  v_license record;
begin
  select *
  into v_org
  from public.organizations
  where id = p_organization_id
  limit 1;

  if v_org.id is null then
    raise exception 'ORGANIZATION_NOT_FOUND';
  end if;

  if coalesce(v_org.status, '') <> 'active' then
    raise exception 'LICENCA_INATIVA';
  end if;

  select *
  into v_license
  from public.licenses
  where organization_id = p_organization_id
    and status in ('active', 'used')
  order by created_at desc
  limit 1;

  if v_license.id is null then
    raise exception 'LICENCA_INATIVA';
  end if;

  if v_license.expires_at is not null and v_license.expires_at < now() then
    raise exception 'LICENCA_EXPIRADA';
  end if;

  return jsonb_build_object(
    'id', v_org.id,
    'name', coalesce(v_org.name, v_org.owner_name, 'Azul Gestao'),
    'status', v_org.status,
    'plan', coalesce(v_org.plan, 'starter'),
    'license_key', v_license.license_key,
    'device_limit', coalesce(v_org.device_limit, 1)
  );
end;
$function$;

-- ============================================================
-- Function: public.complete_owner_profile(p_organization_id uuid, p_name text, p_phone text, p_email text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.complete_owner_profile(p_organization_id uuid, p_name text, p_phone text, p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user_id uuid;
  v_profile record;
begin
  v_user_id := auth.uid();

  if v_user_id is null then
    select id
    into v_user_id
    from auth.users
    where lower(email) = lower(trim(p_email))
    order by created_at desc
    limit 1;
  end if;

  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  select *
  into v_profile
  from public.profiles
  where auth_user_id = v_user_id
  limit 1;

  if v_profile.id is null then
    insert into public.profiles (
      auth_user_id,
      organization_id,
      name,
      phone,
      email,
      role,
      status
    )
    values (
      v_user_id,
      p_organization_id,
      coalesce(nullif(trim(p_name), ''), 'Cliente'),
      nullif(trim(p_phone), ''),
      lower(nullif(trim(p_email), '')),
      'owner',
      'active'
    )
    returning * into v_profile;
  else
    update public.profiles
    set
      organization_id = p_organization_id,
      name = coalesce(nullif(trim(p_name), ''), 'Cliente'),
      phone = nullif(trim(p_phone), ''),
      email = lower(nullif(trim(p_email), '')),
      role = 'owner',
      status = 'active'
    where id = v_profile.id
    returning * into v_profile;
  end if;

  return jsonb_build_object(
    'id', v_profile.id,
    'auth_user_id', v_profile.auth_user_id,
    'organization_id', v_profile.organization_id,
    'name', v_profile.name,
    'phone', v_profile.phone,
    'email', v_profile.email,
    'role', v_profile.role,
    'status', v_profile.status
  );
end;
$function$;

-- ============================================================
-- Function: public.create_accounting_entry_for_org(p_organization_id uuid, p_source_type text, p_source_id uuid, p_entry_date date, p_description text, p_lines jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_accounting_entry_for_org(p_organization_id uuid, p_source_type text, p_source_id uuid, p_entry_date date, p_description text, p_lines jsonb)
 RETURNS accounting_entries
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_entry public.accounting_entries;
  v_line jsonb;
  v_total_debit numeric := 0;
  v_total_credit numeric := 0;
begin
  if p_organization_id is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;

  select
    coalesce(sum(coalesce(nullif(line->>'debit', '')::numeric, 0)), 0),
    coalesce(sum(coalesce(nullif(line->>'credit', '')::numeric, 0)), 0)
  into v_total_debit, v_total_credit
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;

  if round(v_total_debit) <> round(v_total_credit) then
    raise exception 'ACCOUNTING_NOT_BALANCED debit % credit %', v_total_debit, v_total_credit;
  end if;

  select *
  into v_entry
  from public.accounting_entries
  where organization_id = p_organization_id
    and source_type = p_source_type
    and source_id = p_source_id
  limit 1;

  if v_entry.id is not null then
    return v_entry;
  end if;

  insert into public.accounting_entries (
    organization_id,
    source_type,
    source_id,
    entry_date,
    description
  )
  values (
    p_organization_id,
    p_source_type,
    p_source_id,
    coalesce(p_entry_date, current_date),
    coalesce(p_description, '')
  )
  returning * into v_entry;

  for v_line in
    select * from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb))
  loop
    insert into public.accounting_lines (
      organization_id,
      entry_id,
      account_code,
      account_name,
      debit,
      credit
    )
    values (
      p_organization_id,
      v_entry.id,
      coalesce(v_line->>'account_code', ''),
      coalesce(v_line->>'account_name', ''),
      coalesce(nullif(v_line->>'debit', '')::numeric, 0),
      coalesce(nullif(v_line->>'credit', '')::numeric, 0)
    );
  end loop;

  return v_entry;
end;
$function$;

-- ============================================================
-- Function: public.create_purchase_for_org(p_organization_id uuid, p_supplier text, p_total numeric, p_paid_amount numeric, p_remaining_amount numeric, p_is_credit boolean, p_created_at timestamp with time zone, p_items jsonb)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_purchase_for_org(p_organization_id uuid, p_supplier text, p_total numeric, p_paid_amount numeric, p_remaining_amount numeric, p_is_credit boolean, p_created_at timestamp with time zone, p_items jsonb)
 RETURNS purchases
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_purchase public.purchases;
  v_item jsonb;
begin
  if p_organization_id is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;

  insert into public.purchases (
    organization_id,
    supplier,
    total,
    paid_amount,
    remaining_amount,
    is_credit,
    created_at
  )
  values (
    p_organization_id,
    trim(p_supplier),
    coalesce(p_total, 0),
    coalesce(p_paid_amount, 0),
    coalesce(p_remaining_amount, 0),
    coalesce(p_is_credit, false),
    coalesce(p_created_at, now())
  )
  returning * into v_purchase;

  for v_item in
    select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    insert into public.purchase_items (
      purchase_id,
      product_id,
      product_name,
      category,
      code,
      photo,
      variation,
      variations,
      purchase_price,
      sale_price,
      quantity,
      supplier
    )
    values (
      v_purchase.id,
      nullif(v_item->>'product_id', '')::uuid,
      coalesce(v_item->>'product_name', ''),
      coalesce(v_item->>'category', ''),
      coalesce(v_item->>'code', ''),
      coalesce(v_item->>'photo', ''),
      coalesce(v_item->>'variation', ''),
      coalesce(v_item->'variations', '[]'::jsonb),
      coalesce(nullif(v_item->>'purchase_price', '')::numeric, 0),
      coalesce(nullif(v_item->>'sale_price', '')::numeric, 0),
      coalesce(nullif(v_item->>'quantity', '')::integer, 0),
      coalesce(v_item->>'supplier', p_supplier)
    );
  end loop;

  return v_purchase;
end;
$function$;

-- ============================================================
-- Function: public.delete_team_member(p_organization_id uuid, p_email text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.delete_team_member(p_organization_id uuid, p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_role text;
  v_target_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_active_owner_count integer;
begin
  if p_organization_id is null or v_email = '' then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.status, ''), 'active') = 'active'
    and (
      p.auth_user_id = auth.uid()
      or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_target_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_target_role is null then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_target_role = 'owner' then
    select count(*)
      into v_active_owner_count
    from public.profiles p
    where p.organization_id = p_organization_id
      and lower(p.email) <> v_email
      and coalesce(nullif(p.role, ''), 'member') = 'owner'
      and coalesce(nullif(p.status, ''), 'active') = 'active';

    if coalesce(v_active_owner_count, 0) < 1 then
      raise exception 'LAST_OWNER_REQUIRED';
    end if;
  end if;

  delete from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email;
end;
$function$;

-- ============================================================
-- Function: public.generate_license_key()
-- ============================================================
CREATE OR REPLACE FUNCTION public.generate_license_key()
 RETURNS text
 LANGUAGE plpgsql
AS $function$
declare
  new_key text;
begin
  loop
    new_key :=
      'AZUL-' ||
      upper(substr(md5(random()::text), 1, 4)) || '-' ||
      upper(substr(md5(random()::text), 1, 4)) || '-' ||
      upper(substr(md5(random()::text), 1, 4));

    exit when not exists (
      select 1 from public.licenses where license_key = new_key
    );
  end loop;

  return new_key;
end;
$function$;

-- ============================================================
-- Function: public.get_login_profile(p_identifier text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_login_profile(p_identifier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_identifier text;
  v_phone text;
  v_profile record;
begin
  v_identifier := lower(trim(p_identifier));
  v_phone := regexp_replace(v_identifier, '[^0-9]', '', 'g');

  select p.*
  into v_profile
  from public.profiles p
  join public.organizations o on o.id = p.organization_id
  where p.status = 'active'
    and o.status = 'active'
    and (
      lower(coalesce(p.email, '')) = v_identifier
      or regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') = v_phone
    )
  order by p.created_at desc
  limit 1;

  if v_profile.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_profile.id,
    'auth_user_id', v_profile.auth_user_id,
    'organization_id', v_profile.organization_id,
    'name', v_profile.name,
    'phone', v_profile.phone,
    'email', v_profile.email,
    'role', v_profile.role,
    'status', v_profile.status
  );
end;
$function$;

-- ============================================================
-- Function: public.get_login_profile_for_org(p_organization_id uuid, p_identifier text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_login_profile_for_org(p_organization_id uuid, p_identifier text)
 RETURNS TABLE(organization_id uuid, name text, email text, phone text, role text, status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.organization_id,
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'pending') as status
  from public.profiles p
  where p.organization_id = p_organization_id
    and (
      lower(p.email) = lower(trim(coalesce(p_identifier, '')))
      or (
        regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g') <> ''
        and regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') =
            regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g')
      )
    )
  limit 1;
$function$;

-- ============================================================
-- Function: public.get_login_profile_v2(p_identifier text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_login_profile_v2(p_identifier text)
 RETURNS TABLE(organization_id uuid, name text, email text, phone text, role text, status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.organization_id,
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'pending') as status
  from public.profiles p
  where lower(p.email) = lower(trim(coalesce(p_identifier, '')))
    or (
      regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g') <> ''
      and regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') =
          regexp_replace(coalesce(p_identifier, ''), '[^0-9]', '', 'g')
    )
  order by
    case coalesce(nullif(p.status, ''), 'pending')
      when 'active' then 1
      when 'pending' then 2
      else 3
    end,
    p.last_seen_at desc nulls last
  limit 1;
$function$;

-- ============================================================
-- Function: public.get_organization_team(p_organization_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_organization_team(p_organization_id uuid)
 RETURNS TABLE(name text, email text, phone text, role text, status text, last_seen_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    p.name,
    p.email,
    p.phone,
    coalesce(nullif(p.role, ''), 'member') as role,
    coalesce(nullif(p.status, ''), 'active') as status,
    p.last_seen_at
  from public.profiles p
  where p.organization_id = p_organization_id
    and exists (
      select 1
      from public.profiles me
      where me.organization_id = p_organization_id
        and coalesce(nullif(me.status, ''), 'active') = 'active'
        and (
          me.auth_user_id = auth.uid()
          or lower(me.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
        )
    )
  order by
    case coalesce(nullif(p.status, ''), 'active')
      when 'active' then 1
      else 2
    end,
    case coalesce(nullif(p.role, ''), 'member')
      when 'owner' then 1
      when 'manager' then 2
      when 'cashier' then 3
      when 'stock' then 4
      when 'accountant' then 5
      else 9
    end,
    lower(coalesce(p.name, p.email, ''));
$function$;

-- ============================================================
-- Function: public.get_role_catalog(p_organization_id uuid)
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_role_catalog(p_organization_id uuid)
 RETURNS TABLE(code text, name text, description text, is_system boolean, permissions text[])
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select
    rd.code,
    rd.name,
    rd.description,
    rd.is_system,
    coalesce(
      array_agg(distinct rp.permission) filter (where rp.permission is not null),
      array[]::text[]
    ) as permissions
  from public.role_definitions rd
  left join public.role_permissions rp
    on lower(rp.role_code) = lower(rd.code)
   and (
     rp.organization_id is null
     or rp.organization_id = p_organization_id
   )
  where rd.organization_id is null
     or rd.organization_id = p_organization_id
  group by rd.code, rd.name, rd.description, rd.is_system
  order by rd.is_system desc, rd.name asc;
$function$;

-- ============================================================
-- Function: public.is_admin()
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'auth'
AS $function$
declare
  v_uid uuid;
  v_email text;
begin
  v_uid := auth.uid();

  if v_uid is null then
    return false;
  end if;

  select email
  into v_email
  from auth.users
  where id = v_uid
  limit 1;

  return exists (
    select 1
    from public.admin_users au
    where au.active = true
      and (
        au.user_id = v_uid
        or lower(coalesce(au.email, '')) = lower(coalesce(v_email, ''))
        or lower(coalesce(au.email, '')) = lower(coalesce(auth.jwt() ->> 'email', ''))
      )
  );
end;
$function$;

-- ============================================================
-- Function: public.register_device_access(p_organization_id uuid, p_device_id text, p_device_name text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_device_access(p_organization_id uuid, p_device_id text, p_device_name text DEFAULT NULL::text)
 RETURNS TABLE(allowed boolean, message text, active_devices integer, device_limit integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_org record;
  v_license record;
  v_count integer;
  v_limit integer;
begin
  select *
  into v_org
  from public.organizations
  where id = p_organization_id
  limit 1;

  if v_org.id is null then
    return query select false, 'ORGANIZATION_NOT_FOUND', 0, 0;
    return;
  end if;

  if coalesce(v_org.status, '') <> 'active' then
    return query select false, 'LICENCA_INATIVA', 0, coalesce(v_org.device_limit, 1);
    return;
  end if;

  select *
  into v_license
  from public.licenses
  where organization_id = p_organization_id
    and status in ('active', 'used')
  order by created_at desc
  limit 1;

  if v_license.id is null then
    return query select false, 'LICENCA_INATIVA', 0, coalesce(v_org.device_limit, 1);
    return;
  end if;

  if v_license.expires_at is not null and v_license.expires_at < now() then
    return query select false, 'LICENCA_EXPIRADA', 0, coalesce(v_org.device_limit, 1);
    return;
  end if;

  v_limit := greatest(coalesce(v_org.device_limit, 1), 1);

  if exists (
    select 1
    from public.organization_devices
    where organization_id = p_organization_id
      and device_id = p_device_id
      and active = true
  ) then
    update public.organization_devices
    set
      last_seen_at = now(),
      device_name = coalesce(nullif(trim(p_device_name), ''), device_name)
    where organization_id = p_organization_id
      and device_id = p_device_id;

    select count(*)
    into v_count
    from public.organization_devices
    where organization_id = p_organization_id
      and active = true;

    return query select true, 'OK', v_count, v_limit;
    return;
  end if;

  select count(*)
  into v_count
  from public.organization_devices
  where organization_id = p_organization_id
    and active = true;

  if v_count >= v_limit then
    return query select false, 'DEVICE_LIMIT_REACHED', v_count, v_limit;
    return;
  end if;

  insert into public.organization_devices (
    organization_id,
    device_id,
    device_name,
    active,
    created_at,
    last_seen_at
  )
  values (
    p_organization_id,
    p_device_id,
    coalesce(nullif(trim(p_device_name), ''), 'Aparelho'),
    true,
    now(),
    now()
  )
  on conflict (organization_id, device_id)
  do update set
    active = true,
    device_name = excluded.device_name,
    last_seen_at = now();

  select count(*)
  into v_count
  from public.organization_devices
  where organization_id = p_organization_id
    and active = true;

  return query select true, 'OK', v_count, v_limit;
end;
$function$;

-- ============================================================
-- Function: public.validate_license_registration(p_license_key text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.validate_license_registration(p_license_key text)
 RETURNS TABLE(organization_id uuid, organization_name text, license_key text, plan text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_license record;
begin
  select
    l.organization_id,
    l.license_key,
    l.plan,
    l.expires_at,
    o.name as organization_name,
    o.status as organization_status
  into v_license
  from public.licenses l
  join public.organizations o on o.id = l.organization_id
  where upper(l.license_key) = upper(trim(coalesce(p_license_key, '')))
  limit 1;

  if v_license.organization_id is null then
    raise exception 'LICENCA_INVALIDA';
  end if;

  if v_license.expires_at is not null and v_license.expires_at < now() then
    raise exception 'LICENCA_EXPIRADA';
  end if;

  if coalesce(v_license.organization_status, 'pending') in ('suspended', 'blocked', 'inactive') then
    raise exception 'LICENCA_INATIVA';
  end if;

  return query
  select
    v_license.organization_id,
    v_license.organization_name::text,
    v_license.license_key::text,
    coalesce(v_license.plan, 'starter')::text;
end;
$function$;

REVOKE ALL ON FUNCTION public.validate_license_registration(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_license_registration(text) TO anon, authenticated;

-- ============================================================
-- Function: public.register_license_access(p_license_key text, p_store_name text, p_name text, p_phone text, p_email text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.register_license_access(p_license_key text, p_store_name text, p_name text, p_phone text, p_email text)
 RETURNS TABLE(organization_id uuid, organization_name text, license_key text, plan text, role text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_license record;
  v_auth_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_email text := lower(trim(coalesce(p_email, '')));
  v_owner_count integer := 0;
  v_existing record;
  v_role text;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if trim(coalesce(p_license_key, '')) = '' or v_email = '' then
    raise exception 'LICENCA_INVALIDA';
  end if;

  if v_auth_email = '' or v_auth_email <> v_email then
    raise exception 'AUTH_EMAIL_MISMATCH';
  end if;

  select
    l.id as license_id,
    l.organization_id,
    l.license_key,
    l.status as license_status,
    l.plan,
    l.expires_at,
    o.name as organization_name,
    o.status as organization_status
  into v_license
  from public.licenses l
  join public.organizations o on o.id = l.organization_id
  where upper(l.license_key) = upper(trim(p_license_key))
  limit 1;

  if v_license.organization_id is null then
    raise exception 'LICENCA_INVALIDA';
  end if;

  if v_license.expires_at is not null and v_license.expires_at < now() then
    raise exception 'LICENCA_EXPIRADA';
  end if;

  if coalesce(v_license.organization_status, 'pending') in ('suspended', 'blocked', 'inactive') then
    raise exception 'LICENCA_INATIVA';
  end if;

  select count(*)
    into v_owner_count
  from public.profiles p
  where p.organization_id = v_license.organization_id
    and coalesce(nullif(p.role, ''), 'member') = 'owner'
    and coalesce(nullif(p.status, ''), 'pending') = 'active';

  select *
    into v_existing
  from public.profiles p
  where p.organization_id = v_license.organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_owner_count = 0 then
    v_role := 'owner';
    v_status := 'active';
  else
    v_role := coalesce(nullif(v_existing.role, ''), 'member');
    v_status := coalesce(nullif(v_existing.status, ''), 'pending');

    if v_existing.email is null then
      v_role := 'member';
      v_status := 'pending';
    end if;
  end if;

  if v_role = 'owner' and v_status = 'active' then
    update public.organizations
    set
      name = coalesce(nullif(p_store_name, ''), name),
      status = 'active',
      owner_name = coalesce(nullif(p_name, ''), owner_name),
      owner_phone = coalesce(nullif(p_phone, ''), owner_phone),
      owner_email = v_email
    where id = v_license.organization_id;

    update public.licenses
    set status = 'used',
        used_at = coalesce(used_at, now()),
        activation_count = greatest(coalesce(activation_count, 0), 1)
    where id = v_license.license_id;
  end if;

  if v_existing.email is null then
    insert into public.profiles (
      auth_user_id,
      organization_id,
      name,
      phone,
      email,
      role,
      status,
      last_seen_at
    )
    values (
      auth.uid(),
      v_license.organization_id,
      coalesce(nullif(p_name, ''), v_email),
      coalesce(nullif(p_phone, ''), ''),
      v_email,
      v_role,
      v_status,
      now()
    );
  else
    update public.profiles
    set
      auth_user_id = coalesce(auth_user_id, auth.uid()),
      name = coalesce(nullif(p_name, ''), name, v_email),
      phone = coalesce(nullif(p_phone, ''), phone, ''),
      role = v_role,
      status = v_status,
      last_seen_at = now()
    where organization_id = v_license.organization_id
      and lower(email) = v_email;
  end if;

  return query
  select
    v_license.organization_id,
    coalesce(nullif(p_store_name, ''), v_license.organization_name),
    v_license.license_key,
    coalesce(v_license.plan, 'starter'),
    v_role,
    v_status;
end;
$function$;

REVOKE ALL ON FUNCTION public.register_license_access(text, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.register_license_access(text, text, text, text, text) TO authenticated;

-- ============================================================
-- Function: public.rls_auto_enable()
-- ============================================================
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

-- ============================================================
-- Function: public.touch_team_user(p_organization_id uuid, p_name text, p_phone text, p_email text, p_role text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.touch_team_user(p_organization_id uuid, p_name text, p_phone text, p_email text, p_role text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(coalesce(nullif(p_email, ''), auth.jwt() ->> 'email', ''));
begin
  if p_organization_id is null or v_email is null or trim(v_email) = '' then
    return;
  end if;

  update public.profiles
  set
    auth_user_id = coalesce(auth_user_id, auth.uid()),
    name = coalesce(nullif(p_name, ''), name, email),
    phone = coalesce(nullif(p_phone, ''), phone, ''),
    last_seen_at = now()
  where organization_id = p_organization_id
    and lower(email) = v_email
    and coalesce(nullif(status, ''), 'pending') = 'active';
end;
$function$;

-- ============================================================
-- Function: public.trigger_send_push_notification()
-- ============================================================
CREATE OR REPLACE FUNCTION public.trigger_send_push_notification()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  edge_url text;
  edge_secret text;
begin
  select ps.edge_url, ps.edge_secret
  into edge_url, edge_secret
  from public.push_settings ps
  where ps.id = true;

  if coalesce(edge_url, '') = '' then
    return new;
  end if;

  perform net.http_post(
    url := edge_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce(edge_secret, '')
    ),
    body := jsonb_build_object(
      'notification_id', new.id,
      'record', to_jsonb(new)
    ),
    timeout_milliseconds := 2000
  );

  return new;
end;
$function$;

-- ============================================================
-- Function: public.update_team_member_role_status(p_organization_id uuid, p_email text, p_role text, p_status text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_team_member_role_status(p_organization_id uuid, p_email text, p_role text, p_status text)
 RETURNS TABLE(email text, role text, status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_role text;
  v_target_role text;
  v_email text := lower(trim(coalesce(p_email, '')));
  v_role text := lower(trim(coalesce(p_role, 'member')));
  v_status text := lower(trim(coalesce(p_status, 'active')));
  v_active_owner_count integer;
  v_role_exists boolean;
begin
  if p_organization_id is null or v_email = '' then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  select exists (
    select 1
    from public.role_definitions rd
    where lower(rd.code) = v_role
      and (rd.organization_id is null or rd.organization_id = p_organization_id)
  ) into v_role_exists;

  if not coalesce(v_role_exists, false) then
    raise exception 'INVALID_ROLE';
  end if;

  if v_status not in ('active', 'pending', 'inactive', 'suspended', 'blocked') then
    raise exception 'INVALID_STATUS';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.status, ''), 'active') = 'active'
    and (
      p.auth_user_id = auth.uid()
      or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_target_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;

  if v_target_role is null then
    raise exception 'TEAM_MEMBER_NOT_FOUND';
  end if;

  if v_target_role = 'owner' and (v_role <> 'owner' or v_status <> 'active') then
    select count(*)
      into v_active_owner_count
    from public.profiles p
    where p.organization_id = p_organization_id
      and lower(p.email) <> v_email
      and coalesce(nullif(p.role, ''), 'member') = 'owner'
      and coalesce(nullif(p.status, ''), 'active') = 'active';

    if coalesce(v_active_owner_count, 0) < 1 then
      raise exception 'LAST_OWNER_REQUIRED';
    end if;
  end if;

  update public.profiles p
  set
    role = v_role,
    status = v_status,
    last_seen_at = coalesce(p.last_seen_at, now())
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email;

  return query
  select p.email, p.role, p.status
  from public.profiles p
  where p.organization_id = p_organization_id
    and lower(p.email) = v_email
  limit 1;
end;
$function$;

-- ============================================================
-- Function: public.upsert_custom_role(p_organization_id uuid, p_code text, p_name text, p_permissions text[])
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_custom_role(p_organization_id uuid, p_code text, p_name text, p_permissions text[])
 RETURNS TABLE(code text, name text, permissions text[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_role text;
  v_code text := lower(regexp_replace(trim(coalesce(p_code, '')), '[^a-z0-9_]+', '_', 'g'));
begin
  if p_organization_id is null or v_code = '' or trim(coalesce(p_name, '')) = '' then
    raise exception 'INVALID_ROLE';
  end if;

  if v_code in ('owner', 'manager', 'cashier', 'stock', 'accountant', 'readonly', 'member') then
    raise exception 'SYSTEM_ROLE_LOCKED';
  end if;

  select coalesce(nullif(p.role, ''), 'member')
    into v_actor_role
  from public.profiles p
  where p.organization_id = p_organization_id
    and coalesce(nullif(p.status, ''), 'active') = 'active'
    and (
      p.auth_user_id = auth.uid()
      or lower(p.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  limit 1;

  if v_actor_role <> 'owner' then
    raise exception 'TEAM_PERMISSION_DENIED';
  end if;

  update public.role_definitions
  set
    name = trim(p_name),
    description = 'Role personalizado',
    is_system = false
  where organization_id = p_organization_id
    and lower(code) = v_code;

  if not found then
    insert into public.role_definitions (organization_id, code, name, description, is_system)
    values (p_organization_id, v_code, trim(p_name), 'Role personalizado', false);
  end if;

  delete from public.role_permissions
  where organization_id = p_organization_id
    and lower(role_code) = v_code;

  insert into public.role_permissions (organization_id, role_code, permission)
  select p_organization_id, v_code, distinct_permission
  from (
    select distinct unnest(coalesce(p_permissions, array[]::text[])) as distinct_permission
  ) p
  where trim(coalesce(distinct_permission, '')) <> '';

  return query
  select v_code, trim(p_name), coalesce(p_permissions, array[]::text[]);
end;
$function$;

-- ============================================================
-- Function: public.upsert_supplier_for_org(p_organization_id uuid, p_name text, p_phone text, p_country text, p_note text)
-- ============================================================
CREATE OR REPLACE FUNCTION public.upsert_supplier_for_org(p_organization_id uuid, p_name text, p_phone text DEFAULT ''::text, p_country text DEFAULT ''::text, p_note text DEFAULT ''::text)
 RETURNS suppliers
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_supplier public.suppliers;
begin
  if p_organization_id is null then
    raise exception 'ORGANIZATION_REQUIRED';
  end if;

  if nullif(trim(p_name), '') is null then
    raise exception 'SUPPLIER_NAME_REQUIRED';
  end if;

  select *
  into v_supplier
  from public.suppliers
  where organization_id = p_organization_id
    and lower(name) = lower(trim(p_name))
  order by created_at desc
  limit 1;

  if v_supplier.id is not null then
    update public.suppliers
    set
      phone = coalesce(nullif(p_phone, ''), phone, ''),
      country = coalesce(nullif(p_country, ''), country, ''),
      note = coalesce(nullif(p_note, ''), note, '')
    where id = v_supplier.id
    returning * into v_supplier;

    return v_supplier;
  end if;

  insert into public.suppliers (
    organization_id,
    name,
    phone,
    country,
    note
  )
  values (
    p_organization_id,
    trim(p_name),
    coalesce(p_phone, ''),
    coalesce(p_country, ''),
    coalesce(p_note, '')
  )
  returning * into v_supplier;

  return v_supplier;
end;
$function$;
