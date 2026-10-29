-- Immediate, explicitly confirmed transfer to an existing accepted classmate.
-- Group IDs/content, original approval provenance and user subscriptions stay put.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regclass('public.class_representative_requests') is null
    or to_regclass('auth.users') is null
    or to_regprocedure('public.xelay_create_study_group(uuid)') is null
    or to_regprocedure('public.xelay_is_study_group_representative(uuid)') is null then
    raise exception 'REPRESENTATIVE_TRANSFER_PREREQUISITES_MISSING';
  end if;
  if to_regclass('public.study_group_representative_transfers') is not null then
    raise exception 'REPRESENTATIVE_TRANSFER_ALREADY_INSTALLED';
  end if;
end;
$preflight$;

create table public.study_group_representative_transfers(
  request_id uuid primary key,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  -- Historical actor IDs deliberately have no profile/account foreign key:
  -- an ordinary former representative must not be trapped by an audit receipt
  -- when their profile is later removed. Active parties are checked in the RPC.
  previous_representative_id uuid not null,
  representative_id uuid not null,
  transferred_at timestamptz not null default clock_timestamp(),
  cleared_deputy_appointments jsonb not null default '[]'::jsonb,
  check(previous_representative_id<>representative_id),
  check(jsonb_typeof(cleared_deputy_appointments)='array')
);
create index study_group_representative_transfers_group_idx
  on public.study_group_representative_transfers(group_id,transferred_at desc);
alter table public.study_group_representative_transfers enable row level security;
revoke all on public.study_group_representative_transfers from public,anon,authenticated,service_role;
comment on table public.study_group_representative_transfers is
  'Closed ownership-transfer audit and idempotency receipts. No browser table privileges or read policy. Historic approval records and personal subscriptions are never reassigned.';

create function public.xelay_private_representative_account_active(p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_user is not null and exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=p_user and u.deleted_at is null and u.email_confirmed_at is not null
      and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp());
$$;
revoke all on function public.xelay_private_representative_account_active(uuid)
  from public,anon,authenticated,service_role;

create function public.xelay_my_study_group_representative_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_owned jsonb;v_requests jsonb;v_is_owner boolean;v_can_create boolean;
begin
  if v_user is null then raise exception 'REPRESENTATIVE_TRANSFER_AUTH_REQUIRED' using errcode='42501';end if;
  if not public.xelay_private_representative_account_active(v_user) then
    raise exception 'REPRESENTATIVE_TRANSFER_ACCOUNT_UNAVAILABLE' using errcode='42501';end if;
  select exists(select 1 from public.study_groups g where g.representative_id=v_user) into v_is_owner;
  select exists(select 1 from public.class_representative_requests r
    where r.user_id=v_user and r.status='approved' and not exists(
      select 1 from public.study_groups g where g.representative_request_id=r.id)) into v_can_create;
  select coalesce(jsonb_agg(s.id order by s.id),'[]'::jsonb) into v_owned from(
    select g.id from public.study_groups g where g.representative_id=v_user order by g.id limit 200)s;
  select coalesce(jsonb_agg(s.id order by s.id),'[]'::jsonb) into v_requests from(
    select r.id from public.class_representative_requests r where r.user_id=v_user and r.status='approved'
      and not exists(select 1 from public.study_groups g
        where g.representative_request_id=r.id and g.representative_id<>v_user)
    order by r.id limit 200)s;
  return jsonb_build_object('is_representative',v_is_owner or v_can_create,
    'owned_group_ids',v_owned,'available_request_ids',v_requests,'can_create_group',v_can_create);
end;
$$;
revoke all on function public.xelay_my_study_group_representative_status()
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_study_group_representative_status() to authenticated;
comment on function public.xelay_my_study_group_representative_status() is
  'Own actual ownership or an unconsumed approved application. Lists are bounded to 200; boolean flags are computed over all matching rows. Historic transferred approvals cannot supply a badge or another group.';

create function public.xelay_transfer_study_group_representative(
  p_group_id uuid,p_new_representative_id uuid,p_expected_representative_id uuid,p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_group public.study_groups%rowtype;
  v_receipt public.study_group_representative_transfers%rowtype;v_deputies jsonb;
begin
  if v_user is null then raise exception 'REPRESENTATIVE_TRANSFER_AUTH_REQUIRED' using errcode='42501';end if;
  if p_group_id is null or p_new_representative_id is null or p_expected_representative_id is null
    or p_request_id is null or p_new_representative_id=p_expected_representative_id then
    raise exception 'REPRESENTATIVE_TRANSFER_INVALID_ARGUMENT' using errcode='22023';end if;
  if p_expected_representative_id<>v_user then
    raise exception 'REPRESENTATIVE_TRANSFER_NOT_OWNER' using errcode='42501';end if;
  if not public.xelay_private_representative_account_active(v_user) then
    raise exception 'REPRESENTATIVE_TRANSFER_ACCOUNT_UNAVAILABLE' using errcode='42501';end if;
  -- Request lock also serializes accidental reuse of one UUID across groups.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:representative-transfer:'||p_request_id::text,0));
  -- Same namespace/order as deputy changes, content writes and member removal.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:seminars:'||p_group_id::text,0));
  select * into v_receipt from public.study_group_representative_transfers where request_id=p_request_id;
  if found then
    if v_receipt.group_id<>p_group_id or v_receipt.previous_representative_id<>v_user
      or v_receipt.representative_id<>p_new_representative_id then
      raise exception 'REPRESENTATIVE_TRANSFER_REQUEST_REUSED' using errcode='22023';end if;
    return jsonb_build_object('group_id',v_receipt.group_id,'previous_representative_id',v_receipt.previous_representative_id,
      'representative_id',v_receipt.representative_id,'request_id',v_receipt.request_id,
      'transferred_at',v_receipt.transferred_at,'replayed',true);
  end if;
  select * into v_group from public.study_groups where id=p_group_id for update;
  if not found then raise exception 'REPRESENTATIVE_TRANSFER_NOT_OWNER' using errcode='42501';end if;
  if v_group.representative_id<>v_user then
    if exists(select 1 from public.study_group_representative_transfers t
      where t.group_id=p_group_id and t.previous_representative_id=v_user) then
      -- A business conflict, never serialization_failure (40001): PostgREST14
      -- retries that code internally and can loop on an unchanged owner.
      raise exception 'REPRESENTATIVE_TRANSFER_STALE' using errcode='PT409';end if;
    raise exception 'REPRESENTATIVE_TRANSFER_NOT_OWNER' using errcode='42501';
  end if;
  -- Lock both account rows so deletion/banning cannot race this decision.
  perform u.id from auth.users u where u.id in(v_user,p_new_representative_id) order by u.id for share;
  if not public.xelay_private_representative_account_active(v_user)
    or not public.xelay_private_representative_account_active(p_new_representative_id) then
    raise exception 'REPRESENTATIVE_TRANSFER_ACCOUNT_UNAVAILABLE' using errcode='42501';end if;
  perform m.id from public.study_group_members m where m.group_id=p_group_id
    and m.user_id=p_new_representative_id and m.status='accepted' for share;
  if not found then raise exception 'REPRESENTATIVE_TRANSFER_TARGET_NOT_ACCEPTED' using errcode='42501';end if;
  -- A representative can lack a membership row. Preserve an accepted existing
  -- row verbatim; otherwise retain the outgoing user as an ordinary classmate.
  -- Self-invited acceptance avoids generating an invitation-accepted email.
  insert into public.study_group_members(group_id,user_id,invited_by,status,accepted_at)
    values(p_group_id,v_user,v_user,'accepted',statement_timestamp())
    on conflict(group_id,user_id) do update set status='accepted',invited_by=v_user,
      accepted_at=coalesce(public.study_group_members.accepted_at,statement_timestamp()),updated_at=statement_timestamp()
    where public.study_group_members.status<>'accepted';
  select coalesce(jsonb_agg(jsonb_build_object('user_id',d.user_id,'status',d.status,'permissions',d.permissions)
    order by d.user_id),'[]'::jsonb) into v_deputies
    from public.study_group_deputy_requests d where d.group_id=p_group_id
      and d.user_id in(v_user,p_new_representative_id);
  -- This table stores current appointments. Retain the prior grants in the
  -- closed audit receipt, while deleting these two current rows prevents any
  -- dormant grant from reappearing on a later transfer. DELETE is silent.
  delete from public.study_group_deputy_requests where group_id=p_group_id
    and user_id in(v_user,p_new_representative_id);
  update public.study_groups set representative_id=p_new_representative_id where id=p_group_id;
  insert into public.study_group_representative_transfers(
    request_id,group_id,previous_representative_id,representative_id,cleared_deputy_appointments)
    values(p_request_id,p_group_id,v_user,p_new_representative_id,v_deputies) returning * into v_receipt;
  return jsonb_build_object('group_id',v_receipt.group_id,'previous_representative_id',v_receipt.previous_representative_id,
    'representative_id',v_receipt.representative_id,'request_id',v_receipt.request_id,
    'transferred_at',v_receipt.transferred_at,'replayed',false);
end;
$$;
revoke all on function public.xelay_transfer_study_group_representative(uuid,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_transfer_study_group_representative(uuid,uuid,uuid,uuid) to authenticated;
comment on function public.xelay_transfer_study_group_representative(uuid,uuid,uuid,uuid) is
  'Immediate atomic transfer by the actual current representative to a current accepted active member; no admin or teacher bypass. Caller supplies expected self and a stable UUID; exact own retries replay their receipt. No messages, emails or push are generated.';

-- Patch only the known current create RPC. Preserve its complete original
-- source (including CRLF), OID, owner, grants, signature and all other metadata.
do $create_guard$
declare v_oid oid:=to_regprocedure('public.xelay_create_study_group(uuid)');v_before jsonb;v_after jsonb;
  v_source text;v_definition text;v_expected text;v_new text;v_marker text;
begin
  select to_jsonb(p)-'prosrc',p.prosrc,pg_catalog.pg_get_functiondef(p.oid)
    into v_before,v_source,v_definition from pg_catalog.pg_proc p where p.oid=v_oid;
  v_marker:='if auth.uid() is null then raise exception ''Authentication required''; end if;';
  if (length(v_source)-length(replace(v_source,v_marker,'')))/length(v_marker)<>1
    or strpos(v_source,'where id=p_request_id and user_id=auth.uid() and status=''approved'' for update;')=0
    or strpos(v_source,'where representative_request_id=p_request_id;')=0
    or strpos(v_source,'if found then return v_group_id; end if;')=0 then
    raise exception 'REPRESENTATIVE_TRANSFER_CREATE_SOURCE_DRIFT';end if;
  v_new:=v_marker||case when strpos(v_source,E'\r\n')>0 then E'\r\n' else E'\n' end||
    '  if exists(select 1 from public.study_groups g where g.representative_request_id=p_request_id and g.representative_id<>auth.uid()) then raise exception ''STUDY_GROUP_REQUEST_TRANSFERRED'' using errcode=''42501'';end if;';
  v_expected:=replace(v_source,v_marker,v_new);
  if strpos(v_definition,v_source)=0 then raise exception 'REPRESENTATIVE_TRANSFER_CREATE_DEFINITION_DRIFT';end if;
  execute replace(v_definition,v_source,v_expected);
  select to_jsonb(p)-'prosrc' into v_after from pg_catalog.pg_proc p where p.oid=v_oid;
  if v_before is distinct from v_after
    or (select prosrc from pg_catalog.pg_proc where oid=v_oid) is distinct from v_expected
    or replace(v_expected,v_new,v_marker) is distinct from v_source then
    raise exception 'REPRESENTATIVE_TRANSFER_CREATE_UNEXPECTED_CHANGE';end if;
end;
$create_guard$;

notify pgrst,'reload schema';
commit;
