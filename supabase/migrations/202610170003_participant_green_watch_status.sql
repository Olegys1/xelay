-- Add one static sticker to the existing guarded premium status setter.
-- No entitlement, ownership, payment, table or ACL changes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
do $migration$
declare
  v_function regprocedure:=to_regprocedure('public.xelay_set_participant_status(text,text)');
  v_definition text;
  v_old text:='''sticker:cheburashka'',''sticker:leopard'',''sticker:frog'',''sticker:penguin''];';
  v_new text:='''sticker:cheburashka'',''sticker:leopard'',''sticker:frog'',''sticker:penguin'',''sticker:green-watch''];';
begin
  if v_function is null then raise exception 'Apply participant penguin status first'; end if;
  v_definition:=pg_catalog.pg_get_functiondef(v_function);
  if position('if v_user_id is null then' in v_definition)=0
    or position('not public.xelay_has_participant_access(v_user_id)' in v_definition)=0
    or position('char_length(v_text) > 48' in v_definition)=0
    or position('cardinality(v_tokens) > 3' in v_definition)=0
    or position('count(distinct t.emoji)' in v_definition)=0 then
    raise exception 'PARTICIPANT_STATUS_ALLOWLIST_CONTRACT_MISMATCH';
  end if;
  if cardinality(string_to_array(v_definition,v_old))=2 and position('''sticker:green-watch''' in v_definition)=0 then
    execute replace(v_definition,v_old,v_new);
  elsif cardinality(string_to_array(v_definition,v_new))=2
    and cardinality(string_to_array(v_definition,'''sticker:green-watch'''))=2 and position(v_old in v_definition)=0 then null;
  else raise exception 'PARTICIPANT_STATUS_ALLOWLIST_CONTRACT_MISMATCH'; end if;
end;
$migration$;
notify pgrst,'reload schema';
commit;
