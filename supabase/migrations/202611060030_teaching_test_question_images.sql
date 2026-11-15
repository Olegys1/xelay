-- Image bytes stay in a private table. Question definitions and attempt
-- snapshots contain only IDs and alternative text.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create table public.teaching_test_question_images (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  attached_at timestamptz,
  content bytea not null,
  content_bytes integer generated always as (octet_length(content)) stored,
  check(octet_length(content) between 32 and 262144)
);
create index teaching_test_question_images_course_idx on public.teaching_test_question_images(course_id);
create index teaching_test_attempts_active_user_idx on public.teaching_test_attempts(user_id,test_id) where status='in_progress';
alter table public.teaching_test_question_images enable row level security;
revoke all on public.teaching_test_question_images from public,anon,authenticated,service_role;

-- Verify the JPEG frame before accepting bytes from a direct RPC caller.
-- The browser editor also decodes and re-encodes every selected raster.
create function public.xelay_private_test_question_image_valid(p_content bytea)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  v_length integer:=octet_length(p_content);
  v_offset integer:=2;
  v_marker integer;
  v_size integer;
  v_width integer;
  v_height integer;
  v_has_frame boolean:=false;
  v_has_quantization boolean:=false;
  v_has_huffman boolean:=false;
  v_has_scan boolean:=false;
  v_in_scan boolean:=false;
begin
  if v_length not between 32 and 262144 then return false;end if;
  if substring(p_content from 1 for 2)<>decode('ffd8','hex')
    or substring(p_content from v_length-1 for 2)<>decode('ffd9','hex') then return false;end if;

  while v_offset<v_length loop
    if v_in_scan and get_byte(p_content,v_offset)<>255 then
      v_offset:=v_offset+1;
      continue;
    end if;
    if get_byte(p_content,v_offset)<>255 then return false;end if;
    while v_offset<v_length and get_byte(p_content,v_offset)=255 loop
      v_offset:=v_offset+1;
    end loop;
    if v_offset>=v_length then return false;end if;
    v_marker:=get_byte(p_content,v_offset);
    v_offset:=v_offset+1;
    if v_in_scan and (v_marker=0 or v_marker between 208 and 215) then continue;end if;
    if v_marker=217 then return v_has_scan and v_offset=v_length;end if;
    v_in_scan:=false;
    if v_offset>=v_length-2 then return false;end if;
    v_size:=get_byte(p_content,v_offset)*256+get_byte(p_content,v_offset+1);
    if v_size<2 or v_offset+v_size>v_length-2 then return false;end if;

    if v_marker in(192,193,194) then
      if v_has_frame or v_size<11 or get_byte(p_content,v_offset+2)<>8 then return false;end if;
      v_height:=get_byte(p_content,v_offset+3)*256+get_byte(p_content,v_offset+4);
      v_width:=get_byte(p_content,v_offset+5)*256+get_byte(p_content,v_offset+6);
      if v_height not between 1 and 1600 or v_width not between 1 and 1600 then return false;end if;
      v_has_frame:=true;
    elsif v_marker=218 then
      if not(v_has_frame and v_has_quantization and v_has_huffman)
        or v_size<8 or v_offset+v_size>=v_length-2 then return false;end if;
      v_has_scan:=true;
      v_in_scan:=true;
    elsif v_marker=219 then
      v_has_quantization:=v_has_quantization or v_size>=67;
    elsif v_marker=196 then
      v_has_huffman:=v_has_huffman or v_size>=20;
    elsif v_marker not in(221,254) and v_marker not between 224 and 239 then
      return false;
    end if;
    v_offset:=v_offset+v_size;
  end loop;
  return false;
end $$;

create function public.xelay_teaching_test_question_image_upload(p_course_id uuid,p_expected_user_id uuid,p_data text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_user uuid:=public.xelay_teaching_assert_user();
  v_content bytea;
  v_id uuid;
  v_count bigint;
  v_used bigint;
begin
  if p_expected_user_id is distinct from v_user then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if p_data is null or length(p_data) not between 44 and 349528 or length(p_data)%4<>0
    or p_data !~ '^[A-Za-z0-9+/]+={0,2}$' then raise exception 'TEST_INVALID_INPUT';end if;
  perform public.xelay_teaching_lock_course(p_course_id,'assignments');
  v_content:=decode(p_data,'base64');
  if not public.xelay_private_test_question_image_valid(v_content)
    or replace(encode(v_content,'base64'),chr(10),'')<>p_data then raise exception 'TEST_INVALID_INPUT';end if;

  -- Free abandoned uploads without affecting saved tests or attempt snapshots.
  delete from public.teaching_test_question_images
    where course_id=p_course_id and attached_at is null and created_at<clock_timestamp()-interval '7 days';
  select count(*),coalesce(sum(content_bytes),0) into v_count,v_used
    from public.teaching_test_question_images where course_id=p_course_id;
  if v_count>=5000 or v_used+octet_length(v_content)>67108864 then raise exception 'TEST_IMAGE_LIMIT';end if;

  insert into public.teaching_test_question_images(course_id,created_by,content)
    values(p_course_id,v_user,v_content) returning id into v_id;
  return jsonb_build_object('id',v_id);
end $$;

create function public.xelay_private_test_question_image_staff_can_read(p_image_id uuid,p_course_id uuid,p_uploader uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  with reference as (
    select jsonb_build_object('images',jsonb_build_array(jsonb_build_object('id',p_image_id))) question
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

create function public.xelay_private_test_question_images_attach(p_course_id uuid,p_questions jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare
  v_question jsonb;
  v_images jsonb;
  v_image jsonb;
  v_id uuid;
begin
  for v_question in select value from jsonb_array_elements(p_questions) loop
    if not(v_question?'images') then continue;end if;
    v_images:=v_question->'images';
    if jsonb_typeof(v_images) is distinct from 'array' then raise exception 'TEST_INVALID_INPUT';end if;
    if jsonb_array_length(v_images)>3
      or (select count(distinct value->>'id') from jsonb_array_elements(v_images))<>jsonb_array_length(v_images)
      then raise exception 'TEST_INVALID_INPUT';end if;

    for v_image in select value from jsonb_array_elements(v_images) loop
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

create function public.xelay_private_test_question_images_trigger()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_course uuid;
  v_variant jsonb;
begin
  if tg_table_name='teaching_tests' then
    perform public.xelay_private_test_question_images_attach(new.course_id,new.questions);
  elsif tg_table_name='teaching_question_bank' then
    perform public.xelay_private_test_question_images_attach(new.course_id,jsonb_build_array(new.question));
  else
    select course_id into v_course from public.teaching_tests where id=new.test_id;
    for v_variant in select value from jsonb_array_elements(new.variants) loop
      perform public.xelay_private_test_question_images_attach(v_course,v_variant->'questions');
    end loop;
  end if;
  return new;
end $$;

create trigger teaching_test_question_images_validate
  before insert or update of questions,course_id on public.teaching_tests
  for each row execute function public.xelay_private_test_question_images_trigger();
create trigger teaching_bank_question_images_validate
  before insert or update of question,course_id on public.teaching_question_bank
  for each row execute function public.xelay_private_test_question_images_trigger();
create trigger teaching_variant_question_images_validate
  before insert or update of variants,test_id on public.teaching_test_manual_variants
  for each row execute function public.xelay_private_test_question_images_trigger();

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_images;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_view jsonb:=public.xelay_private_test_attempt_view_before_images(p_attempt,p_test,p_full);
  v_images jsonb:=p_attempt.questions->p_attempt.current_index->'images';
begin
  if not p_full and jsonb_typeof(v_view->'current_question')='object' and jsonb_typeof(v_images)='array' then
    return jsonb_set(v_view,'{current_question,images}',v_images);
  end if;
  return v_view;
end $$;

create function public.xelay_teaching_test_question_image(p_image_id uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare
  v_user uuid:=public.xelay_teaching_assert_user();
  v_image public.teaching_test_question_images%rowtype;
  v_question jsonb:=jsonb_build_object('images',jsonb_build_array(jsonb_build_object('id',p_image_id)));
begin
  select * into v_image from public.teaching_test_question_images where id=p_image_id;
  if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;

  if (
    public.xelay_private_test_question_image_staff_can_read(v_image.id,v_image.course_id,v_image.created_by,v_user)
    -- A student sees only the image(s) for the current question in their own
    -- active snapshot, even if they know an ID from another variant.
    or exists(
      select 1 from public.teaching_test_attempts a join public.teaching_tests t on t.id=a.test_id
      where a.user_id=v_user and a.status='in_progress' and a.expires_at>statement_timestamp()
        and t.course_id=v_image.course_id and t.status='published'
        and (a.questions->a.current_index)@>v_question and public.xelay_private_test_allows(t,v_user,a.group_id)
    )
  ) is not true then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  return replace(encode(v_image.content,'base64'),chr(10),'');
end $$;

revoke all on function
  public.xelay_private_test_question_image_valid(bytea),
  public.xelay_private_test_question_image_staff_can_read(uuid,uuid,uuid,uuid),
  public.xelay_private_test_question_images_attach(uuid,jsonb),
  public.xelay_private_test_question_images_trigger(),
  public.xelay_private_test_attempt_view_before_images(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_teaching_test_question_image_upload(uuid,uuid,text),
  public.xelay_teaching_test_question_image(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_question_image_upload(uuid,uuid,text),
  public.xelay_teaching_test_question_image(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
