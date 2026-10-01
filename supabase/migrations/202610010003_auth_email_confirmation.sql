-- Apply before enabling Confirm Email. Profiles must not rely on a signup session.
begin;

create or replace function public.xelay_create_registration_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_university uuid;
  v_unit uuid;
  v_faculty text;
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
    or coalesce(v_meta->>'experience', '') not in ('Student / Fresh Graduate', '1–3 years', '3–7 years', '7–15 years', '15+ years')
    or (v_username is not null and v_username !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$')
  then raise exception 'Invalid registration profile'; end if;

  v_university := nullif(v_meta->>'university_id', '')::uuid;
  v_unit := nullif(v_meta->>'academic_unit_id', '')::uuid;
  select a.name into v_faculty from public.academic_units a
    join public.universities u on u.id = a.university_id
    where a.id = v_unit and a.university_id = v_university and a.is_active and u.is_active;
  if v_faculty is null then raise exception 'Invalid university or faculty'; end if;
  if jsonb_typeof(v_meta->'categories') is distinct from 'array' then
    raise exception 'Invalid registration categories';
  end if;
  if jsonb_array_length(v_meta->'categories') not between 1 and 20 then
    raise exception 'Invalid registration categories';
  end if;
  if exists (select 1 from jsonb_array_elements(v_meta->'categories') c
    where jsonb_typeof(c) <> 'string' or length(c #>> '{}') not between 1 and 100)
  then raise exception 'Invalid registration categories'; end if;
  select array_agg(value) into v_categories from jsonb_array_elements_text(v_meta->'categories');

  -- Whitelist profile fields. Roles, premium, and representative status never
  -- come from editable user metadata. The existing username trigger still runs.
  insert into public.profiles (
    id, full_name, username, email, country, city, bio, experience, categories,
    university_id, academic_unit_id, faculty, avatar_url, created_at
  ) values (
    new.id, v_name, v_username, new.email, btrim(v_meta->>'country'),
    btrim(coalesce(v_meta->>'city', '')), btrim(coalesce(v_meta->>'bio', '')),
    v_meta->>'experience', v_categories, v_university, v_unit, v_faculty, '', new.created_at
  ) on conflict (id) do update set
    full_name = excluded.full_name, username = excluded.username, email = excluded.email,
    country = excluded.country, city = excluded.city, bio = excluded.bio,
    experience = excluded.experience, categories = excluded.categories,
    university_id = excluded.university_id, academic_unit_id = excluded.academic_unit_id,
    faculty = excluded.faculty;
  return new;
end;
$$;

revoke all on function public.xelay_create_registration_profile() from public, anon, authenticated;
drop trigger if exists xelay_registration_profile on auth.users;
create trigger xelay_registration_profile after insert on auth.users
  for each row execute function public.xelay_create_registration_profile();

-- Existing profiles and confirmed accounts are unchanged. Supabase Auth controls
-- whether an unconfirmed account can obtain a session, via Confirm Email.
commit;
