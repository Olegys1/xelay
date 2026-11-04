-- Explicit surname/given-name components without guessing any existing identity.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.profiles add column first_name text;
alter table public.profiles add column last_name text;
comment on column public.profiles.first_name is 'Explicit given name. NULL for an unchanged legacy display name.';
comment on column public.profiles.last_name is 'Explicit surname. Displayed before first_name; never inferred from legacy full_name.';

create function public.xelay_profile_name_parts_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_metadata jsonb;v_parts_changed boolean;
begin
  -- The existing Auth creator validates registration and permissions. These
  -- two metadata values are display labels only, never authority or approval.
  if tg_op='INSERT' and new.first_name is null and new.last_name is null then
    select u.raw_user_meta_data into v_metadata from auth.users u where u.id=new.id;
    if v_metadata ? 'first_name' or v_metadata ? 'last_name' then
      if jsonb_typeof(v_metadata->'first_name') is distinct from 'string'
        or jsonb_typeof(v_metadata->'last_name') is distinct from 'string' then
        raise exception 'PROFILE_NAME_PARTS_REQUIRED' using errcode='23514';
      end if;
      new.first_name:=v_metadata->>'first_name';new.last_name:=v_metadata->>'last_name';
    end if;
  end if;
  v_parts_changed:=tg_op='INSERT';
  if tg_op='UPDATE' then
    v_parts_changed:=new.first_name is distinct from old.first_name or new.last_name is distinct from old.last_name;
    -- An old, still-open client may edit only the display name. Preserve that
    -- exact intention as legacy instead of silently undoing it or guessing order.
    if not v_parts_changed and new.full_name is distinct from old.full_name then
      new.first_name:=null;new.last_name:=null;return new;
    end if;
  end if;
  if new.first_name is null and new.last_name is null then return new;end if;
  if new.first_name is null or new.last_name is null then
    raise exception 'PROFILE_NAME_PARTS_REQUIRED' using errcode='23514';
  end if;
  new.first_name:=btrim(regexp_replace(replace(normalize(new.first_name,NFC),chr(160),' '),' +',' ','g'));
  new.last_name:=btrim(regexp_replace(replace(normalize(new.last_name,NFC),chr(160),' '),' +',' ','g'));
  if char_length(new.first_name) not between 1 and 60 or char_length(new.last_name) not between 1 and 60
    or new.first_name !~ '[[:alpha:]]' or new.last_name !~ '[[:alpha:]]'
    or new.first_name ~ '[[:cntrl:]<>]' or new.last_name ~ '[[:cntrl:]<>]'
    or new.first_name !~ '^[[:alpha:][:space:]''’ʼ.-]+$' or new.last_name !~ '^[[:alpha:][:space:]''’ʼ.-]+$'
    or char_length(new.last_name||' '||new.first_name)>120 then
    raise exception 'PROFILE_NAME_PARTS_INVALID' using errcode='23514';
  end if;
  new.full_name:=new.last_name||' '||new.first_name;
  return new;
end $$;
revoke all on function public.xelay_profile_name_parts_guard() from public,anon,authenticated,service_role;
create trigger xelay_profile_name_parts_guard before insert or update on public.profiles
  for each row execute function public.xelay_profile_name_parts_guard();

-- Registered roster identities follow the current profile. Manual roster rows,
-- grade values and historical audit/verification snapshots remain untouched.
create function public.xelay_sync_profile_teaching_entry_name()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.full_name is not distinct from old.full_name or to_regclass('public.teaching_entries') is null then return new;end if;
  update public.teaching_entries set full_name=left(coalesce(nullif(btrim(new.full_name),''),'Учасник'),180),
    version=version+1,updated_at=clock_timestamp()
    where user_id=new.id and full_name is distinct from left(coalesce(nullif(btrim(new.full_name),''),'Учасник'),180);
  return new;
end $$;
revoke all on function public.xelay_sync_profile_teaching_entry_name() from public,anon,authenticated,service_role;
create trigger xelay_profile_teaching_entry_name_sync after update of full_name on public.profiles
  for each row execute function public.xelay_sync_profile_teaching_entry_name();

-- Google completion retains its existing consent, account and academic checks.
-- Its old field allowlist deliberately excludes new fields, so apply display
-- components only after that unchanged validation succeeds in this transaction.
do $$ begin
  if to_regprocedure('public.xelay_complete_google_registration(jsonb,text,text,boolean)') is not null then
    alter function public.xelay_complete_google_registration(jsonb,text,text,boolean)
      rename to xelay_complete_google_registration_before_names_20261104;
    revoke all on function public.xelay_complete_google_registration_before_names_20261104(jsonb,text,text,boolean)
      from public,anon,authenticated,service_role;
    execute $wrapper$
      create function public.xelay_complete_google_registration(p_profile jsonb,p_policy_version text,p_consent_version text,p_consent boolean)
      returns jsonb language plpgsql volatile security definer set search_path='' as $body$
      declare v_result jsonb;v_uid uuid:=auth.uid();v_existing boolean;
      begin
        -- Match the original completion lock before detecting a retry, so a
        -- concurrent second request cannot rename the newly completed profile.
        perform 1 from auth.users where id=v_uid for update;
        select exists(select 1 from public.profiles where id=v_uid) into v_existing;
        v_result:=public.xelay_complete_google_registration_before_names_20261104(p_profile,p_policy_version,p_consent_version,p_consent);
        if not v_existing and (p_profile ? 'first_name' or p_profile ? 'last_name') then
          if jsonb_typeof(p_profile->'first_name') is distinct from 'string'
            or jsonb_typeof(p_profile->'last_name') is distinct from 'string' then
            raise exception 'PROFILE_NAME_PARTS_REQUIRED' using errcode='23514';
          end if;
          update public.profiles set first_name=p_profile->>'first_name',last_name=p_profile->>'last_name' where id=v_uid;
        end if;
        return v_result;
      end $body$
    $wrapper$;
    revoke all on function public.xelay_complete_google_registration(jsonb,text,text,boolean) from public,anon,authenticated,service_role;
    grant execute on function public.xelay_complete_google_registration(jsonb,text,text,boolean) to authenticated;
  end if;
end $$;

notify pgrst,'reload schema';
commit;
