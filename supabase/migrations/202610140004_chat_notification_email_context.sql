-- Chat tables intentionally deny direct service-role SELECT. A worker may
-- inspect only the eligibility of its own leased email event, never chat data.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regclass('public.notification_email_outbox') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.chat_spaces') is null
    or to_regclass('public.chat_members') is null
    or to_regclass('public.chat_invitations') is null
    or to_regclass('public.chat_join_requests') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.universities') is null
    or to_regclass('public.academic_units') is null
    or to_regprocedure('public.xelay_claim_notification_email(uuid)') is null
    or not exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='chat_spaces' and column_name='system_kind')
    or exists(select 1 from pg_catalog.pg_class c where c.oid in(
      to_regclass('public.notification_email_outbox'),to_regclass('public.notifications'),
      to_regclass('public.chat_spaces'),to_regclass('public.chat_members'),
      to_regclass('public.chat_invitations'),to_regclass('public.chat_join_requests')) and not c.relrowsecurity) then
    raise exception 'Apply private community/faculty chats and notification email leases before chat email context';
  end if;
end $$;

create or replace function public.xelay_chat_notification_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.notification_email_outbox%rowtype;
  v_notification public.notifications%rowtype;
  v_space public.chat_spaces%rowtype;
  v_member public.chat_members%rowtype;
  v_invitation public.chat_invitations%rowtype;
  v_request public.chat_join_requests%rowtype;
  v_path text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  select * into v_job from public.notification_email_outbox q where q.id=p_job_id
    and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp();
  if not found then return jsonb_build_object('eligible',false,'reason','lease_lost','path',null); end if;
  if left(v_job.notification_type,5)<>'chat_' then
    return jsonb_build_object('eligible',false,'reason','chat_context_missing','path',null); end if;
  select * into v_notification from public.notifications n where n.id::text=v_job.notification_id;
  if not found then return jsonb_build_object('eligible',false,'reason','notification_removed','path',null); end if;
  if v_notification.type is distinct from v_job.notification_type
    or v_notification.recipient_id::text is distinct from v_job.recipient_id::text
    or v_notification.actor_id::text is distinct from v_job.actor_id::text
    or v_notification.chat_space_id is null then
    return jsonb_build_object('eligible',false,'reason','chat_context_mismatch','path',null); end if;
  select * into v_space from public.chat_spaces s where s.id=v_notification.chat_space_id;
  if not found then return jsonb_build_object('eligible',false,'reason','chat_unavailable','path',null); end if;
  v_path:='/messages?space='||v_space.id::text;
  select * into v_member from public.chat_members m where m.space_id=v_space.id and m.user_id=v_job.recipient_id;
  if coalesce(v_member.muted,false) then
    return jsonb_build_object('eligible',false,'reason','chat_muted','path',null); end if;
  if v_member.status='banned' then
    return jsonb_build_object('eligible',false,'reason','chat_access_removed','path',null); end if;

  if v_notification.type='chat_invite' then
    -- System faculty groups cannot invite users. Ordinary invitations need the
    -- exact target/inviter; accepting before cron is not a read cancellation.
    if v_space.system_kind is not null then
      return jsonb_build_object('eligible',false,'reason','chat_unavailable','path',null); end if;
    select * into v_invitation from public.chat_invitations i where i.space_id=v_space.id
      and i.user_id=v_job.recipient_id and i.invited_by=v_job.actor_id;
    if not found or not coalesce(v_invitation.status='pending'
      or(v_invitation.status='accepted' and v_member.status='active'),false) then
      return jsonb_build_object('eligible',false,'reason','chat_invitation_unavailable','path',null); end if;
    return jsonb_build_object('eligible',true,'reason','eligible','path',v_path);
  end if;

  if v_member.status is distinct from 'active' then
    return jsonb_build_object('eligible',false,'reason','chat_access_removed','path',null); end if;
  if v_space.system_kind is not null and(v_space.system_kind<>'faculty' or not exists(
    select 1 from public.profiles p
      join public.universities u on u.id=v_space.university_id and u.is_active
      join public.academic_units a on a.id=v_space.academic_unit_id
        and a.university_id=v_space.university_id and a.is_active
      where p.id=v_job.recipient_id and p.university_id=v_space.university_id
        and p.academic_unit_id=v_space.academic_unit_id)) then
    return jsonb_build_object('eligible',false,'reason','chat_faculty_scope_removed','path',null); end if;

  if v_notification.type='chat_join_request' then
    if v_member.role not in('owner','admin') or v_job.actor_id is null then
      return jsonb_build_object('eligible',false,'reason','chat_moderator_required','path',null); end if;
    select * into v_request from public.chat_join_requests r where r.space_id=v_space.id and r.user_id=v_job.actor_id;
    if not found or v_request.status not in('pending','accepted','rejected') then
      return jsonb_build_object('eligible',false,'reason','chat_join_request_unavailable','path',null); end if;
  elsif v_notification.type='chat_join_approved' then
    if not exists(select 1 from public.chat_join_requests r where r.space_id=v_space.id
      and r.user_id=v_job.recipient_id and r.status='accepted') then
      return jsonb_build_object('eligible',false,'reason','chat_join_request_unavailable','path',null); end if;
  end if;
  -- Existing/future chat message/comment notices need current membership only.
  -- Neither reading the notification nor processing a valid request suppresses
  -- its independent email. No post, title, name, file or email is returned.
  return jsonb_build_object('eligible',true,'reason','eligible','path',v_path);
end $$;
revoke all on function public.xelay_chat_notification_email_context(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_chat_notification_email_context(uuid,uuid) to service_role;

comment on function public.xelay_chat_notification_email_context(uuid,uuid) is
  'Service-only eligibility metadata for exactly one live leased chat email event. Rechecks recipient/actor/type, current unmuted membership, invitation/request identity and active faculty scope. No private table grants, chat bodies, names, attachments, member lists or addresses are exposed.';
notify pgrst,'reload schema';
commit;
