-- Add ordinary conversation without loosening source-backed study activities.
-- No existing source, request, response, official test or grade is rewritten.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regclass('xelay_student_private.period_usage')is null
 or to_regprocedure('xelay_student_private.bundle_valid(jsonb,jsonb)')is null
 or to_regprocedure('xelay_student_private.grounded_bundle_valid(jsonb,jsonb)')is not null then
 raise exception 'MAX_CHAT_PREREQUISITE_OR_DRIFT';end if;
end$$;
create or replace function xelay_student_private.request_valid(v jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare s jsonb;seen text[]:='{}';bytes integer:=0;refs text[]:='{}';ref jsonb;begin
 if not xelay_student_private.fields(v,case when v?'conversationRunIds'then array['requestId','mode','prompt','sources','conversationRunIds']else array['requestId','mode','prompt','sources']end)
 or not xelay_student_private.identifier(v->>'requestId')or jsonb_typeof(v->'mode')is distinct from'string'
 or v->>'mode'not in('chat','explain','quiz','cards','plan','math')or jsonb_typeof(v->'prompt')is distinct from'string'
 or not xelay_student_private.plain(v->>'prompt',2400)or jsonb_typeof(v->'sources')is distinct from'array'then return false;end if;
 if jsonb_array_length(v->'sources')>3 or(v->>'mode'<>'chat'and jsonb_array_length(v->'sources')=0)
 or octet_length(v::text)>96000 then return false;end if;
 for s in select value from jsonb_array_elements(v->'sources')loop
  if not xelay_student_private.source_valid(s)or(s->>'id')=any(seen)then return false;end if;
  seen:=array_append(seen,s->>'id');bytes:=bytes+octet_length(s->>'text');
 end loop;
 if v?'conversationRunIds'then
  if jsonb_typeof(v->'conversationRunIds')is distinct from'array'then return false;end if;
  if jsonb_array_length(v->'conversationRunIds')not between 1 and 4 then return false;end if;
  for ref in select value from jsonb_array_elements(v->'conversationRunIds')loop
   if jsonb_typeof(ref)is distinct from'string'or not xelay_student_private.identifier(ref#>>'{}')
   or(ref#>>'{}')=v->>'requestId'or(ref#>>'{}')=any(refs)then return false;end if;
   refs:=array_append(refs,ref#>>'{}');
  end loop;
 end if;
 return bytes<=24000;
end$$;
-- Source staging has no task mode parameter. An empty staged set creates no
-- rows; request_valid still forbids every source-free study activity.
do $$declare definition text;needle text:='jsonb_array_length(p_sources) not between 1 and 3';begin
 definition:=pg_get_functiondef('public.xelay_max_sources_put(text,jsonb)'::regprocedure);
 if(length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'MAX_CHAT_SOURCE_STAGING_DRIFT';end if;
 execute replace(definition,needle,'jsonb_array_length(p_sources) not between 0 and 3');
end$$;
create or replace function xelay_student_private.sources_match(p_user_id uuid,p_request jsonb)returns boolean
language sql stable security definer set search_path=''as $$
 select case when xelay_student_private.request_valid(p_request)then
  not exists(select 1 from jsonb_array_elements(p_request->'sources')s where not exists(
   select 1 from xelay_student_private.sources p where p.user_id=p_user_id and p.request_id=p_request->>'requestId'
   and p.source_id=s->>'id'and p.document=s))
  and not exists(select 1 from jsonb_array_elements_text(coalesce(p_request->'conversationRunIds','[]'::jsonb))ref
   where not exists(select 1 from xelay_student_private.runs h where h.user_id=p_user_id and h.id=ref))
 else false end;
$$;
do $$declare definition text;prefix text:='CREATE OR REPLACE FUNCTION xelay_student_private.bundle_valid(';begin
 definition:=pg_get_functiondef('xelay_student_private.bundle_valid(jsonb,jsonb)'::regprocedure);
 if position(prefix in definition)<>1 then raise exception 'MAX_CHAT_BUNDLE_VALIDATOR_DRIFT';end if;
 execute replace(definition,prefix,'CREATE FUNCTION xelay_student_private.grounded_bundle_valid(');
end$$;
create or replace function xelay_student_private.bundle_valid(b jsonb,r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare s jsonb;begin
 if not xelay_student_private.request_valid(r)then return false;end if;
 if r->>'mode'<>'chat'then return xelay_student_private.grounded_bundle_valid(b,r);end if;
 if not xelay_student_private.fields(b,array['version','mode','title','introduction','steps','questions','cards','plan','math','citations'])
 or b->'version'is distinct from'1'::jsonb or b->>'mode'is distinct from'chat'
 or jsonb_typeof(b->'title')is distinct from'string'or not xelay_student_private.plain(b->>'title',160)
 or jsonb_typeof(b->'introduction')is distinct from'string'or not xelay_student_private.plain(b->>'introduction',2400)
 or octet_length(b::text)>512000 or b->'math'is distinct from'null'::jsonb
 or b->'questions'is distinct from'[]'::jsonb or b->'cards'is distinct from'[]'::jsonb or b->'plan'is distinct from'[]'::jsonb
 or jsonb_typeof(b->'steps')is distinct from'array'or jsonb_typeof(b->'citations')is distinct from'array'then return false;end if;
 if jsonb_array_length(b->'steps')>12 then return false;end if;
 for s in select value from jsonb_array_elements(b->'steps')loop
  if not xelay_student_private.fields(s,array['title','body'])or jsonb_typeof(s->'title')is distinct from'string'
  or jsonb_typeof(s->'body')is distinct from'string'or not xelay_student_private.plain(s->>'title',160)
  or not xelay_student_private.plain(s->>'body',1600)then return false;end if;
 end loop;
 if jsonb_array_length(r->'sources')=0 then return b->'citations'='[]'::jsonb;end if;
 return xelay_student_private.grounded_bundle_valid(b,r);
end$$;
revoke all on function xelay_student_private.grounded_bundle_valid(jsonb,jsonb)from public,anon,authenticated,service_role;
-- All replaced functions retain their existing narrow ACLs. The new helper is
-- private; generation/reservation/settlement keep the same budget and moderation.
notify pgrst,'reload schema';
commit;
