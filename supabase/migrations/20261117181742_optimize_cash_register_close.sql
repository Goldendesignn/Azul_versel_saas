-- A closing shift locks the session so no sale can be attached after its total is calculated.
-- Bound lock and statement waits so the POS never appears frozen when another request is in flight.

create or replace function public.close_cash_register(
  p_session_id uuid,
  p_counted_amount numeric,
  p_closing_note text default null,
  p_actor_name text default null
)
returns public.cash_register_sessions
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.cash_register_sessions%rowtype;
  v_expected numeric;
  v_difference numeric;
  v_review_status text;
  v_actor_name text;
begin
  if auth.uid() is null then raise exception 'Autenticacao obrigatoria.'; end if;

  -- Do not leave a cashier waiting forever for a pending sale or cash movement.
  perform set_config('lock_timeout', '3000ms', true);
  perform set_config('statement_timeout', '8000ms', true);

  select * into v_session
  from public.cash_register_sessions
  where id = p_session_id
  for update;

  if not found or not public.is_org_member(v_session.organization_id) then raise exception 'Tour de caixa nao encontrado.'; end if;
  if v_session.status <> 'open' then raise exception 'Este tour de caixa ja esta fechado.'; end if;
  if v_session.opened_by <> auth.uid() then raise exception 'Apenas o caixa que abriu o tour pode fechar a caixa.'; end if;
  if coalesce(p_counted_amount, -1) < 0 then raise exception 'O montante contado nao pode ser negativo.'; end if;

  select expected_amount into v_expected
  from public.get_cash_register_summary(v_session.id);

  v_difference := coalesce(p_counted_amount, 0) - coalesce(v_expected, 0);
  if abs(v_difference) > 0.009 and char_length(btrim(coalesce(p_closing_note, ''))) < 2 then
    raise exception 'Indique uma justificacao para o desvio de caixa.';
  end if;

  v_review_status := case when abs(v_difference) > 0.009 then 'pending' else 'not_required' end;
  v_actor_name := public.cash_register_actor_name(p_actor_name);

  update public.cash_register_sessions
  set status = 'closed', closed_at = now(), closed_by = auth.uid(), closed_by_name = v_actor_name,
      expected_amount = coalesce(v_expected, 0), counted_amount = p_counted_amount,
      difference_amount = v_difference, closing_note = nullif(btrim(coalesce(p_closing_note, '')), ''),
      review_status = v_review_status, updated_at = now()
  where id = v_session.id
  returning * into v_session;

  insert into public.cash_register_events (organization_id, session_id, event_type, actor_id, actor_name, details)
  values (v_session.organization_id, v_session.id, 'closed', auth.uid(), v_actor_name,
    jsonb_build_object('expected_amount', v_session.expected_amount, 'counted_amount', v_session.counted_amount,
      'difference_amount', v_session.difference_amount, 'review_status', v_session.review_status,
      'closing_note', coalesce(v_session.closing_note, '')));

  return v_session;
exception
  when lock_not_available or query_canceled then
    raise exception 'CAIXA_OCUPADA: existe uma venda ou movimento em curso. Aguarde alguns segundos e tente novamente.';
end;
$$;

revoke all on function public.close_cash_register(uuid, numeric, text, text) from public;
grant execute on function public.close_cash_register(uuid, numeric, text, text) to authenticated;
