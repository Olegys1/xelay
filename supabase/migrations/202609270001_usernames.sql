-- Add searchable, unique profile handles. Existing users receive a stable handle
-- based on their name and a short id suffix; users may edit it later.

alter table public.profiles
  add column if not exists username text;

update public.profiles
set username = coalesce(
  nullif(
    left(
      trim(both '-' from regexp_replace(lower(coalesce(full_name, '')), '[^[:alnum:]]+', '-', 'g')),
      17
    ),
    ''
  ),
  'user'
) || '-' || left(replace(id::text, '-', ''), 12)
where username is null or btrim(username) = '';

alter table public.profiles
  alter column username set not null;

alter table public.profiles
  drop constraint if exists profiles_username_format_check;
alter table public.profiles
  add constraint profiles_username_format_check
  check (username ~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$');

create unique index if not exists profiles_username_lower_unique
  on public.profiles (lower(username));

create or replace function public.prepare_profile_username()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_base text;
begin
  if new.username is null or btrim(new.username) = '' then
    v_base := trim(both '-' from regexp_replace(lower(coalesce(new.full_name, '')), '[^[:alnum:]]+', '-', 'g'));
    v_base := left(v_base, 17);
    if v_base = '' then
      v_base := 'user';
    end if;
    new.username := v_base || '-' || left(replace(new.id::text, '-', ''), 12);
  else
    new.username := lower(regexp_replace(btrim(new.username), '^@', ''));
  end if;

  if new.username !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$' then
    raise exception 'Username must contain 3 to 30 letters, numbers, dots, underscores or hyphens';
  end if;
  return new;
end;
$$;

drop trigger if exists prepare_profile_username on public.profiles;
create trigger prepare_profile_username
  before insert or update of username on public.profiles
  for each row execute function public.prepare_profile_username();
