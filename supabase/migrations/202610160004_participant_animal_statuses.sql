-- Add leopard and frog stickers to the existing Participant status picker.
-- Replace only the existing setter; its ownership and grants stay unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.xelay_set_participant_status(text,text)') is null then
    raise exception 'Apply 202610020003_participant_statuses.sql first';
  end if;
end;
$$;

create or replace function public.xelay_set_participant_status(p_text text, p_emoji text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_text text := nullif(btrim(p_text, U&'\0009\000A\000B\000C\000D\0020\0085\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'), '');
  v_emoji text := nullif(btrim(p_emoji), '');
  v_tokens text[];
  -- Keep aligned with src/lib/participantStatus.ts. Existing single emojis stay valid.
  v_allowed text[] := array['😊','😄','😎','🥰','😍','🤩','🥹','😌','🤔','😴','😅','😂','🥳','🙃','😇','🤗','🫠','🤓','💤','❤️','🎓','📚','📖','📝','✏️','📌','📎','🗓️','⏰','💻','🧠','💡','🎯','🧪','🔬','📐','🧮','🏛️','💼','🏆','🎨','🎭','🎬','🎵','🎧','🎤','🎸','📷','🎮','🎲','⚽','🏀','🏐','🎾','🏋️','🚴','🏃','🧘','🏊','📸','🌱','🌿','🌻','🌸','🍀','🌳','🌍','🌊','⛰️','🏕️','✈️','🚀','🚂','🚗','🌙','☀️','🌈','⭐','✨','❄️','☕','🍵','🍕','🍫','🍒','🍉','🥐','🔥','⚡','💪','🙌','👏','🤝','🫶','💜','💙','💛','🤍','🖤','💬','🦛','sticker:cheburashka','sticker:leopard','sticker:frog'];
begin
  if v_user_id is null then
    raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('xelay:participant-status:' || v_user_id::text, 0)
  );
  if not public.xelay_has_participant_access(v_user_id) then
    raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  if v_text is not null and (
    char_length(v_text) > 48
    or v_text ~ '[[:cntrl:]]'
    or v_text ~ U&'[\0080-\009F\2028\2029\202A-\202E\2066-\2069]'
  ) then
    raise exception 'INVALID_PARTICIPANT_STATUS_TEXT' using errcode = '22023';
  end if;

  if v_emoji is not null then
    v_tokens := string_to_array(v_emoji, ' ');
    if cardinality(v_tokens) < 1 or cardinality(v_tokens) > 3
      or char_length(v_emoji) > 100
      or exists (select 1 from unnest(v_tokens) as t(emoji) where not (t.emoji = any(v_allowed)))
      or (select count(distinct t.emoji) from unnest(v_tokens) as t(emoji)) <> cardinality(v_tokens) then
      raise exception 'INVALID_PARTICIPANT_STATUS_EMOJI' using errcode = '22023';
    end if;
  end if;

  -- Save text and emojis together so a partial edit cannot mix separate drafts.
  insert into public.premium_preferences (user_id, status_text, emoji_status)
  values (v_user_id, v_text, v_emoji)
  on conflict (user_id) do update
    set status_text = excluded.status_text,
        emoji_status = excluded.emoji_status,
        updated_at = now();
end;
$$;

notify pgrst, 'reload schema';
commit;
