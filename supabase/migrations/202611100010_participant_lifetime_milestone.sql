-- Install support for one audited award. Installing this migration grants nothing.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create function public.xelay_private_lifetime_uses_demo_scope()
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare
  demo_actor regprocedure := to_regprocedure('xelay_demo_private.is_actor(uuid)');
  counter_source text;
begin
  select lower(btrim(regexp_replace(prosrc, '\s+', ' ', 'g'))) into counter_source
  from pg_proc where oid = 'public.xelay_member_count()'::regprocedure;
  if demo_actor is not null and position('not xelay_demo_private.is_actor(' in counter_source) > 0 then
    return true;
  end if;
  if demo_actor is null and counter_source = 'select count(*) from public.profiles;' then
    return false;
  end if;
  raise exception 'PARTICIPANT_LIFETIME_COUNTER_SCOPE_CHANGED';
end;
$$;
revoke all on function public.xelay_private_lifetime_uses_demo_scope() from public, anon, authenticated, service_role;
do $preflight$
begin
  perform public.xelay_private_lifetime_uses_demo_scope();
end $preflight$;

create table public.participant_lifetime_awards (
  milestone integer primary key check (milestone = 1000),
  recipient_id uuid unique references public.profiles(id) on delete set null,
  granted_by uuid references public.profiles(id) on delete set null,
  notification_id uuid unique references public.notifications(id) on delete set null,
  granted_at timestamptz not null,
  revoked_at timestamptz
);
alter table public.participant_lifetime_awards enable row level security;
revoke all on public.participant_lifetime_awards from public, anon, authenticated, service_role;

create function public.xelay_private_participant_lifetime(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.participant_lifetime_awards
    where recipient_id = p_user_id and revoked_at is null
  );
$$;
revoke all on function public.xelay_private_participant_lifetime(uuid) from public, anon, authenticated, service_role;

-- Preserve function identities, grants, and all existing billing branches.
do $billing$
declare
  patch record;
  definition text;
begin
  for patch in select * from (values
    ('public.xelay_has_participant_access(uuid)',
      $old$and e.valid_from <= now() and e.valid_until > now());$old$,
      $new$and e.valid_from <= now() and e.valid_until > now())
    or public.xelay_private_participant_lifetime(p_user_id);$new$),
    ('public.xelay_billing_status()',
      $old$'is_premium',v_premium,'expires_at',v_expiry,$old$,
      $new$'is_premium',v_premium,'is_lifetime',public.xelay_private_participant_lifetime(auth.uid()),
    'expires_at',case when public.xelay_private_participant_lifetime(auth.uid()) then null else v_expiry end,$new$),
    ('public.xelay_create_billing_order(uuid,text,text,text,uuid)',
      $old$perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:' || p_user_id::text,0));$old$,
      $new$perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:' || p_user_id::text,0));
  if public.xelay_private_participant_lifetime(p_user_id) then
    raise exception 'PARTICIPANT_LIFETIME_ACCESS' using errcode='22023';
  end if;$new$),
    -- Unknown event types otherwise use the general email queue.
    ('public.xelay_queue_notification_email()',
      $old$if new.recipient_id is null or nullif(btrim(new.type),'') is null then return new; end if;$old$,
      $new$if new.type = 'participant_lifetime_award' then return new; end if;
  if new.recipient_id is null or nullif(btrim(new.type),'') is null then return new; end if;$new$)
  ) as patches(signature, original, replacement)
  loop
    definition := replace(pg_get_functiondef(to_regprocedure(patch.signature)), chr(13), '');
    if definition is null or cardinality(string_to_array(definition, patch.original)) <> 2 then
      raise exception 'PARTICIPANT_LIFETIME_BILLING_DRIFT: %', patch.signature;
    end if;
    execute replace(definition, patch.original, patch.replacement);
  end loop;
end $billing$;

create policy "Lifetime award notifications server insert" on public.notifications
  as restrictive for insert to anon, authenticated
  with check (type is distinct from 'participant_lifetime_award');

create function public.xelay_guard_lifetime_award_notification_update()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (old.type = 'participant_lifetime_award' and (to_jsonb(new) - 'is_read') is distinct from (to_jsonb(old) - 'is_read'))
    or (old.type is distinct from 'participant_lifetime_award' and new.type = 'participant_lifetime_award') then
    raise exception 'PARTICIPANT_LIFETIME_NOTICE_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.xelay_guard_lifetime_award_notification_update() from public, anon, authenticated, service_role;
create trigger notification_lifetime_award_update_guard before update on public.notifications
  for each row execute function public.xelay_guard_lifetime_award_notification_update();

create function public.xelay_admin_grant_lifetime_milestone(p_user_id uuid, p_expected_actor_id uuid)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor_id uuid := auth.uid();
  awarded_to uuid;
  award_revoked_at timestamptz;
  candidate_id uuid;
  candidate_at timestamptz;
  candidate_ties bigint;
  visible_count bigint;
  visible_predicate text;
  notice_id uuid;
  awarded_at timestamptz;
begin
  if actor_id is null or actor_id is distinct from p_expected_actor_id or not public.xelay_is_platform_admin()
    or coalesce(auth.jwt()->>'aal','') <> 'aal2'
    or not exists (select 1 from auth.mfa_factors f where f.user_id = actor_id and f.status = 'verified')
    or not exists (select 1 from auth.users u where u.id = actor_id and u.deleted_at is null
      and coalesce(u.banned_until,'-infinity'::timestamptz) <= clock_timestamp()) then
    raise exception 'PARTICIPANT_LIFETIME_ADMIN_MFA_REQUIRED' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('xelay:participant-lifetime:1000',0));
  select recipient_id, revoked_at into awarded_to, award_revoked_at
  from public.participant_lifetime_awards where milestone = 1000;
  if found then
    if p_user_id is null or awarded_to is distinct from p_user_id or award_revoked_at is not null then
      raise exception 'PARTICIPANT_LIFETIME_ALREADY_AWARDED';
    end if;
    return jsonb_build_object('granted',true,'already_granted',true);
  end if;

  if p_user_id is null or not exists (select 1 from public.profiles p join auth.users u on u.id = p.id
    where p.id = p_user_id and u.deleted_at is null and u.email_confirmed_at is not null
      and coalesce(u.banned_until,'-infinity'::timestamptz) <= clock_timestamp()) then
    raise exception 'PARTICIPANT_LIFETIME_ACCOUNT_UNAVAILABLE' using errcode = '42501';
  end if;

  visible_predicate := case when public.xelay_private_lifetime_uses_demo_scope()
    then 'not xelay_demo_private.is_actor(p.id)' else 'true' end;
  execute format($rank$
  with visible as (
    select p.id, greatest(p.created_at, g.completed_at) as profile_added_at
    from public.profiles p left join public.xelay_google_registrations g on g.user_id = p.id
    where %s
  ), ranked as (
    select id, profile_added_at,
      row_number() over (order by profile_added_at nulls first, id) as position,
      count(*) over (partition by profile_added_at) as ties,
      count(*) over () as total
    from visible
  )
  select id, profile_added_at, ties, total from ranked where position = 1000
  $rank$, visible_predicate) into candidate_id, candidate_at, candidate_ties, visible_count;
  if candidate_id is distinct from p_user_id or candidate_at is null or candidate_ties <> 1
    or visible_count is distinct from public.xelay_member_count() then
    raise exception 'PARTICIPANT_LIFETIME_MILESTONE_CHANGED' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('xelay:checkout:' || p_user_id::text,0));
  if exists (select 1 from public.billing_orders
    where user_id = p_user_id and product = 'participant' and mode = 'live' and status = 'pending'
      and created_at > clock_timestamp() - interval '1 hour') then
    raise exception 'PARTICIPANT_LIFETIME_CHECKOUT_PENDING' using errcode = '22023';
  end if;

  awarded_at := clock_timestamp();
  insert into public.notifications(recipient_id, actor_id, actor_name, type, message, is_read, created_at)
  values (p_user_id, actor_id, 'Xelay', 'participant_lifetime_award',
    'Вітаємо! Ваш профіль став тисячним у Xelay 🎉 Дякуємо, що долучилися до нашої спільноти. Даруємо вам безстрокову підписку «Учасник». Вона вже активна.',
    false, awarded_at)
  returning id into notice_id;
  insert into public.participant_lifetime_awards(milestone, recipient_id, granted_by, notification_id, granted_at)
    values (1000, p_user_id, actor_id, notice_id, awarded_at);
  insert into public.billing_audit_log(actor_id, action, target_user_id, detail)
    values (actor_id, 'grant_participant_lifetime', p_user_id, jsonb_build_object('milestone',1000,'notification_id',notice_id));
  return jsonb_build_object('granted',true,'already_granted',false);
end;
$$;

revoke all on function public.xelay_admin_grant_lifetime_milestone(uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.xelay_admin_grant_lifetime_milestone(uuid,uuid) to authenticated;

commit;
