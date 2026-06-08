-- Azul Gestao - reparar o acesso do administrador principal.
-- Executar no Supabase correspondente ao site admin.

do $$
declare
  v_admin_email text := 'mctrdcr1@gmail.com';
  v_admin_user_id uuid;
begin
  select u.id
    into v_admin_user_id
  from auth.users u
  where lower(u.email) = lower(v_admin_email)
  order by u.created_at
  limit 1;

  if v_admin_user_id is null then
    raise exception 'ADMIN_AUTH_USER_NOT_FOUND: %', v_admin_email;
  end if;

  delete from public.admin_users
  where lower(coalesce(email, '')) = lower(v_admin_email)
    and user_id <> v_admin_user_id;

  insert into public.admin_users (user_id, email, active)
  values (v_admin_user_id, lower(v_admin_email), true)
  on conflict (user_id)
  do update set
    email = excluded.email,
    active = true;
end;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, auth, pg_temp
as $$
  select exists (
    select 1
    from public.admin_users au
    where au.active = true
      and (
        au.user_id = auth.uid()
        or lower(coalesce(au.email, '')) =
           lower(coalesce(auth.jwt() ->> 'email', ''))
      )
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

