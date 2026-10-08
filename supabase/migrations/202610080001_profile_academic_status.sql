-- Accept academic statuses in the existing profile field. Keep legacy values
-- valid for older clients and retain existing profiles without reclassification.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.xelay_create_registration_profile()') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.academic_specialties') is null
    or to_regclass('public.academic_units') is null
    or to_regclass('public.universities') is null
    or not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = to_regclass('public.profiles')
        and attname = 'specialty_id' and not attisdropped
    )
    or not exists (
      select 1 from pg_catalog.pg_trigger
      where tgrelid = to_regclass('auth.users')
        and tgname = 'xelay_registration_profile' and not tgisinternal
        and tgfoid = to_regprocedure('public.xelay_create_registration_profile()')
    )
  then
    raise exception 'Apply registration profile and academic specialties migrations before academic statuses';
  end if;
end;
$$;

-- CREATE OR REPLACE preserves the existing function owner and privileges.
-- The existing auth.users trigger and profile validation triggers stay attached.
create or replace function public.xelay_create_registration_profile()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_university uuid;
  v_unit uuid;
  v_specialty uuid;
  v_faculty text;
  v_program_name text;
  v_categories text[];
  v_name text;
  v_username text;
begin
  -- Ignore imports and legacy accounts; this trigger only handles our signup form.
  if v_meta->>'xelay_registration_version' is distinct from '1' then return new; end if;
  v_name := btrim(coalesce(v_meta->>'full_name', ''));
  v_username := nullif(lower(regexp_replace(btrim(coalesce(v_meta->>'username', '')), '^@', '')), '');
  if length(v_name) not between 1 and 120
    or length(btrim(coalesce(v_meta->>'country', ''))) not between 1 and 80
    or length(coalesce(v_meta->>'city', '')) > 120
    or length(coalesce(v_meta->>'bio', '')) > 2000
    or coalesce(v_meta->>'experience', '') not in (
      'bachelor', 'master', 'postgraduate', 'graduate',
      'Student / Fresh Graduate', '1–3 years', '3–7 years', '7–15 years', '15+ years'
    )
    or (v_username is not null and v_username !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$')
  then raise exception 'Invalid registration profile'; end if;

  v_university := nullif(v_meta->>'university_id', '')::uuid;
  v_unit := nullif(v_meta->>'academic_unit_id', '')::uuid;
  v_specialty := nullif(v_meta->>'specialty_id', '')::uuid;
  if v_specialty is null then
    raise exception 'ACADEMIC_SPECIALTY_REQUIRED' using errcode = '23514';
  end if;
  select specialty.name, unit.name into v_program_name, v_faculty
    from public.academic_specialties specialty
    join public.academic_units unit
      on unit.id = specialty.academic_unit_id and unit.university_id = specialty.university_id
    join public.universities university on university.id = specialty.university_id
    where specialty.id = v_specialty
      and specialty.academic_unit_id = v_unit and specialty.university_id = v_university
      and specialty.is_active and unit.is_active and university.is_active;
  if not found then
    raise exception 'ACADEMIC_SPECIALTY_INVALID' using errcode = '23514';
  end if;
  if jsonb_typeof(v_meta->'categories') is distinct from 'array' then
    raise exception 'Invalid registration categories';
  end if;
  if jsonb_array_length(v_meta->'categories') not between 1 and 20 then
    raise exception 'Invalid registration categories';
  end if;
  if exists (select 1 from jsonb_array_elements(v_meta->'categories') category
    where jsonb_typeof(category) <> 'string' or length(category #>> '{}') not between 1 and 100)
  then raise exception 'Invalid registration categories'; end if;
  select array_agg(value) into v_categories from jsonb_array_elements_text(v_meta->'categories');

  insert into public.profiles (
    id, full_name, username, email, country, city, bio, experience, categories,
    university_id, academic_unit_id, specialty_id, specialty, faculty, avatar_url, created_at
  ) values (
    new.id, v_name, v_username, new.email, btrim(v_meta->>'country'),
    btrim(coalesce(v_meta->>'city', '')), btrim(coalesce(v_meta->>'bio', '')),
    v_meta->>'experience', v_categories, v_university, v_unit, v_specialty, v_program_name,
    v_faculty, '', new.created_at
  ) on conflict (id) do update set
    full_name = excluded.full_name, username = excluded.username, email = excluded.email,
    country = excluded.country, city = excluded.city, bio = excluded.bio,
    experience = excluded.experience, categories = excluded.categories,
    university_id = excluded.university_id, academic_unit_id = excluded.academic_unit_id,
    specialty_id = excluded.specialty_id, specialty = excluded.specialty,
    faculty = excluded.faculty;
  return new;
end;
$$;

commit;
