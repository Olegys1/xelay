-- Course progression is tied to the academic year starting on 1 September in
-- Kyiv, rather than account creation or the number of profile visits. Existing
-- courses are the baseline for the current academic year; no history is guessed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.profiles') is null
    or not exists (
      select 1 from pg_catalog.pg_attribute
      where attrelid = to_regclass('public.profiles')
        and attname in ('id', 'study_year', 'experience', 'specialty_id', 'university_id')
        and not attisdropped
      group by attrelid having count(*) = 5
    )
  then
    raise exception 'Profiles with course, academic status and university/program fields are required before course progression';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'Enable pg_cron before applying automatic course progression';
  end if;
end;
$$;

-- Keep this feature independent of any other profile-security migration. An
-- authenticated SECURITY DEFINER call is still a client call: inspect the
-- actual connection role/session identity instead of the function owner.
create or replace function public.xelay_study_year_is_trusted_backend()
returns boolean
language sql stable security invoker
set search_path = ''
as $$
  select coalesce(pg_catalog.current_setting('role', true), 'none') = 'service_role'
    or (coalesce(pg_catalog.current_setting('role', true), 'none') in
        ('none', 'postgres', 'supabase_admin', 'supabase_auth_admin')
      and session_user in ('postgres', 'supabase_admin', 'supabase_auth_admin', 'service_role'));
$$;
revoke all on function public.xelay_study_year_is_trusted_backend()
  from public, anon, authenticated, service_role;

create or replace function public.xelay_current_academic_year()
returns smallint
language sql stable security invoker
set search_path = ''
as $$
  select (
    extract(year from pg_catalog.now() at time zone 'Europe/Kyiv')::integer
      - case when extract(month from pg_catalog.now() at time zone 'Europe/Kyiv') < 9
          then 1 else 0 end
  )::smallint;
$$;
revoke all on function public.xelay_current_academic_year()
  from public, anon, authenticated, service_role;

-- Prevent an in-flight profile update from falling between the baseline and
-- trigger installation. A retry preserves all anchors already recorded.
lock table public.profiles in share row exclusive mode;
alter table public.profiles
  add column if not exists study_year_auto_advance boolean not null default true,
  add column if not exists study_year_academic_year smallint,
  add column if not exists study_program_years smallint,
  add column if not exists study_year_needs_review boolean not null default false;

update public.profiles
  set study_year_academic_year = public.xelay_current_academic_year()
  where study_year_academic_year is null;
alter table public.profiles
  alter column study_year_academic_year set not null;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.profiles'::regclass
        and conname = 'profiles_study_program_years_check') then
    alter table public.profiles add constraint profiles_study_program_years_check
      check (study_program_years is null or study_program_years between 1 and 6);
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
      where conrelid = 'public.profiles'::regclass
        and conname = 'profiles_study_year_academic_year_check') then
    alter table public.profiles add constraint profiles_study_year_academic_year_check
      check (study_year_academic_year between 1900 and 2200);
  end if;
end;
$$;

create or replace function public.xelay_apply_profile_study_year()
returns trigger
language plpgsql security definer
set search_path = ''
as $$
declare
  v_trusted boolean := public.xelay_study_year_is_trusted_backend();
  v_academic_year smallint := public.xelay_current_academic_year();
  v_manual_change boolean;
  v_duration integer;
  v_elapsed integer;
  v_candidate integer;
begin
  if tg_op = 'UPDATE' and new.id is distinct from old.id then
    raise exception 'PROFILE_ID_IMMUTABLE' using errcode = '42501';
  end if;
  if not v_trusted and (auth.uid() is null or new.id is distinct from auth.uid()) then
    -- Existing scoped RPCs may update unrelated fields (for example a rating)
    -- on someone else's profile. Keep those paths under their existing guards;
    -- they cannot change academic data or perform an annual course update.
    if tg_op = 'UPDATE' then
      if new.study_year is not distinct from old.study_year
          and new.experience is not distinct from old.experience
          and new.study_program_years is not distinct from old.study_program_years
          and new.study_year_auto_advance is not distinct from old.study_year_auto_advance
          and new.study_year_academic_year is not distinct from old.study_year_academic_year
          and new.study_year_needs_review is not distinct from old.study_year_needs_review then
        return new;
      end if;
    end if;
    raise exception 'PROFILE_OWNER_REQUIRED' using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if not v_trusted and (new.study_year_academic_year is not null
        or new.study_year_needs_review) then
      raise exception 'PROFILE_ACADEMIC_ANCHOR_SERVER_OWNED' using errcode = '42501';
    end if;
    v_manual_change := true;
  else
    -- SECURITY DEFINER alone is not a trusted-backend identity. A client may
    -- read its anchor, but cannot forge it or suppress the terminal-year hint.
    if not v_trusted and (
        new.study_year_academic_year is distinct from old.study_year_academic_year
        or new.study_year_needs_review is distinct from old.study_year_needs_review
      ) then
      raise exception 'PROFILE_ACADEMIC_ANCHOR_SERVER_OWNED' using errcode = '42501';
    end if;
    v_manual_change := new.study_year is distinct from old.study_year
      or new.experience is distinct from old.experience
      or new.study_program_years is distinct from old.study_program_years
      or new.study_year_auto_advance is distinct from old.study_year_auto_advance
      or new.university_id is distinct from old.university_id
      or new.specialty_id is distinct from old.specialty_id;
  end if;

  if new.study_program_years is not null and new.study_program_years not between 1 and 6 then
    raise exception 'STUDY_PROGRAM_YEARS_INVALID' using errcode = '23514';
  end if;

  if v_manual_change then
    -- Repeating a course, changing programs or pausing advancement starts a new
    -- baseline. Graduating is an explicit user choice, never an annual guess.
    if new.experience = 'graduate' then new.study_year := null; end if;
    if new.study_year is not null and new.study_year not between 1 and 6 then
      raise exception 'STUDY_YEAR_INVALID' using errcode = '23514';
    end if;
    if new.experience in ('bachelor', 'master', 'postgraduate')
        and new.study_program_years is not null
        and new.study_year > new.study_program_years then
      raise exception 'STUDY_PROGRAM_SHORTER_THAN_CURRENT_YEAR' using errcode = '23514';
    end if;
    new.study_year_academic_year := v_academic_year;
    new.study_year_needs_review := false;
    return new;
  end if;

  v_elapsed := greatest(v_academic_year - old.study_year_academic_year, 0);
  if v_elapsed = 0 then
    -- Even backend updates do not invent a future baseline or clear a pending
    -- review unless an academic field was explicitly corrected above.
    new.study_year_academic_year := old.study_year_academic_year;
    new.study_year_needs_review := old.study_year_needs_review;
    return new;
  end if;

  new.study_year_academic_year := v_academic_year;
  new.study_year_needs_review := old.study_year_needs_review;
  if not new.study_year_auto_advance
      or new.experience not in ('bachelor', 'master', 'postgraduate')
      or new.experience is null
      or new.study_year is null or new.study_year not between 1 and 6 then
    return new;
  end if;

  v_duration := coalesce(new.study_program_years, case new.experience
    when 'bachelor' then 4 when 'master' then 2 when 'postgraduate' then 4 end);
  -- Older accounts may already have course 5/6 without an explicit duration.
  -- Their recorded course is preserved, including during the first catch-up.
  if new.study_program_years is null then
    v_duration := greatest(v_duration, new.study_year);
  end if;
  v_candidate := new.study_year + v_elapsed;
  if v_candidate > v_duration then new.study_year_needs_review := true; end if;
  new.study_year := greatest(new.study_year, least(v_candidate, v_duration));
  return new;
end;
$$;
revoke all on function public.xelay_apply_profile_study_year()
  from public, anon, authenticated, service_role;
do $$
begin
  if not exists (select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.profiles'::regclass
        and tgname = 'xelay_profile_study_year_progression' and not tgisinternal) then
    create trigger xelay_profile_study_year_progression
      before insert or update on public.profiles
      for each row execute function public.xelay_apply_profile_study_year();
  elsif not exists (select 1 from pg_catalog.pg_trigger
      where tgrelid = 'public.profiles'::regclass
        and tgname = 'xelay_profile_study_year_progression' and not tgisinternal
        and tgfoid = to_regprocedure('public.xelay_apply_profile_study_year()')
        and tgtype = 23 and tgenabled in ('O', 'A')) then
    raise exception 'Unexpected or disabled profile study-year trigger; review it before applying this migration';
  end if;
end;
$$;

-- Catch up the signed-in owner's profile immediately if a scheduled run was
-- delayed. The trigger derives the course; the RPC accepts neither a target
-- user nor an arbitrary year and introduces no access to another profile.
create or replace function public.xelay_refresh_my_study_year()
returns void
language plpgsql security definer
set search_path = ''
as $$
declare v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;
  update public.profiles
    set study_year = study_year
    where id = v_user_id
      and study_year_academic_year < public.xelay_current_academic_year();
end;
$$;
revoke all on function public.xelay_refresh_my_study_year()
  from public, anon, authenticated, service_role;
grant execute on function public.xelay_refresh_my_study_year() to authenticated;

-- A trusted database job advances all profiles even if their owners never
-- sign in. It runs at 21:05 UTC daily (00:05 Kyiv on 1 September). The named
-- schedule is updated on retry; no external service or secret is required.
create or replace function public.xelay_advance_profile_study_years()
returns integer
language plpgsql security definer
set search_path = ''
as $$
declare v_updated integer;
begin
  if not public.xelay_study_year_is_trusted_backend() then
    raise exception 'PROFILE_COURSE_WORKER_SERVER_ONLY' using errcode = '42501';
  end if;
  update public.profiles
    set study_year = study_year
    where study_year_academic_year < public.xelay_current_academic_year();
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;
revoke all on function public.xelay_advance_profile_study_years()
  from public, anon, authenticated, service_role;
grant execute on function public.xelay_advance_profile_study_years() to service_role;

select cron.schedule(
  'xelay-profile-study-year-progression', '5 21 * * *',
  'select public.xelay_advance_profile_study_years();'
);

comment on column public.profiles.study_year_academic_year is
  'Server-owned academic-year anchor. Kyiv academic years begin on 1 September.';
comment on column public.profiles.study_program_years is
  'Optional explicit program duration (1-6 years); defaults: bachelor 4, master 2, postgraduate 4.';
comment on column public.profiles.study_year_needs_review is
  'Server-owned hint to confirm graduation or a repeated final course; never changes status automatically.';

commit;
