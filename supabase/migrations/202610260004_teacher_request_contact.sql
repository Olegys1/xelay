-- Verification contacts belong to the private application, independently of
-- optional public/group profile contacts. Existing applications stay valid.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $prerequisites$
begin
  if to_regclass('public.teacher_verification_requests') is null
    or to_regclass('public.teacher_academic_profiles') is null
    or to_regprocedure('public.xelay_teacher_request(text,text,text)') is null
    or to_regprocedure('public.xelay_teacher_request_with_academic_profile(text,text,text,jsonb)') is null
    or to_regprocedure('public.xelay_teacher_status()') is null
    or to_regprocedure('public.xelay_teaching_signup_request()') is null
    or exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='teacher_verification_requests' and column_name in('contact_telegram','contact_phone')) then
    raise exception 'TEACHER_REQUEST_CONTACT_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $prerequisites$;

alter table public.teacher_verification_requests
  add column contact_telegram text not null default ''
    check(contact_telegram='' or(contact_telegram~'^[A-Za-z][A-Za-z0-9_]{4,31}$'
      and lower(contact_telegram) not in('joinchat','share','addstickers','addemoji','proxy','socks','login','confirmphone','setlanguage','iv'))),
  add column contact_phone text not null default ''
    check(length(contact_phone)<=40 and(contact_phone='' or
      (contact_phone~'^\+?[0-9 ().-]{6,40}$' and length(regexp_replace(contact_phone,'[^0-9]','','g')) between 7 and 15)));
comment on column public.teacher_verification_requests.contact_telegram is
  'Private verification application snapshot. Owner and MFA administrator only through existing status/review access; never copied to a public teacher profile.';
comment on column public.teacher_verification_requests.contact_phone is
  'Private verification application snapshot. Providing this does not enable group/public profile visibility.';

-- Apply the same invariant below every RPC, without requiring historical blank
-- applications to acquire a contact before an administrator reviews them.
create function public.xelay_private_teacher_request_contact_guard()
returns trigger language plpgsql set search_path='' as $$
declare v_required boolean:=tg_op='INSERT';
begin
  if coalesce(new.contact_telegram,'')~'[[:cntrl:]]' or coalesce(new.contact_phone,'')~'[[:cntrl:]]' then
    raise exception 'TEACHER_REQUEST_CONTACT_INVALID' using errcode='22023';
  end if;
  new.contact_telegram:=regexp_replace(btrim(coalesce(new.contact_telegram,'')),'^@','');
  new.contact_phone:=btrim(coalesce(new.contact_phone,''));
  if (new.contact_telegram<>'' and(new.contact_telegram!~'^[A-Za-z][A-Za-z0-9_]{4,31}$'
      or lower(new.contact_telegram) in('joinchat','share','addstickers','addemoji','proxy','socks','login','confirmphone','setlanguage','iv')))
    or length(new.contact_phone)>40 or(new.contact_phone<>'' and
      (new.contact_phone!~'^\+?[0-9 ().-]{6,40}$' or length(regexp_replace(new.contact_phone,'[^0-9]','','g')) not between 7 and 15)) then
    raise exception 'TEACHER_REQUEST_CONTACT_INVALID' using errcode='22023';
  end if;
  if tg_op='UPDATE' then
    v_required:=row(new.contact_telegram,new.contact_phone) is distinct from row(old.contact_telegram,old.contact_phone)
      or(new.status='pending' and(old.status is distinct from 'pending'
        or row(new.user_id,new.full_name,new.university_id,new.academic_unit_id,new.department,new.position,new.note)
          is distinct from row(old.user_id,old.full_name,old.university_id,old.academic_unit_id,old.department,old.position,old.note)));
  end if;
  if v_required and new.contact_telegram='' and new.contact_phone='' then
    raise exception 'TEACHER_REQUEST_CONTACT_REQUIRED' using errcode='22023';
  end if;
  return new;
end $$;
revoke all on function public.xelay_private_teacher_request_contact_guard() from public,anon,authenticated,service_role;
create trigger teacher_verification_request_contact before insert or update on public.teacher_verification_requests
  for each row execute function public.xelay_private_teacher_request_contact_guard();

-- New contact-bearing overloads have no argument defaults, so PostgREST can
-- select them unambiguously by their explicit contact parameter names.
create function public.xelay_teacher_request(p_department text,p_position text,p_note text,p_contact_telegram text,p_contact_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();
  v_profile public.profiles%rowtype;
  v_request public.teacher_verification_requests%rowtype;
  v_admin record;
  v_telegram text:=regexp_replace(btrim(coalesce(p_contact_telegram,'')),'^@','');
  v_phone text:=btrim(coalesce(p_contact_phone,''));
begin
  -- Validate the supplied contact on every submission, including retries. A
  -- previous snapshot or optional public contact is never silently reused.
  if coalesce(p_contact_telegram,'')~'[[:cntrl:]]' or coalesce(p_contact_phone,'')~'[[:cntrl:]]'
    or(v_telegram<>'' and(v_telegram!~'^[A-Za-z][A-Za-z0-9_]{4,31}$'
      or lower(v_telegram) in('joinchat','share','addstickers','addemoji','proxy','socks','login','confirmphone','setlanguage','iv')))
    or length(v_phone)>40 or(v_phone<>'' and
      (v_phone!~'^\+?[0-9 ().-]{6,40}$' or length(regexp_replace(v_phone,'[^0-9]','','g')) not between 7 and 15)) then
    raise exception 'TEACHER_REQUEST_CONTACT_INVALID' using errcode='22023';
  end if;
  if v_telegram='' and v_phone='' then raise exception 'TEACHER_REQUEST_CONTACT_REQUIRED' using errcode='22023';end if;
  select * into v_profile from public.profiles where id=v_uid;
  if length(btrim(coalesce(p_department,''))) not between 2 and 180 or length(coalesce(p_position,''))>180
    or length(coalesce(p_note,''))>2000 or not exists(select 1 from public.academic_units f join public.universities u on u.id=f.university_id
      where f.id=v_profile.academic_unit_id and u.id=v_profile.university_id and f.is_active and u.is_active) then
    raise exception 'TEACHING_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teacher-request:'||v_uid::text,0));
  select * into v_request from public.teacher_verification_requests where user_id=v_uid for update;
  if found and v_request.status in('pending','approved') and v_request.university_id=v_profile.university_id
    and v_request.academic_unit_id=v_profile.academic_unit_id then return to_jsonb(v_request);end if;
  if found and v_request.status='revoked' then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if found and v_request.status='rejected' and v_request.updated_at>now()-interval '1 day' then raise exception 'TEACHING_REQUEST_COOLDOWN';end if;
  insert into public.teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,note,contact_telegram,contact_phone)
  values(v_uid,v_profile.full_name,v_profile.university_id,v_profile.academic_unit_id,btrim(p_department),btrim(coalesce(p_position,'')),btrim(coalesce(p_note,'')),v_telegram,v_phone)
  on conflict(user_id) do update set full_name=excluded.full_name,university_id=excluded.university_id,academic_unit_id=excluded.academic_unit_id,
    department=excluded.department,position=excluded.position,note=excluded.note,contact_telegram=excluded.contact_telegram,contact_phone=excluded.contact_phone,
    status='pending',review_reason='',reviewed_by=null,reviewed_at=null,updated_at=now()
  returning * into v_request;
  for v_admin in select distinct user_id from public.user_roles where role='ADMIN' loop
    perform public.xelay_teaching_notify(v_admin.user_id,'teacher-request:'||v_request.id::text||':'||v_request.updated_at::text,
      'Нова заявка на підтвердження викладача: '||v_profile.full_name);
  end loop;
  return to_jsonb(v_request);
end $$;
revoke all on function public.xelay_teacher_request(text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_request(text,text,text,text,text) to authenticated;

create function public.xelay_teacher_request_with_academic_profile(p_department text,p_position text,p_note text,p_profile jsonb,p_contact_telegram text,p_contact_phone text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb;
begin
  v_result:=public.xelay_teacher_request(p_department,p_position,p_note,p_contact_telegram,p_contact_phone);
  perform public.xelay_teacher_academic_profile_save(p_profile);
  return v_result;
end $$;
revoke all on function public.xelay_teacher_request_with_academic_profile(text,text,text,jsonb,text,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_request_with_academic_profile(text,text,text,jsonb,text,text) to authenticated;

-- Preserve the legacy signature and grants, but cached/API callers must supply
-- a contact explicitly through the new overload. The old academic wrapper also
-- delegates here, so it cannot create or resubmit a contactless application.
create or replace function public.xelay_teacher_request(p_department text,p_position text default '',p_note text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform public.xelay_teaching_assert_user();
  raise exception 'TEACHER_REQUEST_CONTACT_REQUIRED' using errcode='22023';
end $$;

-- Registration remains possible without a contact. An application is now an
-- explicit authenticated action; do not create a contactless pending row from
-- mutable auth metadata or place private verification contacts in that metadata.
create or replace function public.xelay_teaching_signup_request()
returns trigger language plpgsql security definer set search_path='' as $$
begin return new;end $$;

-- Existing owner/admin status JSON already serializes the private request row.
-- Public/group teacher projections use explicit fields and remain unchanged.
notify pgrst,'reload schema';
commit;
