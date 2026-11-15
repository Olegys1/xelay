-- Editing never changes an issued definition. A hidden, validated draft becomes
-- either a settings publication or a new immutable member of the same family.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table public.teaching_test_publication_families(
  id uuid primary key references public.teaching_tests(id) on delete restrict,
  current_test_id uuid not null references public.teaching_tests(id) on delete restrict,
  revision integer not null default 1 check(revision>0)
);
create table public.teaching_test_publication_members(
  test_id uuid primary key references public.teaching_tests(id) on delete restrict,
  family_id uuid not null references public.teaching_test_publication_families(id) on delete cascade,
  revision integer not null check(revision>0),unique(family_id,revision)
);
create table public.teaching_test_publication_drafts(
  test_id uuid primary key references public.teaching_tests(id) on delete cascade,
  draft_test_id uuid not null unique references public.teaching_tests(id) on delete cascade,
  version integer not null check(version>0),base_version integer not null,
  saved_at timestamptz not null default clock_timestamp(),saved_by uuid not null references public.profiles(id)
);
create table public.teaching_test_publication_history(
  family_id uuid not null references public.teaching_test_publication_families(id),revision integer not null,
  test_id uuid not null references public.teaching_tests(id),definition jsonb not null,
  created_at timestamptz not null default clock_timestamp(),created_by uuid not null references public.profiles(id),
  primary key(family_id,revision)
);
create table public.teaching_test_republish_receipts(
  request_id uuid primary key,actor_id uuid not null references public.profiles(id),
  source_test_id uuid not null references public.teaching_tests(id),published_test_id uuid not null references public.teaching_tests(id),
  request_hash text not null,result jsonb not null,created_at timestamptz not null default clock_timestamp()
);
alter table public.teaching_test_publication_families enable row level security;
alter table public.teaching_test_publication_members enable row level security;
alter table public.teaching_test_publication_drafts enable row level security;
alter table public.teaching_test_publication_history enable row level security;
alter table public.teaching_test_republish_receipts enable row level security;
revoke all on public.teaching_test_publication_families,public.teaching_test_publication_members,
  public.teaching_test_publication_drafts,public.teaching_test_publication_history,public.teaching_test_republish_receipts
  from public,anon,authenticated,service_role;

create function public.xelay_private_publication_family(p_test uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select m.family_id from public.teaching_test_publication_members m where m.test_id=p_test
  union all select m.family_id from public.teaching_test_retake_grants g
    join public.teaching_test_publication_members m on m.test_id=g.parent_test_id where g.child_test_id=p_test limit 1;
$$;
create function public.xelay_private_publication_tests(p_test uuid)
returns setof uuid language sql stable security definer set search_path='' as $$
  with roots as(select m.test_id from public.teaching_test_publication_members m
    where m.family_id=public.xelay_private_publication_family(p_test)
    union select p_test where public.xelay_private_publication_family(p_test) is null)
  select test_id from roots union select g.child_test_id from public.teaching_test_retake_grants g join roots r on r.test_id=g.parent_test_id;
$$;
create function public.xelay_private_publication_editor(p_test public.teaching_tests,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select p_test.status<>'draft' and not p_test.qa_own_attempt
    and not exists(select 1 from public.teaching_test_retake_grants where child_test_id=p_test.id)
    and public.xelay_private_test_staff(p_test,p_user,'assignments',true)
    and public.xelay_private_test_staff(p_test,p_user,'grades',true);
$$;
create function public.xelay_private_publication_definition(p_test uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select to_jsonb(t)||jsonb_build_object('variants',coalesce((select variants from public.teaching_test_manual_variants where test_id=t.id),'[]'::jsonb),
    'base_variant_title',coalesce((select base_title from public.teaching_test_variant_labels where test_id=t.id),'Варіант 1'))
  from public.teaching_tests t where t.id=p_test;
$$;
create function public.xelay_private_publication_shape(p_test uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_object_agg(key,value) from jsonb_each(public.xelay_private_publication_definition(p_test))
  where key=any(array['course_id','title','max_points','category','journal_date','work_type','allow_skip','allow_return',
    'question_timer_policy','restrict_copy','bonus_percent','bonus_points','targets','questions','shuffle_questions',
    'shuffle_answers','draw_count','overrides','require_access_code','restrict_tab_switch','discourage_capture',
    'allow_external_links','qa_own_attempt','variants','base_variant_title']);
$$;
create function public.xelay_private_publication_candidates(p_test uuid,p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with current_test as(select * from public.teaching_tests where id=coalesce(
    (select draft_test_id from public.teaching_test_publication_drafts where test_id=p_test),p_test)), latest as(
    select distinct on(a.user_id) a.* from public.teaching_test_attempts a
    where a.test_id in(select public.xelay_private_publication_tests(p_test)) order by a.user_id,a.started_at desc,a.id desc
  ), candidates as(select a.*,p.full_name,
    case when a.status='in_progress' then 'active'
      when exists(select 1 from public.teaching_test_retake_grants g join public.teaching_tests child on child.id=g.child_test_id
        where g.parent_test_id in(select public.xelay_private_publication_tests(p_test)) and g.user_id=a.user_id
          and g.revoked_at is null and child.closes_at>statement_timestamp()
          and not exists(select 1 from public.teaching_test_attempts ca where ca.test_id=g.child_test_id)) then 'pending_retake'
      when public.xelay_private_test_allows_before_modules_20261104(t,a.user_id,a.group_id) is not true
        or(public.xelay_private_test_admission(t,a.user_id)->>'allowed')::boolean is not true then 'not_admitted' end reason
    from latest a join public.profiles p on p.id=a.user_id cross join current_test t
    where 'grades'=any(public.xelay_teaching_group_permissions(t.course_id,a.group_id,p_user))
      and 'assignments'=any(public.xelay_teaching_group_permissions(t.course_id,a.group_id,p_user)))
  select coalesce(jsonb_agg(jsonb_build_object('user_id',user_id,'group_id',group_id,'student_name',full_name,
    'source_attempt_id',id,'started_at',started_at,'expires_at',expires_at,'status',status,
    'eligible',reason is null,'reason',reason) order by full_name,user_id),'[]'::jsonb) from candidates;
$$;

alter function public.xelay_private_test_allows(public.teaching_tests,uuid,uuid) rename to xelay_private_test_allows_before_publication_20261114;
create function public.xelay_private_test_allows(p_test public.teaching_tests,p_user uuid,p_group uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_test_allows_before_publication_20261114(p_test,p_user,p_group)
    and case when public.xelay_private_publication_family(p_test.id) is null then true
      when exists(select 1 from public.teaching_test_retake_grants where child_test_id=p_test.id) then true
      when exists(select 1 from public.teaching_test_attempts where test_id=p_test.id and user_id=p_user
        and(p_group is null or group_id=p_group)) then true
      else p_test.id=(select current_test_id from public.teaching_test_publication_families
          where id=public.xelay_private_publication_family(p_test.id))
        and not exists(select 1 from public.teaching_test_attempts a
          where a.user_id=p_user and a.test_id in(select public.xelay_private_publication_tests(p_test.id)))
        and public.xelay_private_module_resource_gate('test',public.xelay_private_publication_family(p_test.id),p_user,p_group) end;
$$;

create function public.xelay_private_publication_preferred(p_test uuid,p_user uuid,p_group uuid default null)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare selected uuid;family uuid:=public.xelay_private_publication_family(p_test);
begin
  if family is null then return p_test;end if;
  select a.test_id into selected from public.teaching_test_attempts a join public.teaching_tests t on t.id=a.test_id
    where a.user_id=p_user and a.status='in_progress' and a.test_id in(select public.xelay_private_publication_tests(p_test))
      and(p_group is null or a.group_id=p_group) and public.xelay_private_test_allows(t,p_user,a.group_id)
    order by a.started_at desc,a.id desc limit 1;
  if selected is not null then return selected;end if;
  select g.child_test_id into selected from public.teaching_test_retake_grants g join public.teaching_tests t on t.id=g.child_test_id
    where g.parent_test_id in(select public.xelay_private_publication_tests(p_test)) and g.user_id=p_user and g.revoked_at is null
      and t.closes_at>statement_timestamp() and(p_group is null or g.group_id=p_group)
      and not exists(select 1 from public.teaching_test_attempts where test_id=t.id)
      and public.xelay_private_test_allows(t,p_user,g.group_id) order by g.created_at desc,g.id desc limit 1;
  if selected is not null then return selected;end if;
  select a.test_id into selected from public.teaching_test_attempts a join public.teaching_tests t on t.id=a.test_id
    where a.user_id=p_user and a.test_id in(select public.xelay_private_publication_tests(p_test))
      and(p_group is null or a.group_id=p_group) and public.xelay_private_test_allows(t,p_user,a.group_id)
    order by a.started_at desc,a.id desc limit 1;
  return coalesce(selected,(select current_test_id from public.teaching_test_publication_families where id=family));
end $$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean) rename to xelay_private_test_view_before_publication_20261114;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;family uuid:=public.xelay_private_publication_family(p_test.id);draft public.teaching_test_publication_drafts%rowtype;
begin
  result:=public.xelay_private_test_view_before_publication_20261114(p_test,p_user,p_full)
    ||jsonb_build_object('can_republish',public.xelay_private_publication_editor(p_test,p_user)
      and(family is null or p_test.id=(select current_test_id from public.teaching_test_publication_families where id=family)));
  if family is not null then
    result:=result||jsonb_build_object('publication_family_id',family,'publication_revision',
      coalesce((select case when f.current_test_id=p_test.id then f.revision else m.revision end
        from public.teaching_test_publication_members m join public.teaching_test_publication_families f on f.id=m.family_id where m.test_id=p_test.id),
        (select m.revision from public.teaching_test_retake_grants g join public.teaching_test_publication_members m on m.test_id=g.parent_test_id where g.child_test_id=p_test.id)),
      'current_publication_id',(select current_test_id from public.teaching_test_publication_families where id=family),
      -- Resolve old URLs before a client chooses live student detail versus a
      -- teacher rehearsal. Peer private opportunities are never aliases.
      'publication_alias_ids',(select coalesce(jsonb_agg(alias.id order by alias.id),'[]'::jsonb) from(
        select m.test_id id from public.teaching_test_publication_members m where m.family_id=family
        union select g.child_test_id from public.teaching_test_retake_grants g
          join public.teaching_test_publication_members m on m.test_id=g.parent_test_id
          where m.family_id=family and g.user_id=p_user and g.revoked_at is null) alias));
    if p_full then result:=result||jsonb_build_object('previous_revisions',(select coalesce(jsonb_agg(jsonb_build_object(
      'id',t.id,'revision',h.revision,'title',h.definition->'title','status',h.definition->'status','max_points',h.definition->'max_points','opens_at',h.definition->'opens_at',
      'closes_at',h.definition->'closes_at','created_at',h.created_at,'attempts',(select count(*) from public.teaching_test_attempts where test_id=t.id))
      order by h.revision desc),'[]'::jsonb) from public.teaching_test_publication_history h join public.teaching_tests t on t.id=h.test_id
      where h.family_id=family and h.revision<(select revision from public.teaching_test_publication_families where id=family)
        and(public.xelay_private_test_staff(t,p_user,'assignments') or public.xelay_private_test_staff(t,p_user,'grades'))));end if;
  end if;
  if public.xelay_private_publication_editor(p_test,p_user) then
    select * into draft from public.teaching_test_publication_drafts where test_id=p_test.id;
    if found then result:=result||jsonb_build_object('publication_draft',jsonb_build_object('version',draft.version,
      'base_version',draft.base_version,'saved_at',draft.saved_at,
      'change_kind',case when public.xelay_private_publication_shape(p_test.id)=public.xelay_private_publication_shape(draft.draft_test_id)
        and p_test.results_finalized_at is null then 'settings' else 'definition' end,
      'definition',public.xelay_private_publication_definition(draft.draft_test_id)||jsonb_build_object('id',p_test.id,'version',draft.base_version,'status','published')));end if;
  end if;
  return result;
end $$;

alter function public.xelay_teaching_tests(uuid,uuid) rename to xelay_private_tests_before_publication_20261114;
create function public.xelay_teaching_tests(p_course_id uuid default null,p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare uid uuid:=public.xelay_teaching_assert_user();result jsonb;
begin
  result:=public.xelay_private_tests_before_publication_20261114(p_course_id,p_group_id);
  return jsonb_set(result,'{tests}',coalesce((select jsonb_agg(item) from jsonb_array_elements(result->'tests')item
    join public.teaching_tests t on t.id=(item->>'id')::uuid
    where not exists(select 1 from public.teaching_test_publication_drafts where draft_test_id=t.id)
      and(public.xelay_private_publication_family(t.id) is null or t.id=case
        when public.xelay_private_test_staff(t,uid,'assignments') or public.xelay_private_test_staff(t,uid,'grades')
          then(select current_test_id from public.teaching_test_publication_families where id=public.xelay_private_publication_family(t.id))
        else public.xelay_private_publication_preferred(t.id,uid,p_group_id) end)),'[]'::jsonb));
end $$;

alter function public.xelay_teaching_test(uuid) rename to xelay_private_test_detail_before_publication_20261114;
create function public.xelay_teaching_test(p_test_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare uid uuid:=public.xelay_teaching_assert_user();selected uuid:=p_test_id;result jsonb;t public.teaching_tests%rowtype;
begin
  select * into t from public.teaching_tests where id=p_test_id;
  if exists(select 1 from public.teaching_test_retake_grants where child_test_id=p_test_id and user_id<>uid)
    and not(public.xelay_private_test_staff(t,uid,'assignments') or public.xelay_private_test_staff(t,uid,'grades')) then
    raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if exists(select 1 from public.teaching_test_publication_drafts d join public.teaching_tests source on source.id=d.test_id
    where d.draft_test_id=p_test_id and not public.xelay_private_publication_editor(source,uid)) then
    raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if not(public.xelay_private_test_staff(t,uid,'assignments') or public.xelay_private_test_staff(t,uid,'grades')) then
    selected:=public.xelay_private_publication_preferred(p_test_id,uid);end if;
  result:=public.xelay_private_test_detail_before_publication_20261114(selected);
  select * into t from public.teaching_tests where id=selected;
  if public.xelay_private_publication_family(selected) is not null then
    result:=result||jsonb_build_object('attempt_history',(select coalesce(jsonb_agg(public.xelay_private_test_retake_history(a,old_test,
      'grades'=any(public.xelay_teaching_group_permissions(old_test.course_id,a.group_id,uid))) order by a.started_at,a.id),'[]'::jsonb)
      from public.teaching_test_attempts a join public.teaching_tests old_test on old_test.id=a.test_id
      where a.test_id in(select public.xelay_private_publication_tests(selected))
        and(a.user_id=uid and public.xelay_private_test_allows_before_modules_20261104(old_test,uid,a.group_id)
          or 'grades'=any(public.xelay_teaching_group_permissions(old_test.course_id,a.group_id,uid)))));
  end if;
  if public.xelay_private_publication_editor(t,uid) then
    result:=result||jsonb_build_object('republish_candidates',public.xelay_private_publication_candidates(t.id,uid));end if;
  return result;
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_publication_20261114;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
#variable_conflict use_variable
declare uid uuid:=public.xelay_teaching_assert_user();id uuid;family uuid;selected uuid;request uuid;
  t public.teaching_tests%rowtype;staged public.teaching_tests%rowtype;draft public.teaching_test_publication_drafts%rowtype;
  receipt public.teaching_test_republish_receipts%rowtype;attempt public.teaching_test_attempts%rowtype;
  item record;candidate jsonb;definition jsonb;payload jsonb;result jsonb;operation jsonb;candidates jsonb;
  change_kind text;policy text;current_revision integer;new_version integer;new_id uuid;
  created integer:=0;extended integer:=0;skipped_active integer:=0;skipped_pending integer:=0;skipped_ineligible integer:=0;
  before_columns integer;after_columns integer;same_scale boolean:=true;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'TEST_INVALID_INPUT';end if;
  id:=(p_payload->>'id')::uuid;
  if id is null then raise exception 'TEST_INVALID_INPUT';end if;
  if p_action not in('save_published_draft','discard_published_draft','republish_test') then
    if p_action='save_test' and exists(select 1 from public.teaching_tests existing where existing.id=id
      and(existing.status<>'draft' and public.xelay_private_publication_family(id) is not null
        or exists(select 1 from public.teaching_test_publication_drafts where draft_test_id=id))) then
      raise exception 'TEST_IMMUTABLE';end if;
    payload:=p_payload;
    if p_action in('start','save_answer','navigate','finish','record_tab_exit') and public.xelay_private_publication_family(id) is not null then
      if exists(select 1 from public.teaching_test_retake_grants where child_test_id=id and user_id<>uid) then
        raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
      if p_payload?'attempt_id' then
        select * into attempt from public.teaching_test_attempts where teaching_test_attempts.id=(p_payload->>'attempt_id')::uuid and user_id=uid;
        if not found or attempt.test_id not in(select public.xelay_private_publication_tests(id)) then raise exception 'TEST_ATTEMPT_CHANGED';end if;
        selected:=attempt.test_id;
      elsif p_action='start' then selected:=public.xelay_private_publication_preferred(id,uid,(p_payload->>'group_id')::uuid);
      else
        -- An old cached tab without an attempt binding may not address a new
        -- opportunity merely because its logical family URL is still valid.
        selected:=id;
        if public.xelay_private_publication_preferred(id,uid,(p_payload->>'group_id')::uuid) is distinct from id then
          raise exception 'TEST_ATTEMPT_CHANGED';end if;
      end if;
      payload:=jsonb_set(payload,'{id}',to_jsonb(selected));
    end if;
    return public.xelay_private_test_mutate_before_publication_20261114(p_action,payload);
  end if;
  if p_payload->>'expected_user_id' is distinct from uid::text then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if octet_length(p_payload::text)>600000 or jsonb_typeof(p_payload->'version') is distinct from 'number'
    or jsonb_typeof(p_payload->'draft_version') is distinct from 'number' then raise exception 'TEST_INVALID_INPUT';end if;
  family:=coalesce(public.xelay_private_publication_family(id),id);
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-publication:'||family,0));
  for item in select value as id from public.xelay_private_publication_tests(id) value order by value loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||item.id,0));
  end loop;
  select * into t from public.teaching_tests where teaching_tests.id=id for update;
  if not found or not public.xelay_private_publication_editor(t,uid) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if p_action='republish_test' then
    request:=(p_payload->>'request_id')::uuid;
    if request is null then raise exception 'TEST_INVALID_INPUT';end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:test-republish-request:'||request,0));
    select * into receipt from public.teaching_test_republish_receipts where request_id=request;
    if found then
      if receipt.actor_id<>uid or receipt.source_test_id<>id or receipt.request_hash<>md5(p_payload::text) then raise exception 'TEST_CONFLICT';end if;
      return public.xelay_teaching_test(receipt.published_test_id)||jsonb_build_object('republish_result',receipt.result);
    end if;
  end if;
  if t.version::numeric is distinct from(p_payload->>'version')::numeric
    or exists(select 1 from public.teaching_test_publication_families where teaching_test_publication_families.id=family and current_test_id<>id)
    then raise exception 'TEST_DRAFT_CONFLICT';end if;
  select * into draft from public.teaching_test_publication_drafts where test_id=id for update;
  if coalesce(draft.version,0)::numeric is distinct from(p_payload->>'draft_version')::numeric
    or p_action<>'discard_published_draft' and draft.test_id is not null and draft.base_version<>t.version then raise exception 'TEST_DRAFT_CONFLICT';end if;
  if p_action='save_published_draft' then
    if exists(select 1 from jsonb_object_keys(p_payload) key where key not in('id','version','expected_user_id','draft_version','definition'))
      or jsonb_typeof(p_payload->'definition') is distinct from 'object' then raise exception 'TEST_INVALID_INPUT';end if;
    new_id:=coalesce(draft.draft_test_id,gen_random_uuid());
    select * into staged from public.teaching_tests where teaching_tests.id=new_id;
    payload:=public.xelay_private_publication_save_payload(p_payload->'definition',new_id,coalesce(staged.version,0),t.course_id,uid,'draft');
    result:=public.xelay_private_test_mutate_before_publication_20261114('save_test',payload);
    insert into public.teaching_test_publication_drafts(test_id,draft_test_id,version,base_version,saved_by)
      values(id,new_id,1,t.version,uid) on conflict(test_id) do update set version=teaching_test_publication_drafts.version+1,
        base_version=t.version,saved_at=clock_timestamp(),saved_by=uid;
    return public.xelay_teaching_test(id);
  end if;
  if draft.test_id is null then raise exception 'TEST_DRAFT_CONFLICT';end if;
  if p_action='discard_published_draft' then
    if exists(select 1 from jsonb_object_keys(p_payload) key where key not in('id','version','expected_user_id','draft_version')) then raise exception 'TEST_INVALID_INPUT';end if;
    delete from public.teaching_test_publication_drafts where test_id=id;
    delete from public.teaching_tests where teaching_tests.id=draft.draft_test_id;
    return public.xelay_teaching_test(id);
  end if;
  if exists(select 1 from jsonb_object_keys(p_payload) key where key not in('id','version','expected_user_id','draft_version','request_id',
    'confirm_republish','reset_policy','selected_attempt_ids','extend_active_attempts'))
    or p_payload->'confirm_republish' is distinct from 'true'::jsonb
    or jsonb_typeof(p_payload->'extend_active_attempts') is distinct from 'boolean' then raise exception 'TEST_REPUBLISH_CONFIRM_REQUIRED';end if;
  policy:=p_payload->>'reset_policy';
  if policy not in('keep','all_completed','selected_completed') or policy is null then raise exception 'TEST_INVALID_INPUT';end if;
  if policy='selected_completed' and(jsonb_typeof(p_payload->'selected_attempt_ids') is distinct from 'array'
    or jsonb_array_length(p_payload->'selected_attempt_ids') not between 1 and 1000
    or(select count(distinct value) from jsonb_array_elements_text(p_payload->'selected_attempt_ids'))<>jsonb_array_length(p_payload->'selected_attempt_ids')) then
    raise exception 'TEST_REPUBLISH_SELECTION_CHANGED';end if;
  select * into staged from public.teaching_tests where teaching_tests.id=draft.draft_test_id for update;
  definition:=public.xelay_private_publication_definition(staged.id);
  if policy<>'keep' and staged.closes_at<=clock_timestamp() then raise exception 'TEST_NOT_OPEN';end if;
  change_kind:=case when public.xelay_private_publication_shape(id)=public.xelay_private_publication_shape(staged.id)
    and t.results_finalized_at is null then 'settings' else 'definition' end;
  insert into public.teaching_test_publication_families(id,current_test_id) values(family,id) on conflict do nothing;
  insert into public.teaching_test_publication_members(test_id,family_id,revision) values(id,family,1) on conflict do nothing;
  select revision into current_revision from public.teaching_test_publication_families where teaching_test_publication_families.id=family for update;
  insert into public.teaching_test_publication_history(family_id,revision,test_id,definition,created_by)
    values(family,current_revision,id,public.xelay_private_publication_definition(id),uid) on conflict do nothing;
  new_version:=current_revision+1;
  if change_kind='settings' then
    update public.teaching_tests set description=staged.description,opens_at=staged.opens_at,closes_at=staged.closes_at,
      duration_seconds=staged.duration_seconds,status='published',closed_early_at=null,closed_early_by=null,
      version=version+1,updated_at=clock_timestamp() where teaching_tests.id=id;
    new_id:=id;
    update public.teaching_test_publication_families set revision=new_version where teaching_test_publication_families.id=family;
  else
    new_id:=staged.id;
    if exists(select 1 from public.teaching_course_module_items module_item
      join public.teaching_course_module_lectures lecture on lecture.test_item_id=module_item.id
      join public.teaching_course_modules module on module.id=lecture.module_id
      where module_item.resource_id in(select public.xelay_private_publication_tests(id)) and module_item.resource_type='test'
        and module_item.archived_at is null and module.status='published' and exists(select 1 from unnest(module.group_ids) required_group
          where not exists(select 1 from jsonb_array_elements(staged.targets) target
            where(target->>'group_id')::uuid=required_group and target->>'audience_mode'='all'))) then
      raise exception 'COURSE_MODULE_LECTURE_TEST_REQUIRED';end if;
    same_scale:=(t.max_points,t.category,t.journal_date,t.work_type) is not distinct from(staged.max_points,staged.category,staged.journal_date,staged.work_type);
    insert into public.teaching_test_publication_members(test_id,family_id,revision) values(new_id,family,new_version);
    update public.teaching_test_publication_families set current_test_id=new_id,revision=new_version where teaching_test_publication_families.id=family;
    if same_scale then
      insert into public.teaching_test_activities(test_id,group_id,activity_id)
        select new_id,l.group_id,l.activity_id from public.teaching_test_activities l where l.test_id=id
          and exists(select 1 from jsonb_array_elements(staged.targets) target where(target->>'group_id')::uuid=l.group_id);
    end if;
    select count(distinct activity_id)::integer into before_columns from public.teaching_test_activities
      where test_id in(select public.xelay_private_publication_tests(id));
    result:=public.xelay_private_test_mutate_before_publication_20261114('save_test',
      public.xelay_private_publication_save_payload(definition,new_id,staged.version,t.course_id,uid,'published'));
    select count(distinct activity_id)::integer into after_columns from public.teaching_test_activities
      where test_id in(select public.xelay_private_publication_tests(id));
  end if;
  if p_payload->'extend_active_attempts'='true'::jsonb then
    update public.teaching_test_attempts a set expires_at=staged.closes_at
      where a.test_id in(select public.xelay_private_publication_tests(id)) and a.status='in_progress' and a.expires_at<staged.closes_at
        and 'assignments'=any(public.xelay_teaching_group_permissions(t.course_id,a.group_id,uid))
        and 'grades'=any(public.xelay_teaching_group_permissions(t.course_id,a.group_id,uid));
    get diagnostics extended=row_count;
  end if;
  candidates:=public.xelay_private_publication_candidates(new_id,uid);
  if policy='selected_completed' and exists(select 1 from jsonb_array_elements_text(p_payload->'selected_attempt_ids') selected_id
    where not exists(select 1 from jsonb_array_elements(candidates) checked_candidate where checked_candidate->>'source_attempt_id'=selected_id and checked_candidate->'eligible'='true'::jsonb)) then
    raise exception 'TEST_REPUBLISH_SELECTION_CHANGED';end if;
  for candidate in select value from jsonb_array_elements(candidates) loop
    if policy='keep' then continue;end if;
    if policy='selected_completed' and not(p_payload->'selected_attempt_ids' ? (candidate->>'source_attempt_id')) then continue;end if;
    if candidate->>'reason'='active' then skipped_active:=skipped_active+1;continue;end if;
    if candidate->>'reason'='pending_retake' then skipped_pending:=skipped_pending+1;continue;end if;
    if candidate->'eligible' is distinct from 'true'::jsonb then skipped_ineligible:=skipped_ineligible+1;continue;end if;
    perform public.xelay_private_publication_grant(new_id,(candidate->>'source_attempt_id')::uuid,uid,
      md5('xelay:republish:'||request||':'||(candidate->>'source_attempt_id'))::uuid);
    created:=created+1;
  end loop;
  delete from public.teaching_test_publication_drafts where test_id=id;
  if change_kind='settings' then delete from public.teaching_tests where teaching_tests.id=staged.id;end if;
  insert into public.teaching_test_publication_history(family_id,revision,test_id,definition,created_by)
    values(family,new_version,new_id,public.xelay_private_publication_definition(new_id),uid);
  operation:=jsonb_build_object('request_id',request,'change_kind',change_kind,'created_retakes',created,
    'extended_active_attempts',extended,'skipped_active',skipped_active,'skipped_pending',skipped_pending,
    'new_grade_columns',greatest(0,coalesce(after_columns,0)-coalesce(before_columns,0)),'same_grade_scale',same_scale,'skipped_ineligible',skipped_ineligible);
  insert into public.teaching_test_republish_receipts(request_id,actor_id,source_test_id,published_test_id,request_hash,result)
    values(request,uid,id,new_id,md5(p_payload::text),operation);
  return public.xelay_teaching_test(new_id)||jsonb_build_object('republish_result',operation);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_datetime_format or datetime_field_overflow
  then raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

-- Same-scale versions share the journal column; a changed scale/classification
-- gets a new column. Sharing is confined to one publication family and group.
alter table public.teaching_test_activities drop constraint teaching_test_activities_activity_id_key;
create index teaching_test_activities_activity_idx on public.teaching_test_activities(activity_id);
create function public.xelay_private_publication_activity_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.teaching_test_activities l join public.teaching_tests other on other.id=l.test_id
    join public.teaching_tests own on own.id=new.test_id
    where l.activity_id=new.activity_id and l.test_id<>new.test_id and(
      l.group_id<>new.group_id or other.course_id<>own.course_id or other.max_points<>own.max_points
      or public.xelay_private_publication_family(own.id) is null
      or public.xelay_private_publication_family(own.id) is distinct from public.xelay_private_publication_family(other.id))) then
    raise exception 'TEST_PUBLICATION_ACTIVITY_SCOPE' using errcode='23514';end if;
  return new;
end $$;
create trigger teaching_test_publication_activity_scope before insert or update on public.teaching_test_activities
  for each row execute function public.xelay_private_publication_activity_guard();

create or replace function public.xelay_private_test_retake_transfer_score(p_root uuid,p_group uuid,p_user uuid,p_score numeric)
returns numeric language plpgsql stable security definer set search_path='' as $$
declare grade public.teaching_grades%rowtype;published_best numeric;publication_count integer;
begin
  select count(*)::integer,max(greatest(p.score,p.best_score)) into publication_count,published_best
    from public.teaching_test_attempt_publications p join public.teaching_test_attempts a on a.id=p.attempt_id
    join public.teaching_test_activities old_link on old_link.test_id=p.parent_test_id and old_link.group_id=a.group_id
    join public.teaching_test_activities current_link on current_link.activity_id=old_link.activity_id
      and current_link.test_id=p_root and current_link.group_id=p_group
    where a.group_id=p_group and a.user_id=p_user;
  if publication_count=0 then return p_score;end if;
  select g.* into grade from public.teaching_grades g join public.teaching_test_activities l on l.activity_id=g.activity_id
    join public.teaching_entries e on e.id=g.entry_id where l.test_id=p_root and l.group_id=p_group and e.user_id=p_user;
  if grade.id is not null and(grade.draft_score is distinct from grade.published_score or grade.draft_comment is distinct from grade.published_comment
    or grade.draft_absent is distinct from grade.published_absent) then raise exception 'TEST_RETAKE_PENDING_GRADE';end if;
  return greatest(p_score,published_best,grade.published_score);
end $$;

create function public.xelay_private_publication_save_payload(p_definition jsonb,p_id uuid,p_version integer,p_course uuid,p_user uuid,p_status text)
returns jsonb language sql immutable set search_path='' as $$
  select coalesce(jsonb_object_agg(key,value),'{}'::jsonb)||jsonb_build_object('id',p_id,'version',p_version,'course_id',p_course,
    'expected_user_id',p_user,'status',p_status,'qa_own_attempt',false)
  from jsonb_each(p_definition) where key=any(array['title','description','opens_at','closes_at','duration_seconds','max_points',
    'category','journal_date','work_type','allow_skip','allow_return','question_timer_policy','restrict_copy','bonus_percent',
    'bonus_points','targets','questions','shuffle_questions','shuffle_answers','draw_count','overrides','require_access_code',
    'restrict_tab_switch','discourage_capture','allow_external_links','variants','base_variant_title']);
$$;

create function public.xelay_private_publication_grant(p_parent uuid,p_source uuid,p_actor uuid,p_request uuid)
returns uuid language plpgsql volatile security definer set search_path='' as $$
declare parent public.teaching_tests%rowtype;source public.teaching_test_attempts%rowtype;child uuid:=gen_random_uuid();number integer;
begin
  select * into parent from public.teaching_tests where id=p_parent;
  select * into source from public.teaching_test_attempts where id=p_source for update;
  if source.status<>'submitted' or source.test_id not in(select public.xelay_private_publication_tests(p_parent))
    or not public.xelay_private_test_allows_before_modules_20261104(parent,source.user_id,source.group_id)
    or not(public.xelay_private_test_admission(parent,source.user_id)->>'allowed')::boolean then
    raise exception 'TEST_REPUBLISH_SELECTION_CHANGED';end if;
  select count(*)::integer+1 into number from public.teaching_test_attempts a where a.user_id=source.user_id
    and a.test_id in(select public.xelay_private_publication_tests(p_parent));
  -- Freeze original published receipts before the shared journal can improve.
  insert into public.teaching_test_attempt_publications(attempt_id,parent_test_id,score,absent,published_comment,best_score,published_at,actor_id,origin)
    select a.id,a.test_id,g.published_score,g.published_absent,g.published_comment,g.published_score,g.published_at,null::uuid,'original'
    from public.teaching_test_attempts a join public.teaching_test_activities l on l.test_id=a.test_id and l.group_id=a.group_id
    join public.teaching_entries e on e.user_id=a.user_id and e.group_id=a.group_id and e.course_id=parent.course_id
    join public.teaching_grades g on g.activity_id=l.activity_id and g.entry_id=e.id
    where a.user_id=source.user_id and a.group_id=source.group_id and a.test_id in(select public.xelay_private_publication_tests(p_parent))
      and g.published_at is not null on conflict(attempt_id) do nothing;
  insert into public.teaching_tests(id,course_id,title,description,status,opens_at,closes_at,duration_seconds,max_points,category,journal_date,work_type,
    allow_skip,allow_return,question_timer_policy,restrict_copy,bonus_percent,bonus_points,targets,questions,created_by,
    shuffle_questions,shuffle_answers,draw_count,overrides,require_access_code,restrict_tab_switch,discourage_capture,allow_external_links)
    values(child,parent.course_id,left('Повторна спроба · '||parent.title,180),parent.description,'draft',parent.opens_at,parent.closes_at,
      parent.duration_seconds,parent.max_points,parent.category,parent.journal_date,parent.work_type,parent.allow_skip,parent.allow_return,
      parent.question_timer_policy,parent.restrict_copy,0,0,jsonb_build_array(jsonb_build_object('group_id',source.group_id,
      'audience_mode','all','subgroup_ids','[]'::jsonb)),parent.questions,p_actor,parent.shuffle_questions,parent.shuffle_answers,parent.draw_count,
      '[]'::jsonb,parent.require_access_code,parent.restrict_tab_switch,parent.discourage_capture,parent.allow_external_links);
  insert into public.teaching_test_retake_grants(id,parent_test_id,child_test_id,user_id,group_id,source_attempt_id,retake_number,variant_choice,request_hash,created_by)
    values(p_request,p_parent,child,source.user_id,source.group_id,source.id,number,'random',md5(p_request::text||':'||source.id),p_actor);
  insert into public.teaching_test_manual_variants(test_id,variants) select child,variants from public.teaching_test_manual_variants where test_id=p_parent;
  insert into public.teaching_test_variant_labels(test_id,base_title) select child,base_title from public.teaching_test_variant_labels where test_id=p_parent;
  if parent.require_access_code then
    insert into public.teaching_test_access_codes(test_id,current_code,previous_code,rotated_at)
      select child,current_code,previous_code,clock_timestamp() from public.teaching_test_access_codes where test_id=p_parent;
    if not found then perform public.xelay_private_test_rotate_access_code(child);end if;
  end if;
  update public.teaching_tests set status='published',updated_at=clock_timestamp() where id=child;
  return child;
end $$;

-- Stable module links follow a family's published definition without admitting
-- anyone outside its audience. Historical progress uses the best published
-- percentage, so a new grading scale never reinterprets an old raw score.
alter function public.xelay_private_module_resource_targeted(text,uuid,uuid,uuid,uuid) rename to xelay_private_module_targeted_before_publication_20261114;
create function public.xelay_private_module_resource_targeted(p_type text,p_resource uuid,p_course uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_module_targeted_before_publication_20261114(p_type,
    case when p_type='test' then coalesce((select current_test_id from public.teaching_test_publication_families
      where id=public.xelay_private_publication_family(p_resource)),p_resource) else p_resource end,p_course,p_group,p_user);
$$;
alter function public.xelay_private_module_resource_eligible(text,uuid,uuid,uuid,uuid) rename to xelay_private_module_eligible_before_publication_20261114;
create function public.xelay_private_module_resource_eligible(p_type text,p_resource uuid,p_course uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_module_eligible_before_publication_20261114(p_type,
    case when p_type='test' then coalesce((select current_test_id from public.teaching_test_publication_families
      where id=public.xelay_private_publication_family(p_resource)),p_resource) else p_resource end,p_course,p_group,p_user);
$$;
alter function public.xelay_private_module_item_gate(uuid,uuid,uuid) rename to xelay_private_module_gate_before_publication_20261114;
create function public.xelay_private_module_item_gate(p_item uuid,p_group uuid,p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare item public.teaching_course_module_items%rowtype;
begin
  select * into item from public.teaching_course_module_items where id=p_item and archived_at is null;
  if item.resource_type='test' and public.xelay_private_publication_family(item.resource_id) is not null
    and public.xelay_private_module_resource_eligible('test',item.resource_id,item.course_id,p_group,p_user)
    and exists(select 1 from public.teaching_test_attempts where user_id=p_user and group_id=p_group
      and test_id in(select public.xelay_private_publication_tests(item.resource_id))) then
    return jsonb_build_object('locked',false,'reason','');end if;
  return public.xelay_private_module_gate_before_publication_20261114(p_item,p_group,p_user);
end $$;
alter function public.xelay_private_module_item_completion(uuid,uuid,uuid) rename to xelay_private_module_completion_before_publication_20261114;
create function public.xelay_private_module_item_completion(p_item uuid,p_group uuid,p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;item public.teaching_course_module_items%rowtype;submitted boolean;score numeric;maximum numeric;percent numeric;done boolean;
begin
  result:=public.xelay_private_module_completion_before_publication_20261114(p_item,p_group,p_user);
  select * into item from public.teaching_course_module_items where id=p_item and archived_at is null;
  if item.resource_type<>'test' or public.xelay_private_publication_family(item.resource_id) is null
    or result->>'state'='unavailable' or result->'completed'='true'::jsonb then return result;end if;
  select exists(select 1 from public.teaching_test_attempts where user_id=p_user and group_id=p_group and status='submitted'
    and test_id in(select public.xelay_private_publication_tests(item.resource_id))) into submitted;
  select grade.published_score,definition.max_points,round(grade.published_score/definition.max_points*100,2)
    into score,maximum,percent from public.teaching_grades grade join public.teaching_entries entry on entry.id=grade.entry_id
    join public.teaching_test_activities link on link.activity_id=grade.activity_id and link.group_id=p_group
    join public.teaching_tests definition on definition.id=link.test_id
    where entry.user_id=p_user and entry.active and grade.published_at is not null and not grade.published_absent
      and grade.published_score is not null and definition.id in(select public.xelay_private_publication_tests(item.resource_id))
    order by grade.published_score/definition.max_points desc limit 1;
  done:=case item.completion when 'submitted' then submitted when 'graded' then percent is not null
    when 'passed' then coalesce(percent>=item.pass_percent,false) else false end;
  return jsonb_build_object('completed',done,'state',case when done then item.completion when percent is not null then 'not_passed'
    when submitted then 'awaiting_grade' else 'not_started' end,'published_percent',percent,'score',score,'max_points',maximum);
end $$;

alter function public.xelay_private_module_item_json(uuid,uuid,uuid,boolean) rename to xelay_private_module_json_before_publication_20261114;
create function public.xelay_private_module_item_json(p_item uuid,p_user uuid,p_group uuid,p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;title text;
begin
  result:=public.xelay_private_module_json_before_publication_20261114(p_item,p_user,p_group,p_staff);
  if result->>'resource_type'='test' and(p_staff or result->'available'='true'::jsonb) then
    select t.title into title from public.teaching_test_publication_families f join public.teaching_tests t on t.id=f.current_test_id
      where f.id=public.xelay_private_publication_family((result->>'resource_id')::uuid);
    if title is not null then result:=jsonb_set(result,'{title}',to_jsonb(title));end if;
  end if;
  return result;
end $$;

-- The teacher's module picker must not expose the hidden working row as a
-- separate test or offer archived versions as new resources.
do $module_picker$
declare source text;anchor text:='from public.teaching_tests t where t.course_id=p_course_id';
begin
  source:=replace(pg_get_functiondef('public.xelay_private_teaching_course_modules_before_lectures(uuid)'::regprocedure),chr(13),'');
  if(length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'TEST_PUBLICATION_MODULE_PICKER_SOURCE_CHANGED';end if;
  execute replace(source,anchor,anchor||' and not exists(select 1 from public.teaching_test_publication_drafts draft where draft.draft_test_id=t.id)
    and(public.xelay_private_publication_family(t.id) is null or t.id=(select current_test_id from public.teaching_test_publication_families
      where id=public.xelay_private_publication_family(t.id)))');
end $module_picker$;

revoke all on function public.xelay_private_module_json_before_publication_20261114(uuid,uuid,uuid,boolean),
  public.xelay_private_module_item_json(uuid,uuid,uuid,boolean),public.xelay_private_module_targeted_before_publication_20261114(text,uuid,uuid,uuid,uuid),
  public.xelay_private_module_eligible_before_publication_20261114(text,uuid,uuid,uuid,uuid),public.xelay_private_module_gate_before_publication_20261114(uuid,uuid,uuid),
  public.xelay_private_module_completion_before_publication_20261114(uuid,uuid,uuid),public.xelay_private_module_resource_targeted(text,uuid,uuid,uuid,uuid),
  public.xelay_private_module_resource_eligible(text,uuid,uuid,uuid,uuid),public.xelay_private_module_item_gate(uuid,uuid,uuid),
  public.xelay_private_module_item_completion(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.xelay_private_publication_family(uuid),public.xelay_private_publication_tests(uuid),
  public.xelay_private_publication_editor(public.teaching_tests,uuid),public.xelay_private_publication_definition(uuid),
  public.xelay_private_publication_shape(uuid),public.xelay_private_publication_candidates(uuid,uuid),
  public.xelay_private_publication_preferred(uuid,uuid,uuid),public.xelay_private_publication_activity_guard(),
  public.xelay_private_publication_save_payload(jsonb,uuid,integer,uuid,uuid,text),public.xelay_private_publication_grant(uuid,uuid,uuid,uuid),
  public.xelay_private_test_allows_before_publication_20261114(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_view_before_publication_20261114(public.teaching_tests,uuid,boolean),
  public.xelay_private_tests_before_publication_20261114(uuid,uuid),public.xelay_private_test_detail_before_publication_20261114(uuid),
  public.xelay_private_test_mutate_before_publication_20261114(text,jsonb),public.xelay_private_test_allows(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),public.xelay_private_test_retake_transfer_score(uuid,uuid,uuid,numeric)
  from public,anon,authenticated,service_role;
revoke all on function public.xelay_teaching_tests(uuid,uuid),public.xelay_teaching_test(uuid),public.xelay_teaching_test_mutate(text,jsonb) from public,anon,service_role;
grant execute on function public.xelay_teaching_tests(uuid,uuid),public.xelay_teaching_test(uuid),public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;

