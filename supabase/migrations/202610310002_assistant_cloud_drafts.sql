-- Private durable confirmation journal. Domain writes still use the verified
-- caller's JWT and existing RLS/RPCs; these functions never execute a stored plan.
-- No model, billing, notification, cleanup or background worker is enabled here.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regclass('auth.users') is null or to_regclass('public.profiles') is null
    or to_regprocedure('auth.role()') is null then
    raise exception 'ASSISTANT_DRAFT_PREREQUISITES_MISSING';
  end if;
end $preflight$;

create table if not exists public.assistant_cloud_drafts (
  id uuid primary key check(id<>'00000000-0000-0000-0000-000000000000'::uuid),
  user_id uuid not null check(user_id<>'00000000-0000-0000-0000-000000000000'::uuid),
  revision integer not null default 1 check(revision between 1 and 1000000),
  status text not null default 'pending' check(status in('pending','committing','confirmed','cancelled','unknown')),
  document jsonb not null check(jsonb_typeof(document)='object' and octet_length(document::text)<=180000),
  confirmation_hash text not null check(confirmation_hash ~ '^[a-f0-9]{64}$'),
  claim_hash text check(claim_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  finished_at timestamptz,
  receipt jsonb check(receipt is null or jsonb_typeof(receipt)='object' and octet_length(receipt::text)<=12000),
  check(expires_at>created_at),
  check((status in('pending','cancelled') and claim_hash is null and claimed_at is null)
    or(status in('committing','confirmed','unknown') and claim_hash is not null and claimed_at is not null)),
  check((status in('pending','committing') and finished_at is null)
    or(status in('confirmed','cancelled','unknown') and finished_at is not null)),
  check((status='confirmed' and receipt is not null) or(status<>'confirmed' and receipt is null))
);
create index if not exists assistant_cloud_drafts_owner_created_idx on public.assistant_cloud_drafts(user_id,created_at desc,id);
alter table public.assistant_cloud_drafts enable row level security;
revoke all on table public.assistant_cloud_drafts from public,anon,authenticated,service_role;

create or replace function public.xelay_assistant_draft_service(p_user_id uuid,p_require_active boolean default true)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'ASSISTANT_DRAFT_SERVICE_REQUIRED' using errcode='42501';
  end if;
  if p_user_id is null or p_user_id='00000000-0000-0000-0000-000000000000'::uuid then
    raise exception 'ASSISTANT_DRAFT_USER_REQUIRED' using errcode='22023';
  end if;
  if p_require_active then
    perform 1 from auth.users u join public.profiles p on p.id=u.id
      where u.id=p_user_id and u.email_confirmed_at is not null and u.deleted_at is null
        and(u.banned_until is null or u.banned_until<=clock_timestamp()) for share of u,p;
    if not found then raise exception 'ASSISTANT_DRAFT_ACCOUNT_REQUIRED' using errcode='42501'; end if;
  end if;
end $$;

create or replace function public.xelay_assistant_draft_document_valid(p_document jsonb)
returns boolean language sql immutable security definer set search_path='' as $$
 select p_document is not null and jsonb_typeof(p_document)='object'
   and octet_length(p_document::text)<=180000
   and p_document->>'action' in('schedule.create','schedule.update','homework.upsert','organizer.task.create',
     'seminar.book','seminar.team.join','seminar.reopen','teaching.assignment.upsert','teaching.publication.schedule')
   and jsonb_typeof(p_document->'scope')='object' and jsonb_typeof(p_document->'payload')='object'
   and not(p_document ?| array['id','userId','revision','status','createdAt','expiresAt','receipt','confirmationToken','claimToken'])
   and p_document::text !~* '"(authorization|access_token|refresh_token|password|apiKey|serviceRoleKey|cookie|confirmationToken|claimToken)"[[:space:]]*:'
$$;

create or replace function public.xelay_assistant_draft_envelope(p_row public.assistant_cloud_drafts)
returns jsonb language sql immutable security definer set search_path='' as $$
 select jsonb_build_object('id',p_row.id,'userId',p_row.user_id,'revision',p_row.revision,'status',p_row.status,
   'createdAt',p_row.created_at,'expiresAt',p_row.expires_at,'document',p_row.document,
   'receipt',p_row.receipt)
$$;

create or replace function public.xelay_assistant_cloud_draft_create(p_user_id uuid,p_id uuid,p_document jsonb,p_confirmation_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row public.assistant_cloud_drafts%rowtype; v_now timestamptz;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  if p_id is null or p_id='00000000-0000-0000-0000-000000000000'::uuid
    or not coalesce(public.xelay_assistant_draft_document_valid(p_document),false)
    or p_confirmation_hash is null or p_confirmation_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'ASSISTANT_DRAFT_INVALID' using errcode='22023';
  end if;
  -- One owner lock covers simultaneous creates and the bounded pending count.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay-assistant-drafts:'||p_user_id::text,0));
  select * into v_row from public.assistant_cloud_drafts where id=p_id for update;
  if found then
    if v_row.user_id<>p_user_id or v_row.document<>p_document or v_row.confirmation_hash<>p_confirmation_hash then
      raise exception 'ASSISTANT_DRAFT_CONFLICT' using errcode='PT409';
    end if;
    return public.xelay_assistant_draft_envelope(v_row);
  end if;
  v_now:=clock_timestamp();
  if(select count(*) from public.assistant_cloud_drafts where user_id=p_user_id and status='pending' and expires_at>v_now)>=20 then
    raise exception 'ASSISTANT_DRAFT_LIMIT' using errcode='PT429';
  end if;
  insert into public.assistant_cloud_drafts(id,user_id,document,confirmation_hash,created_at,expires_at)
    values(p_id,p_user_id,p_document,p_confirmation_hash,v_now,v_now+interval '15 minutes') returning * into v_row;
  return public.xelay_assistant_draft_envelope(v_row);
end $$;

create or replace function public.xelay_assistant_cloud_draft_replace(p_user_id uuid,p_id uuid,p_revision integer,
  p_confirmation_hash text,p_document jsonb,p_new_confirmation_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row public.assistant_cloud_drafts%rowtype;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  if not coalesce(public.xelay_assistant_draft_document_valid(p_document),false)
    or p_new_confirmation_hash is null or p_new_confirmation_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'ASSISTANT_DRAFT_INVALID' using errcode='22023';
  end if;
  select * into v_row from public.assistant_cloud_drafts where id=p_id for update;
  if not found or v_row.user_id<>p_user_id then raise exception 'ASSISTANT_DRAFT_NOT_FOUND' using errcode='PT404'; end if;
  if v_row.revision is distinct from p_revision or v_row.confirmation_hash is distinct from p_confirmation_hash
    or v_row.status<>'pending' or v_row.expires_at<=clock_timestamp() then
    raise exception 'ASSISTANT_DRAFT_STALE' using errcode='PT409';
  end if;
  if v_row.document->>'action' is distinct from p_document->>'action'
    or v_row.document->'scope' is distinct from p_document->'scope'
    or v_row.document->>'recordId' is distinct from p_document->>'recordId' then
    raise exception 'ASSISTANT_DRAFT_TARGET_IMMUTABLE' using errcode='PT409';
  end if;
  update public.assistant_cloud_drafts set revision=revision+1,document=p_document,
    confirmation_hash=p_new_confirmation_hash where id=p_id returning * into v_row;
  return public.xelay_assistant_draft_envelope(v_row);
end $$;

create or replace function public.xelay_assistant_cloud_draft_cancel(p_user_id uuid,p_id uuid,p_revision integer,p_confirmation_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row public.assistant_cloud_drafts%rowtype;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  select * into v_row from public.assistant_cloud_drafts where id=p_id for update;
  if not found or v_row.user_id<>p_user_id then raise exception 'ASSISTANT_DRAFT_NOT_FOUND' using errcode='PT404'; end if;
  if v_row.revision is distinct from p_revision or v_row.confirmation_hash is distinct from p_confirmation_hash
    or v_row.status not in('pending','cancelled') then raise exception 'ASSISTANT_DRAFT_STALE' using errcode='PT409'; end if;
  if v_row.status='pending' then
    update public.assistant_cloud_drafts set status='cancelled',finished_at=clock_timestamp() where id=p_id returning * into v_row;
  end if;
  return public.xelay_assistant_draft_envelope(v_row);
end $$;

create or replace function public.xelay_assistant_cloud_draft_get(p_user_id uuid,p_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row public.assistant_cloud_drafts%rowtype;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  select * into v_row from public.assistant_cloud_drafts where id=p_id and user_id=p_user_id;
  if not found then raise exception 'ASSISTANT_DRAFT_NOT_FOUND' using errcode='PT404'; end if;
  return public.xelay_assistant_draft_envelope(v_row);
end $$;

create or replace function public.xelay_assistant_cloud_draft_list(p_user_id uuid,p_limit integer default 30)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  if p_limit is null or p_limit not between 1 and 100 then raise exception 'ASSISTANT_DRAFT_INVALID' using errcode='22023'; end if;
  select coalesce(jsonb_agg(public.xelay_assistant_draft_envelope(r) order by r.created_at desc,r.id),'[]'::jsonb) into v_result
    from(select * from public.assistant_cloud_drafts where user_id=p_user_id order by created_at desc,id limit p_limit)r;
  return v_result;
end $$;

create or replace function public.xelay_assistant_cloud_draft_claim(p_user_id uuid,p_id uuid,p_revision integer,
  p_confirmation_hash text,p_claim_hash text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row public.assistant_cloud_drafts%rowtype;
begin
  perform public.xelay_assistant_draft_service(p_user_id);
  if p_claim_hash is null or p_claim_hash !~ '^[a-f0-9]{64}$' then raise exception 'ASSISTANT_DRAFT_INVALID' using errcode='22023'; end if;
  select * into v_row from public.assistant_cloud_drafts where id=p_id for update;
  if not found or v_row.user_id<>p_user_id then raise exception 'ASSISTANT_DRAFT_NOT_FOUND' using errcode='PT404'; end if;
  if v_row.revision is distinct from p_revision or v_row.confirmation_hash is distinct from p_confirmation_hash then
    raise exception 'ASSISTANT_DRAFT_STALE' using errcode='PT409';
  end if;
  if v_row.status in('committing','confirmed','unknown') then
    return jsonb_build_object('claimed',false,'record',public.xelay_assistant_draft_envelope(v_row));
  end if;
  if v_row.status<>'pending' or v_row.expires_at<=clock_timestamp() then raise exception 'ASSISTANT_DRAFT_STALE' using errcode='PT409'; end if;
  update public.assistant_cloud_drafts set status='committing',claim_hash=p_claim_hash,claimed_at=clock_timestamp()
    where id=p_id returning * into v_row;
  -- Commit this claim before the server attempts any domain write. There is no
  -- release/lease-recovery function: timeout and restart cannot authorize replay.
  return jsonb_build_object('claimed',true,'record',public.xelay_assistant_draft_envelope(v_row));
end $$;

create or replace function public.xelay_assistant_cloud_draft_finish(p_user_id uuid,p_id uuid,p_claim_hash text,p_outcome text,p_receipt jsonb default null)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_row public.assistant_cloud_drafts%rowtype;
begin
  -- Revocation prevents new claims; finishing a previously attempted operation
  -- must still be recorded. This grants no new data/business-write capability.
  perform public.xelay_assistant_draft_service(p_user_id,false);
  if p_claim_hash is null or p_claim_hash !~ '^[a-f0-9]{64}$' or p_outcome is null or p_outcome not in('confirmed','unknown')
    or(p_outcome='confirmed' and(p_receipt is null or jsonb_typeof(p_receipt)<>'object' or octet_length(p_receipt::text)>12000))
    or(p_outcome='unknown' and p_receipt is not null)
    or(p_receipt is not null and p_receipt::text ~* '"(authorization|access_token|refresh_token|password|apiKey|serviceRoleKey|cookie|confirmationToken|claimToken)"[[:space:]]*:') then
    raise exception 'ASSISTANT_DRAFT_INVALID' using errcode='22023';
  end if;
  select * into v_row from public.assistant_cloud_drafts where id=p_id for update;
  if not found or v_row.user_id<>p_user_id or v_row.claim_hash is distinct from p_claim_hash then
    raise exception 'ASSISTANT_DRAFT_NOT_FOUND' using errcode='PT404';
  end if;
  if v_row.status in('confirmed','unknown') then
    if v_row.status<>p_outcome or v_row.receipt is distinct from p_receipt then raise exception 'ASSISTANT_DRAFT_FINISH_CONFLICT' using errcode='PT409'; end if;
    return public.xelay_assistant_draft_envelope(v_row);
  end if;
  if v_row.status<>'committing' then raise exception 'ASSISTANT_DRAFT_STALE' using errcode='PT409'; end if;
  update public.assistant_cloud_drafts set status=p_outcome,receipt=p_receipt,finished_at=clock_timestamp()
    where id=p_id returning * into v_row;
  return public.xelay_assistant_draft_envelope(v_row);
end $$;

revoke all on function public.xelay_assistant_draft_service(uuid,boolean),public.xelay_assistant_draft_document_valid(jsonb),
  public.xelay_assistant_draft_envelope(public.assistant_cloud_drafts),
  public.xelay_assistant_cloud_draft_create(uuid,uuid,jsonb,text),public.xelay_assistant_cloud_draft_replace(uuid,uuid,integer,text,jsonb,text),
  public.xelay_assistant_cloud_draft_cancel(uuid,uuid,integer,text),public.xelay_assistant_cloud_draft_get(uuid,uuid),
  public.xelay_assistant_cloud_draft_list(uuid,integer),public.xelay_assistant_cloud_draft_claim(uuid,uuid,integer,text,text),
  public.xelay_assistant_cloud_draft_finish(uuid,uuid,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_cloud_draft_create(uuid,uuid,jsonb,text),
  public.xelay_assistant_cloud_draft_replace(uuid,uuid,integer,text,jsonb,text),public.xelay_assistant_cloud_draft_cancel(uuid,uuid,integer,text),
  public.xelay_assistant_cloud_draft_get(uuid,uuid),public.xelay_assistant_cloud_draft_list(uuid,integer),
  public.xelay_assistant_cloud_draft_claim(uuid,uuid,integer,text,text),public.xelay_assistant_cloud_draft_finish(uuid,uuid,text,text,jsonb) to service_role;

comment on table public.assistant_cloud_drafts is 'Private cross-instance draft journal. Server verifies the caller; business mutations always use caller JWT/RLS. No direct client/table grants, raw auth/confirmation/claim credentials, implicit retries or automatic lease recovery.';
notify pgrst,'reload schema';
commit;
