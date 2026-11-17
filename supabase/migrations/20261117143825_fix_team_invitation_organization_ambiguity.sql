-- The output column organization_id is also a PL/pgSQL variable.  Always
-- qualify invitation columns so activation cannot fail with an ambiguous name.
create or replace function public.activate_team_access_invitation(
  p_email text,
  p_access_code text
)
returns table (
  organization_id uuid,
  name text,
  phone text,
  role text,
  status text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
  v_invitation public.team_access_invitations%rowtype;
  v_found boolean := false;
begin
  if auth.uid() is null
    or v_email = ''
    or lower(coalesce(auth.jwt() ->> 'email', '')) <> v_email then
    raise exception 'CONVITE_INVALIDO';
  end if;

  if coalesce(p_access_code, '') !~ '^[0-9]{8}$' then
    raise exception 'CONVITE_INVALIDO';
  end if;

  for v_invitation in
    select i.*
    from public.team_access_invitations i
    where lower(i.email) = v_email
      and i.status = 'pending'
      and i.expires_at > now()
    order by i.created_at desc
    for update
  loop
    if v_invitation.access_code_hash = extensions.crypt(p_access_code, v_invitation.access_code_hash) then
      v_found := true;
      exit;
    end if;
  end loop;

  if not v_found then
    raise exception 'CONVITE_INVALIDO';
  end if;

  update public.profiles p
  set auth_user_id = auth.uid(),
      name = v_invitation.name,
      phone = v_invitation.phone,
      role = v_invitation.role,
      status = 'active',
      last_seen_at = now()
  where p.organization_id = v_invitation.organization_id
    and lower(p.email) = v_email;

  if not found then
    raise exception 'CONVITE_INVALIDO';
  end if;

  update public.team_access_invitations i
  set status = 'used', used_at = now()
  where i.organization_id = v_invitation.organization_id
    and i.email = v_invitation.email;

  return query
  select p.organization_id, p.name, p.phone, p.role, p.status
  from public.profiles p
  where p.organization_id = v_invitation.organization_id
    and lower(p.email) = v_email
  limit 1;
end;
$$;

revoke all on function public.activate_team_access_invitation(text, text) from public;
grant execute on function public.activate_team_access_invitation(text, text) to authenticated;
