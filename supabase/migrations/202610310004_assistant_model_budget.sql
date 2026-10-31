-- Dormant, private budget for the assistant model only. No provider, payment,
-- API key, model call, scheduler or automatic refill is enabled by this file.
-- Amounts are integer millionths of USD; every dispatch reserves $0.05 first.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$begin
  if to_regprocedure('public.xelay_assistant_draft_service(uuid,boolean)') is null
    or to_regclass('public.assistant_model_control') is not null
    or to_regclass('public.assistant_model_usage') is not null
    or to_regclass('public.assistant_model_ledger') is not null then
    raise exception 'ASSISTANT_MODEL_BUDGET_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $$;

create table public.assistant_model_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  day_microusd_limit bigint not null default 0 check(day_microusd_limit between 0 and 1000000000000),
  month_microusd_limit bigint not null default 0 check(month_microusd_limit between 0 and 1000000000000),
  user_day_request_limit integer not null default 0 check(user_day_request_limit between 0 and 1000000),
  halted_reason text check(halted_reason in('usage_over_reservation','usage_outside_bound')),
  halted_at timestamptz
);
insert into public.assistant_model_control(singleton) values(true);
create table public.assistant_model_usage (
  scope text not null check(scope in('day','month','user_day')),
  period date not null,
  scope_id uuid not null,
  charged_microusd bigint not null default 0 check(charged_microusd>=0),
  requests bigint not null default 0 check(requests>=0),
  primary key(scope,period,scope_id),
  check((scope='user_day' and scope_id<>'00000000-0000-0000-0000-000000000000'::uuid)
    or(scope<>'user_day' and scope_id='00000000-0000-0000-0000-000000000000'::uuid)),
  check(scope<>'month' or extract(day from period)=1)
);
create table public.assistant_model_ledger (
  request_id uuid primary key check(request_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  user_id uuid not null check(user_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  context_hash text not null check(context_hash ~ '^[a-f0-9]{64}$'),
  claim_hash text not null check(claim_hash ~ '^[a-f0-9]{64}$'),
  utc_day date not null,
  utc_month date not null check(extract(day from utc_month)=1),
  state text not null default 'reserved' check(state in('reserved','succeeded','unknown','over_limit')),
  reserved_microusd bigint not null default 50000 check(reserved_microusd=50000),
  charged_microusd bigint not null default 50000 check(charged_microusd>=0),
  input_tokens integer check(input_tokens between 0 and 2000000),
  output_tokens integer check(output_tokens between 0 and 2000000),
  reserved_at timestamptz not null,
  expires_at timestamptz not null,
  finished_at timestamptz,
  check(expires_at>reserved_at),
  check((state='reserved' and finished_at is null and input_tokens is null and output_tokens is null)
    or(state='unknown' and finished_at is not null and input_tokens is null and output_tokens is null)
    or(state in('succeeded','over_limit') and finished_at is not null and input_tokens is not null and output_tokens is not null)),
  check(state not in('reserved','unknown') or charged_microusd=reserved_microusd)
);
create index assistant_model_ledger_owner_day_idx on public.assistant_model_ledger(user_id,utc_day);
alter table public.assistant_model_control enable row level security;
alter table public.assistant_model_usage enable row level security;
alter table public.assistant_model_ledger enable row level security;
revoke all on table public.assistant_model_control,public.assistant_model_usage,public.assistant_model_ledger from public,anon,authenticated,service_role;

create function public.xelay_assistant_model_remaining(p_user_id uuid,p_day date,p_month date)
returns jsonb language sql volatile security definer set search_path='' as $$
 select jsonb_build_object(
   'dayMicrousd',greatest(0,c.day_microusd_limit-coalesce((select u.charged_microusd from public.assistant_model_usage u where u.scope='day' and u.period=p_day and u.scope_id='00000000-0000-0000-0000-000000000000'::uuid),0)),
   'monthMicrousd',greatest(0,c.month_microusd_limit-coalesce((select u.charged_microusd from public.assistant_model_usage u where u.scope='month' and u.period=p_month and u.scope_id='00000000-0000-0000-0000-000000000000'::uuid),0)),
   'userDayRequests',greatest(0,c.user_day_request_limit-coalesce((select u.requests from public.assistant_model_usage u where u.scope='user_day' and u.period=p_day and u.scope_id=p_user_id),0))
 ) from public.assistant_model_control c where c.singleton
$$;

create function public.xelay_assistant_model_reserve(p_user_id uuid,p_request_id uuid,p_context_hash text,p_claim_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' set lock_timeout='3s' as $$
declare
  v_control public.assistant_model_control%rowtype;
  v_row public.assistant_model_ledger%rowtype;
  v_now timestamptz;v_day date;v_month date;v_day_used bigint;v_month_used bigint;v_user_requests bigint;
  v_global constant uuid:='00000000-0000-0000-0000-000000000000';v_reason text;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  if p_request_id is null or p_request_id=v_global or p_context_hash is null or p_context_hash !~ '^[a-f0-9]{64}$'
    or p_claim_hash is null or p_claim_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'ASSISTANT_MODEL_REQUEST_INVALID' using errcode='22023';end if;
  -- The control row is the shared lock for every owner and every cloud worker.
  -- No provider operation occurs while holding a database transaction open.
  select * into v_control from public.assistant_model_control where singleton for update;
  if not found then raise exception 'ASSISTANT_MODEL_CONTROL_MISSING' using errcode='55000';end if;
  v_now:=clock_timestamp();v_day:=(v_now at time zone 'UTC')::date;v_month:=date_trunc('month',v_now at time zone 'UTC')::date;
  select * into v_row from public.assistant_model_ledger where request_id=p_request_id;
  if found then
    if v_row.user_id<>p_user_id or v_row.context_hash<>p_context_hash then
      raise exception 'ASSISTANT_MODEL_REQUEST_CONFLICT' using errcode='PT409';end if;
    return jsonb_build_object('allowed',false,'reused',true,'reason','replay','requestId',p_request_id,'state',v_row.state);
  end if;
  if not v_control.enabled or v_control.halted_reason is not null then
    return jsonb_build_object('allowed',false,'reused',false,'reason',case when v_control.halted_reason is null then 'disabled' else 'halted' end,
      'remaining',public.xelay_assistant_model_remaining(p_user_id,v_day,v_month));end if;
  insert into public.assistant_model_usage(scope,period,scope_id) values('day',v_day,v_global),('month',v_month,v_global),('user_day',v_day,p_user_id)
    on conflict(scope,period,scope_id) do nothing;
  select charged_microusd into v_day_used from public.assistant_model_usage where scope='day' and period=v_day and scope_id=v_global;
  select charged_microusd into v_month_used from public.assistant_model_usage where scope='month' and period=v_month and scope_id=v_global;
  select requests into v_user_requests from public.assistant_model_usage where scope='user_day' and period=v_day and scope_id=p_user_id;
  v_reason:=case when v_user_requests>=v_control.user_day_request_limit then 'user_day_limit'
    when v_day_used+50000>v_control.day_microusd_limit then 'day_limit'
    when v_month_used+50000>v_control.month_microusd_limit then 'month_limit' else null end;
  if v_reason is not null then return jsonb_build_object('allowed',false,'reused',false,'reason',v_reason,
    'remaining',public.xelay_assistant_model_remaining(p_user_id,v_day,v_month));end if;
  insert into public.assistant_model_ledger(request_id,user_id,context_hash,claim_hash,utc_day,utc_month,reserved_at,expires_at)
    values(p_request_id,p_user_id,p_context_hash,p_claim_hash,v_day,v_month,v_now,v_now+interval'15 minutes');
  update public.assistant_model_usage set charged_microusd=charged_microusd+50000,requests=requests+1
    where(scope='day' and period=v_day and scope_id=v_global) or(scope='month' and period=v_month and scope_id=v_global)
      or(scope='user_day' and period=v_day and scope_id=p_user_id);
  return jsonb_build_object('allowed',true,'reused',false,'requestId',p_request_id,'userId',p_user_id,'state','reserved',
    'reservedMicrousd',50000,'expiresAt',v_now+interval'15 minutes','remaining',public.xelay_assistant_model_remaining(p_user_id,v_day,v_month));
end $$;

create function public.xelay_assistant_model_finish(p_user_id uuid,p_request_id uuid,p_context_hash text,p_claim_hash text,
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
      when p_input_tokens>50000 or p_output_tokens>1800 then 'usage_outside_bound' else null end;
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

revoke all on function public.xelay_assistant_model_remaining(uuid,date,date),public.xelay_assistant_model_reserve(uuid,uuid,text,text),
  public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_model_reserve(uuid,uuid,text,text),
  public.xelay_assistant_model_finish(uuid,uuid,text,text,text,integer,integer) to service_role;
comment on table public.assistant_model_control is 'Assistant-only model budget. Disabled and zero limits by default. Integer micro-USD; reserve 50000 before each one-shot Standard gpt-5.4-mini call. No other API feature, provider billing or automatic reload is controlled here.';
comment on table public.assistant_model_ledger is 'Private accounting metadata and numeric token usage only. No prompts, responses, personal content, access tokens or API keys. Unknown results retain their full reservation forever; no automatic retry, lease recovery or refund.';
notify pgrst,'reload schema';
commit;
