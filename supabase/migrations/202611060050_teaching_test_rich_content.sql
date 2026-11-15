-- Reuse the private question-image store for individual answer options.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_tests add column allow_external_links boolean not null default false;
lock table public.teaching_test_attempts,public.teaching_test_manual_variants,public.teaching_question_bank in share row exclusive mode;

-- Older validators did not interpret option images. Do not grant access from
-- legacy JSON without the ownership and attachment checks below.
do $preflight$
begin
  if exists(select 1 from public.teaching_tests where questions@?'$[*].options[*].images')
    or exists(select 1 from public.teaching_test_attempts where questions@?'$[*].options[*].images')
    or exists(select 1 from public.teaching_test_manual_variants where variants@?'$[*].questions[*].options[*].images')
    or exists(select 1 from public.teaching_question_bank where question@?'$.options[*].images')
  then raise exception 'TEST_LEGACY_OPTION_IMAGE_METADATA';end if;
end $preflight$;

create function public.xelay_private_test_option_images_valid(p_question jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_option jsonb;v_total integer:=0;
begin
  if jsonb_typeof(p_question->'options') is distinct from 'array' then return false;end if;
  for v_option in select value from jsonb_array_elements(p_question->'options') where value?'images' loop
    if coalesce(p_question->>'kind','') not in('choice','multiple')
      or jsonb_typeof(v_option) is distinct from 'object'
      or jsonb_typeof(v_option->'text') is distinct from 'string'
      or v_option-array['id','text','images']<>'{}'::jsonb
      or jsonb_typeof(v_option->'images') is distinct from 'array' then return false;end if;
    if jsonb_array_length(v_option->'images')>1 then return false;end if;
    v_total:=v_total+jsonb_array_length(v_option->'images');
    if v_total>12 then return false;end if;
  end loop;
  return true;
end $$;

alter function public.xelay_private_test_validate_question(jsonb)
  rename to xelay_private_test_validate_question_before_option_images;
create function public.xelay_private_test_validate_question(p_question jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_options jsonb;
begin
  if not public.xelay_private_test_option_images_valid(p_question) then return false;end if;
  if not p_question@?'$.options[*].images' then
    return public.xelay_private_test_validate_question_before_option_images(p_question);
  end if;
  -- A photo may be the entire answer. Use a placeholder only in validation
  -- so the original option, caption and stable answer key remain unchanged.
  select jsonb_agg(case when o->'images'<>'[]'::jsonb and btrim(o->>'text')=''
    then jsonb_set(o,'{text}',to_jsonb('Зображення'::text)) else o end order by n)
    into v_options from jsonb_array_elements(p_question->'options') with ordinality options(o,n);
  return public.xelay_private_test_validate_question_before_option_images(jsonb_set(p_question,'{options}',v_options));
end $$;

create or replace function public.xelay_private_test_question_images_attach(p_course_id uuid,p_questions jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_question jsonb;v_images jsonb;v_image jsonb;v_id uuid;
begin
  for v_question in select value from jsonb_array_elements(p_questions) loop
    v_images:=coalesce(v_question->'images','[]'::jsonb);
    if jsonb_typeof(v_images) is distinct from 'array'
      or not public.xelay_private_test_option_images_valid(v_question) then raise exception 'TEST_INVALID_INPUT';end if;
    if jsonb_array_length(v_images)>3
      or (select count(distinct value->>'id') from jsonb_array_elements(v_images))<>jsonb_array_length(v_images)
      then raise exception 'TEST_INVALID_INPUT';end if;

    for v_image in select value from jsonb_array_elements(v_images)
      union all
      select i.value from jsonb_array_elements(v_question->'options') o
        cross join lateral jsonb_array_elements(coalesce(o->'images','[]'::jsonb)) i
    loop
      if jsonb_typeof(v_image) is distinct from 'object'
        or v_image-array['id','mime_type','alt']<>'{}'::jsonb
        or jsonb_typeof(v_image->'id') is distinct from 'string'
        or v_image->>'id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_image->>'mime_type' is distinct from 'image/jpeg'
        or jsonb_typeof(v_image->'alt') is distinct from 'string'
        or length(v_image->>'alt')>160 then raise exception 'TEST_INVALID_INPUT';end if;
      v_id:=(v_image->>'id')::uuid;
      perform 1 from public.teaching_test_question_images i
        where i.id=v_id and i.course_id=p_course_id
          and (auth.uid() is null or i.created_by=auth.uid()
            or public.xelay_private_test_question_image_staff_can_read(i.id,i.course_id,i.created_by,auth.uid()))
        for update;
      if not found then raise exception 'TEST_INVALID_INPUT';end if;
      update public.teaching_test_question_images set attached_at=clock_timestamp()
        where id=v_id and attached_at is null;
    end loop;
  end loop;
end $$;

create or replace function public.xelay_private_test_question_image_staff_can_read(p_image_id uuid,p_course_id uuid,p_uploader uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  with image as (
    select jsonb_build_array(jsonb_build_object('id',p_image_id)) refs
  ), reference as (
    select jsonb_build_object('images',refs) question from image
    union all
    select jsonb_build_object('options',jsonb_build_array(jsonb_build_object('images',refs))) from image
  )
  select (
    public.xelay_teaching_is_verified(p_user) and public.xelay_teaching_has_current_access(p_user)
    and 'assignments'=any(public.xelay_teaching_permissions(p_course_id,p_user))
    and exists(select 1 from public.teaching_courses where id=p_course_id and archived_at is null)
    and (p_uploader is not distinct from p_user or exists(
      select 1 from public.teaching_question_bank b,reference r where b.course_id=p_course_id and b.question@>r.question
    ))
  )
  or exists(
    select 1 from public.teaching_tests t
      left join public.teaching_test_manual_variants m on m.test_id=t.id
      cross join reference r
    where t.course_id=p_course_id
      and (t.questions@>jsonb_build_array(r.question)
        or m.variants@>jsonb_build_array(jsonb_build_object('questions',jsonb_build_array(r.question))))
      and (public.xelay_private_test_staff(t,p_user,'assignments') or public.xelay_private_test_staff(t,p_user,'grades'))
  );
$$;

create or replace function public.xelay_teaching_test_question_image(p_image_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare
  v_user uuid:=public.xelay_teaching_assert_user();
  v_image public.teaching_test_question_images%rowtype;
  v_refs jsonb:=jsonb_build_array(jsonb_build_object('id',p_image_id));
  v_question jsonb:=jsonb_build_object('images',v_refs);
  v_option jsonb:=jsonb_build_object('options',jsonb_build_array(v_question));
begin
  select * into v_image from public.teaching_test_question_images where id=p_image_id;
  if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;

  if (
    public.xelay_private_test_question_image_staff_can_read(v_image.id,v_image.course_id,v_image.created_by,v_user)
    or exists(
      select 1 from public.teaching_test_attempts a join public.teaching_tests t on t.id=a.test_id
      where a.user_id=v_user and a.status='in_progress' and a.expires_at>statement_timestamp()
        and t.course_id=v_image.course_id and t.status='published'
        and ((a.questions->a.current_index)@>v_question or (a.questions->a.current_index)@>v_option)
        and public.xelay_private_test_allows(t,v_user,a.group_id)
    )
  ) is not true then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  return replace(encode(v_image.content,'base64'),chr(10),'');
end $$;

create or replace function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_view jsonb:=public.xelay_private_test_attempt_view_before_images(p_attempt,p_test,p_full);
  v_images jsonb:=p_attempt.questions->p_attempt.current_index->'images';
begin
  if not p_full and jsonb_typeof(v_view->'current_question')='object' and jsonb_typeof(v_images)='array' then
    v_view:=jsonb_set(v_view,'{current_question,images}',v_images);
  end if;
  -- There is one attempt per test and student. Use the explicit profile
  -- surname only on an authorized watermarked attempt.
  v_view:=v_view||jsonb_build_object('attempt_number',1);
  if p_test.discourage_capture and (p_full or p_attempt.user_id=auth.uid()) then
    v_view:=v_view||jsonb_build_object('watermark_surname',(select last_name from public.profiles where id=p_attempt.user_id));
  end if;
  return v_view;
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_rich_content;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;v_enabled boolean;
begin
  if p_action is distinct from 'save_test' or not coalesce(p_payload?'allow_external_links',false) then
    return public.xelay_private_test_mutate_before_rich_content(p_action,p_payload);
  end if;
  if jsonb_typeof(p_payload->'allow_external_links') is distinct from 'boolean' then raise exception 'TEST_INVALID_INPUT';end if;
  v_enabled:=(p_payload->>'allow_external_links')::boolean;
  -- The existing save validates the actor and version, and holds the test
  -- lock through this update so a new attempt cannot observe stale settings.
  v_result:=public.xelay_private_test_mutate_before_rich_content(p_action,p_payload-'allow_external_links');
  update public.teaching_tests set allow_external_links=v_enabled where id=(p_payload->>'id')::uuid;
  return jsonb_set(v_result,'{test,allow_external_links}',to_jsonb(v_enabled));
end $$;

revoke all on function
  public.xelay_private_test_option_images_valid(jsonb),
  public.xelay_private_test_validate_question_before_option_images(jsonb),
  public.xelay_private_test_validate_question(jsonb),
  public.xelay_private_test_mutate_before_rich_content(text,jsonb),
  public.xelay_teaching_test_mutate(text,jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
