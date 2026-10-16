-- Append the static penguin to the current premium status allowlist only.
-- Patch the installed definition so all existing guards, ownership and ACLs stay intact.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $migration$
declare
  v_function regprocedure := to_regprocedure('public.xelay_set_participant_status(text,text)');
  v_definition text;
  v_old text := '''sticker:cheburashka'',''sticker:leopard'',''sticker:frog''];';
  v_new text := '''sticker:cheburashka'',''sticker:leopard'',''sticker:frog'',''sticker:penguin''];';
begin
  if v_function is null then
    raise exception 'Apply 202610160004_participant_animal_statuses.sql first';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_function);

  -- Fail closed if the expected setter contract changed. Nothing here broadens
  -- entitlement checks, accepted status text or the three unique emoji limit.
  if position('if v_user_id is null then' in v_definition) = 0
    or position('not public.xelay_has_participant_access(v_user_id)' in v_definition) = 0
    or position('char_length(v_text) > 48' in v_definition) = 0
    or position('cardinality(v_tokens) > 3' in v_definition) = 0
    or position('count(distinct t.emoji)' in v_definition) = 0
  then
    raise exception 'PARTICIPANT_STATUS_ALLOWLIST_CONTRACT_MISMATCH';
  end if;

  if cardinality(string_to_array(v_definition, v_old)) = 2
    and position('''sticker:penguin''' in v_definition) = 0
  then
    execute replace(v_definition, v_old, v_new);
  elsif cardinality(string_to_array(v_definition, v_new)) = 2
    and cardinality(string_to_array(v_definition, '''sticker:penguin''')) = 2
    and position(v_old in v_definition) = 0
  then
    -- Already applied; do not rewrite the function or existing preferences.
    null;
  else
    raise exception 'PARTICIPANT_STATUS_ALLOWLIST_CONTRACT_MISMATCH';
  end if;
end;
$migration$;

notify pgrst, 'reload schema';
commit;
