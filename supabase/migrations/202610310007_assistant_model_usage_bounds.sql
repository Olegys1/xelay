-- Local preparation only. Update the actual-usage bounds for larger assistant
-- outputs without changing the fixed $0.05 reservation, configured ceilings,
-- enabled/disabled state, existing usage, claims, receipts or UTC buckets.
-- 40000 input + 4000 output tokens cost $0.048 at the pinned Standard price.
-- This is a settlement guard, not a token estimate or provider invoice cap:
-- all provider input (including images) must also be bounded before dispatch.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$begin
  if to_regprocedure('public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer)') is null
    or to_regprocedure('public.xelay_assistant_model_reserve(uuid,uuid,text,text)') is null
    or to_regprocedure('public.xelay_assistant_model_remaining(uuid,date,date)') is null
    or to_regprocedure('public.xelay_assistant_draft_service(uuid,boolean)') is null
    or to_regclass('public.assistant_model_control') is null
    or to_regclass('public.assistant_model_usage') is null
    or to_regclass('public.assistant_model_ledger') is null then
    raise exception 'ASSISTANT_MODEL_USAGE_BOUNDS_PREREQUISITE_MISSING';
  end if;
end $$;

create or replace function public.xelay_assistant_model_finish(p_user_id uuid,p_request_id uuid,p_context_hash text,p_claim_hash text,
  p_outcome text,p_input_tokens integer default null,p_output_tokens integer default null)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='3s' as $$
declare
  v_control public.assistant_model_control%rowtype;v_row public.assistant_model_ledger%rowtype;
  v_actual bigint;v_charge bigint;v_delta bigint;v_state text;v_halt text;v_now timestamptz;v_day date;v_month date;
  v_global constant uuid:='00000000-0000-0000-0000-000000000000';
begin
  -- A removed/banned account may settle an earlier cost, never reserve again.
  perform public.xelay_assistant_draft_service(p_user_id,false);
  if p_request_id is null or p_request_id=v_global or p_context_hash is null or p_context_hash !~ '^[a-f0-9]{64}$'
    or p_claim_hash is null or p_claim_hash !~ '^[a-f0-9]{64}$' or p_outcome is null or p_outcome not in('succeeded','unknown')
    or(p_outcome='unknown' and(p_input_tokens is not null or p_output_tokens is not null))
    or(p_outcome='succeeded' and(p_input_tokens is null or p_output_tokens is null or p_input_tokens not between 0 and 2000000 or p_output_tokens not between 0 and 2000000)) then
    raise exception 'ASSISTANT_MODEL_FINISH_INVALID' using errcode='22023';end if;
  select * into v_control from public.assistant_model_control where singleton for update;
  if not found then raise exception 'ASSISTANT_MODEL_CONTROL_MISSING' using errcode='55000';end if;
  select * into v_row from public.assistant_model_ledger where request_id=p_request_id for update;
  if not found or v_row.user_id<>p_user_id or v_row.context_hash<>p_context_hash or v_row.claim_hash<>p_claim_hash then
    raise exception 'ASSISTANT_MODEL_FINISH_CONFLICT' using errcode='PT409';end if;
  v_now:=clock_timestamp();v_day:=(v_now at time zone 'UTC')::date;v_month:=date_trunc('month',v_now at time zone 'UTC')::date;
  if v_row.state<>'reserved' then
    if(v_row.state='unknown' and p_outcome<>'unknown') or(v_row.state<>'unknown' and p_outcome<>'succeeded')
      or v_row.input_tokens is distinct from p_input_tokens or v_row.output_tokens is distinct from p_output_tokens then
      raise exception 'ASSISTANT_MODEL_FINISH_CONFLICT' using errcode='PT409';end if;
    return jsonb_build_object('finished',true,'reused',true,'requestId',p_request_id,'state',v_row.state,
      'halted',v_row.state='over_limit','chargedMicrousd',v_row.charged_microusd,'remaining',public.xelay_assistant_model_remaining(p_user_id,v_day,v_month));
  end if;
  v_state:='unknown';v_charge:=v_row.reserved_microusd;
  if p_outcome='succeeded' then
    -- Fixed gpt-5.4-mini Standard price, no cache discount assumed:
    -- ceil(input*$0.75/1M + output*$4.50/1M), expressed in micro-USD.
    v_actual:=(3*p_input_tokens::bigint+18*p_output_tokens::bigint+3)/4;
    v_halt:=case when v_actual>v_row.reserved_microusd then 'usage_over_reservation'
      when p_input_tokens>40000 or p_output_tokens>4000 then 'usage_outside_bound' else null end;
    if v_halt is null then v_state:='succeeded';v_charge:=v_actual;
    else
      v_state:='over_limit';v_charge:=greatest(v_row.reserved_microusd,v_actual);
      update public.assistant_model_control set enabled=false,halted_reason=v_halt,halted_at=v_now where singleton;
    end if;
  end if;
  v_delta:=v_charge-v_row.charged_microusd;
  if exists(select 1 from public.assistant_model_usage where
    ((scope='day' and period=v_row.utc_day and scope_id=v_global) or(scope='month' and period=v_row.utc_month and scope_id=v_global)
      or(scope='user_day' and period=v_row.utc_day and scope_id=p_user_id)) and charged_microusd+v_delta<0) then
    raise exception 'ASSISTANT_MODEL_COUNTER_CORRUPT' using errcode='55000';end if;
  if(select count(*) from public.assistant_model_usage where(scope='day' and period=v_row.utc_day and scope_id=v_global)
    or(scope='month' and period=v_row.utc_month and scope_id=v_global) or(scope='user_day' and period=v_row.utc_day and scope_id=p_user_id))<>3 then
    raise exception 'ASSISTANT_MODEL_COUNTER_MISSING' using errcode='55000';end if;
  update public.assistant_model_usage set charged_microusd=charged_microusd+v_delta
    where(scope='day' and period=v_row.utc_day and scope_id=v_global) or(scope='month' and period=v_row.utc_month and scope_id=v_global)
      or(scope='user_day' and period=v_row.utc_day and scope_id=p_user_id);
  update public.assistant_model_ledger set state=v_state,charged_microusd=v_charge,input_tokens=p_input_tokens,
    output_tokens=p_output_tokens,finished_at=v_now where request_id=p_request_id;
  return jsonb_build_object('finished',true,'reused',false,'requestId',p_request_id,'state',v_state,'halted',v_state='over_limit',
    'chargedMicrousd',v_charge,'remaining',public.xelay_assistant_model_remaining(p_user_id,v_day,v_month));
end $$;

revoke all on function public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer) to service_role;
comment on function public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer) is 'Private one-shot settlement. Standard mini bounds: 40000 actual input tokens including vision, 4000 actual output tokens including reasoning; fixed reserve remains 50000 micro-USD. Unknown outcomes retain the reserve; existing receipts remain once-only. Not a provider invoice cap.';
notify pgrst,'reload schema';
commit;
