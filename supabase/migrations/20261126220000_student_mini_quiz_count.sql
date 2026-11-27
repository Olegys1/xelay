-- Allow personal Mini quizzes of up to30 questions without rewriting saved runs.
-- Plan quizzes remain capped at20; other modes at12. Ownership, source checks,
-- moderation, metering, private privileges and official assessments are unchanged.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$begin
 if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
  where p.oid=to_regprocedure('xelay_student_private.grounded_bundle_valid(jsonb,jsonb)')
  and md5(btrim(replace(p.prosrc,E'\r',''),E' \n\t'))='6d8f98e590824b6bc026698bf2297db5'
  and p.provolatile='i'and not p.prosecdef and l.lanname='plpgsql'
  and p.proconfig=array['search_path=""'])then
  raise exception 'MINI_QUIZ_COUNT_PREREQUISITE_OR_DRIFT: grounded_bundle_valid';end if;
 if not exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_language l on l.oid=p.prolang
  where p.oid=to_regprocedure('xelay_student_private.pre_study_progress_valid(jsonb,jsonb)')
  and md5(btrim(replace(p.prosrc,E'\r',''),E' \n\t'))='9a1455eb75b14718afb1654007df4e4e'
  and p.provolatile='i'and not p.prosecdef and l.lanname='plpgsql'
  and p.proconfig=array['search_path=""'])then
  raise exception 'MINI_QUIZ_COUNT_PREREQUISITE_OR_DRIFT: pre_study_progress_valid';end if;
end$$;
create or replace function xelay_student_private.grounded_bundle_valid(b jsonb,r jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare q jsonb;c jsonb;p jsonb;x jsonb;ids text[]:='{}';assigned text[]:='{}';qid jsonb;begin
 if not xelay_student_private.fields(b,array['version','mode','title','introduction','steps','questions','cards','plan','math','citations']) or b->'version'<>'1'::jsonb or b->>'mode'<>r->>'mode'
 or not xelay_student_private.plain(b->>'title',160) or not xelay_student_private.plain(b->>'introduction',2400) or octet_length(b::text)>512000 then return false;end if;
 foreach x in array array[b->'steps',b->'questions',b->'cards',b->'plan',b->'citations']loop if jsonb_typeof(x)<>'array' then return false;end if;end loop;
 if jsonb_array_length(b->'questions')>(case when r->>'mode'='quiz'then 30 when r->>'mode'='plan'then 20 else 12 end) or jsonb_array_length(b->'cards')>24 or jsonb_array_length(b->'plan')>14 or jsonb_array_length(b->'steps')>12 or (case when jsonb_array_length(r->'sources')=0 then jsonb_array_length(b->'citations')<>0 else jsonb_array_length(b->'citations') not between 1 and 12 end) then return false;end if;
 for q in select value from jsonb_array_elements(b->'questions')loop
  if not xelay_student_private.fields(q,array['id','text','options','correctIndex','explanation','sourceId']) or not xelay_student_private.identifier(q->>'id') or(q->>'id')=any(ids)
  or not xelay_student_private.plain(q->>'text',1000) or not xelay_student_private.plain(q->>'explanation',1400) or jsonb_typeof(q->'options')<>'array' then return false;end if;
  if jsonb_array_length(q->'options') not between 2 and 6 or jsonb_typeof(q->'correctIndex')<>'number' or(q->>'correctIndex')!~'^[0-5]$' or(q->>'correctIndex')::integer>=jsonb_array_length(q->'options') then return false;end if;
  for x in select value from jsonb_array_elements(q->'options')loop if jsonb_typeof(x)<>'string' or not xelay_student_private.plain(x#>>'{}',500) then return false;end if;end loop;
  if not xelay_student_private.topic_reference_valid(q->'sourceId',r)then return false;end if;ids:=array_append(ids,q->>'id');
 end loop;ids:='{}';
 for c in select value from jsonb_array_elements(b->'cards')loop
  if not xelay_student_private.fields(c,array['id','front','back','sourceId']) or not xelay_student_private.identifier(c->>'id') or(c->>'id')=any(ids) or not xelay_student_private.plain(c->>'front',500) or not xelay_student_private.plain(c->>'back',1200)
  or not xelay_student_private.topic_reference_valid(c->'sourceId',r)then return false;end if;ids:=array_append(ids,c->>'id');
 end loop;ids:='{}';
 for p in select value from jsonb_array_elements(b->'plan')loop
  if not xelay_student_private.fields(p,case when p?'questionIds'then array['id','label','minutes','tasks','questionIds']else array['id','label','minutes','tasks']end) or not xelay_student_private.identifier(p->>'id') or(p->>'id')=any(ids) or not xelay_student_private.plain(p->>'label',120) or(p->>'minutes')!~'^[0-9]{1,3}$' or(p->>'minutes')::integer not between 5 and 240 or jsonb_typeof(p->'tasks')<>'array' then return false;end if;
  if jsonb_array_length(p->'tasks') not between 1 and 8 then return false;end if;for x in select value from jsonb_array_elements(p->'tasks')loop if jsonb_typeof(x)<>'string' or not xelay_student_private.plain(x#>>'{}',300)then return false;end if;end loop;ids:=array_append(ids,p->>'id');

  if p?'questionIds'then
   if r->>'mode'<>'plan'or jsonb_typeof(p->'questionIds')is distinct from'array'then return false;end if;
   if jsonb_array_length(p->'questionIds')not between 1 and 3 then return false;end if;
   for qid in select value from jsonb_array_elements(p->'questionIds')loop
    if jsonb_typeof(qid)is distinct from'string'or(qid#>>'{}')=any(assigned)
    or not exists(select 1 from jsonb_array_elements(b->'questions')as question_row(value) where question_row.value->>'id'=(qid#>>'{}'))then return false;end if;
    assigned:=array_append(assigned,qid#>>'{}');
   end loop;
  end if;
 end loop;
 if cardinality(assigned)>0 and(cardinality(assigned)<>jsonb_array_length(b->'questions')or exists(select 1 from jsonb_array_elements(b->'plan')as block_row(value) where not(block_row.value?'questionIds')))then return false;end if;
 for c in select value from jsonb_array_elements(b->'citations')loop
  if not xelay_student_private.fields(c,array['sourceId','quote']) or not xelay_student_private.plain(c->>'quote',600) or not exists(select 1 from jsonb_array_elements(r->'sources')s where s->>'id'=c->>'sourceId' and strpos(s->>'text',c->>'quote')>0)then return false;end if;
 end loop;
 if b->>'mode'='quiz' and jsonb_array_length(b->'questions')=0 or b->>'mode'='cards' and jsonb_array_length(b->'cards')=0 or b->>'mode'='plan' and jsonb_array_length(b->'plan')=0 or b->>'mode'='explain' and jsonb_array_length(b->'steps')=0 then return false;end if;
 return true;
end$$;
create or replace function xelay_student_private.pre_study_progress_valid(p jsonb,b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare pair record;v jsonb;q jsonb;parts text[];begin
 if not xelay_student_private.fields(p,array['answers','submitted','cardRatings','doneTasks']) or jsonb_typeof(p->'answers')<>'object' or jsonb_typeof(p->'submitted')<>'array' or jsonb_typeof(p->'cardRatings')<>'object' or jsonb_typeof(p->'doneTasks')<>'array' or octet_length(p::text)>12000 then return false;end if;
 for pair in select key,value from jsonb_each(p->'answers')loop
  select value into q from jsonb_array_elements(b->'questions')where value->>'id'=pair.key;
  if q is null or jsonb_typeof(pair.value)<>'number' or(pair.value#>>'{}')!~'^[0-5]$' or(pair.value#>>'{}')::integer>=jsonb_array_length(q->'options')then return false;end if;
 end loop;
 if jsonb_array_length(p->'submitted')>least(jsonb_array_length(b->'questions'),case when b->>'mode'='quiz'then 30 when b->>'mode'='plan'then 20 else 12 end) or jsonb_array_length(p->'submitted')<>(select count(distinct value)from jsonb_array_elements(p->'submitted'))or jsonb_array_length(p->'doneTasks')>112 or jsonb_array_length(p->'doneTasks')<>(select count(distinct value)from jsonb_array_elements(p->'doneTasks'))then return false;end if;
 for v in select value from jsonb_array_elements(p->'submitted')loop if jsonb_typeof(v)<>'string' or not(p->'answers' ? (v#>>'{}'))then return false;end if;end loop;
 for pair in select key,value from jsonb_each(p->'cardRatings')loop if not exists(select 1 from jsonb_array_elements(b->'cards')c where c->>'id'=pair.key)or pair.value not in('"known"'::jsonb,'"repeat"'::jsonb)then return false;end if;end loop;
 for v in select value from jsonb_array_elements(p->'doneTasks')loop
  if jsonb_typeof(v)<>'string' or(v#>>'{}')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}:[0-7]$'then return false;end if;
  parts:=string_to_array(v#>>'{}',':');select value into q from jsonb_array_elements(b->'plan')where value->>'id'=parts[1];
  if q is null or parts[2]::integer>=jsonb_array_length(q->'tasks')then return false;end if;
 end loop;return true;
end$$;
-- CREATE OR REPLACE retains the existing private function ACLs.
notify pgrst,'reload schema';
commit;
