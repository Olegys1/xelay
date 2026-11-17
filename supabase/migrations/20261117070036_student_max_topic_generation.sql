-- Topic-only personal learning and a saved quiz for each plan step.
-- No official assessment, existing run, grade, grant, price or allowance is rewritten.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regprocedure('xelay_student_private.pre_study_request_valid(jsonb)')is null
 or to_regprocedure('xelay_student_private.study_valid(jsonb,jsonb)')is null
 or to_regprocedure('xelay_student_private.topic_reference_valid(jsonb,jsonb)')is not null then raise exception 'MAX_TOPIC_PREREQUISITE_OR_DRIFT';end if;
end$$;
create function xelay_student_private.topic_reference_valid(v jsonb,r jsonb)returns boolean language sql immutable set search_path=''as $$
 select coalesce(jsonb_typeof(v)='string'and case when jsonb_array_length(r->'sources')=0 then v='""'::jsonb
 else exists(select 1 from jsonb_array_elements(r->'sources')s where s->'id'=v)end,false);
$$;
create or replace function xelay_student_private.pre_study_request_valid(v jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare s jsonb;seen text[]:='{}';bytes integer:=0;refs text[]:='{}';ref jsonb;begin
 if not xelay_student_private.fields(v,case when v?'conversationRunIds'then array['requestId','mode','prompt','sources','conversationRunIds']else array['requestId','mode','prompt','sources']end)
 or not xelay_student_private.identifier(v->>'requestId')or jsonb_typeof(v->'mode')is distinct from'string'
 or v->>'mode'not in('chat','explain','quiz','cards','plan','math')or jsonb_typeof(v->'prompt')is distinct from'string'
 or not xelay_student_private.plain(v->>'prompt',2400)or jsonb_typeof(v->'sources')is distinct from'array'then return false;end if;
 if jsonb_array_length(v->'sources')>3
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
create or replace function xelay_student_private.request_valid(v jsonb)returns boolean language plpgsql immutable set search_path=''as $$begin
 if not(v?'studyFormat')then return xelay_student_private.pre_study_request_valid(v);end if;
 if jsonb_typeof(v->'studyFormat')is distinct from'string'or v->>'studyFormat'not in('true_false','gap_fill','smart_text','written','exercise','podcast')
 or v->>'mode'is distinct from(case when v->>'studyFormat'='true_false'then'quiz'else'explain'end)
 or jsonb_typeof(v->'sources')is distinct from'array'then return false;end if;
 return xelay_student_private.pre_study_request_valid(v-'studyFormat');
end$$;
create or replace function xelay_student_private.grounded_bundle_valid(b jsonb,r jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare q jsonb;c jsonb;p jsonb;x jsonb;ids text[]:='{}';assigned text[]:='{}';qid jsonb;begin
 if not xelay_student_private.fields(b,array['version','mode','title','introduction','steps','questions','cards','plan','math','citations']) or b->'version'<>'1'::jsonb or b->>'mode'<>r->>'mode'
 or not xelay_student_private.plain(b->>'title',160) or not xelay_student_private.plain(b->>'introduction',2400) or octet_length(b::text)>512000 then return false;end if;
 foreach x in array array[b->'steps',b->'questions',b->'cards',b->'plan',b->'citations']loop if jsonb_typeof(x)<>'array' then return false;end if;end loop;
 if jsonb_array_length(b->'questions')>(case when r->>'mode'='plan'then 20 else 12 end) or jsonb_array_length(b->'cards')>24 or jsonb_array_length(b->'plan')>14 or jsonb_array_length(b->'steps')>12 or (case when jsonb_array_length(r->'sources')=0 then jsonb_array_length(b->'citations')<>0 else jsonb_array_length(b->'citations') not between 1 and 12 end) then return false;end if;
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
create or replace function xelay_student_private.study_valid(s jsonb,r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare g jsonb;v jsonb;t jsonb;ids text[]:='{}';terms text[];source_text text;format text:=r->>'studyFormat';begin
 if not xelay_student_private.fields(s,array['format','gaps','reading','written','dialogue'])or s->>'format'is distinct from format
 or octet_length(s::text)>120000 then return false;end if;
 foreach v in array array[s->'gaps',s->'reading',s->'written',s->'dialogue']loop if jsonb_typeof(v)is distinct from'array'then return false;end if;end loop;
 if jsonb_array_length(s->'gaps')>12 or jsonb_array_length(s->'reading')>10 or jsonb_array_length(s->'written')>4 or jsonb_array_length(s->'dialogue')>24 then return false;end if;
 if(format='gap_fill'and jsonb_array_length(s->'gaps')=0)or(format<>'gap_fill'and jsonb_array_length(s->'gaps')<>0)
 or(format='smart_text'and jsonb_array_length(s->'reading')=0)or(format<>'smart_text'and jsonb_array_length(s->'reading')<>0)
 or(format in('written','exercise')and jsonb_array_length(s->'written')=0)or(format not in('written','exercise')and jsonb_array_length(s->'written')<>0)
 or(format='podcast'and jsonb_array_length(s->'dialogue')<2)or(format<>'podcast'and jsonb_array_length(s->'dialogue')<>0)then return false;end if;
 for g in select value from(select value from jsonb_array_elements(s->'gaps')union all select value from jsonb_array_elements(s->'reading')union all select value from jsonb_array_elements(s->'written')union all select value from jsonb_array_elements(s->'dialogue'))items loop
  if jsonb_typeof(g->'id')is distinct from'string'or jsonb_typeof(g->'sourceId')is distinct from'string'then return false;end if;
 end loop;
 for g in select value from jsonb_array_elements(s->'gaps')loop
  if not xelay_student_private.fields(g,array['id','before','after','acceptedAnswers','explanation','sourceId'])or not xelay_student_private.identifier(g->>'id')or(g->>'id')=any(ids)
  or not xelay_student_private.study_text(g->'before',1000,true)or not xelay_student_private.study_text(g->'after',1000,true)
  or length(btrim((g->>'before')||(g->>'after')))=0 or not xelay_student_private.study_text(g->'explanation',1200)
  or jsonb_typeof(g->'acceptedAnswers')is distinct from'array'then return false;end if;
  if jsonb_array_length(g->'acceptedAnswers')not between 1 and 5 then return false;end if;
  select value->>'text'into source_text from jsonb_array_elements(r->'sources')where value->>'id'=g->>'sourceId';
  if not xelay_student_private.topic_reference_valid(g->'sourceId',r)or(jsonb_array_length(r->'sources')>0 and(source_text is null or strpos(source_text,g->'acceptedAnswers'->>0)=0))then return false;end if;
  terms:='{}';for v in select value from jsonb_array_elements(g->'acceptedAnswers')loop
   if not xelay_student_private.study_text(v,200)or lower(btrim(v#>>'{}'))=any(terms)then return false;end if;terms:=array_append(terms,lower(btrim(v#>>'{}')));
  end loop;ids:=array_append(ids,g->>'id');
 end loop;
 for g in select value from jsonb_array_elements(s->'reading')loop
  if not xelay_student_private.fields(g,array['id','text','terms','sourceId'])or not xelay_student_private.identifier(g->>'id')or(g->>'id')=any(ids)
  or not xelay_student_private.study_text(g->'text',1800)or jsonb_typeof(g->'terms')is distinct from'array'
  or not xelay_student_private.topic_reference_valid(g->'sourceId',r)then return false;end if;
  if jsonb_array_length(g->'terms')>6 then return false;end if;terms:='{}';
  for t in select value from jsonb_array_elements(g->'terms')loop
   if not xelay_student_private.fields(t,array['term','explanation'])or not xelay_student_private.study_text(t->'term',100)
   or not xelay_student_private.study_text(t->'explanation',600)or strpos(g->>'text',t->>'term')=0 or lower(t->>'term')=any(terms)then return false;end if;
   terms:=array_append(terms,lower(t->>'term'));
  end loop;ids:=array_append(ids,g->>'id');
 end loop;
 for g in select value from jsonb_array_elements(s->'written')loop
  if not xelay_student_private.fields(g,array['id','prompt','criteria','modelAnswer','sourceId'])or not xelay_student_private.identifier(g->>'id')or(g->>'id')=any(ids)
  or not xelay_student_private.study_text(g->'prompt',1000)or not xelay_student_private.study_text(g->'modelAnswer',1800)
  or jsonb_typeof(g->'criteria')is distinct from'array'or not xelay_student_private.topic_reference_valid(g->'sourceId',r)then return false;end if;
  if jsonb_array_length(g->'criteria')not between 1 and 6 then return false;end if;
  for t in select value from jsonb_array_elements(g->'criteria')loop if not xelay_student_private.study_text(t,300)then return false;end if;end loop;ids:=array_append(ids,g->>'id');
 end loop;
 for g in select value from jsonb_array_elements(s->'dialogue')loop
  if not xelay_student_private.fields(g,array['id','speaker','text','sourceId'])or not xelay_student_private.identifier(g->>'id')or(g->>'id')=any(ids)
  or g->>'speaker'not in('tutor','student')or jsonb_typeof(g->'speaker')is distinct from'string'
  or not xelay_student_private.study_text(g->'text',700)or not xelay_student_private.topic_reference_valid(g->'sourceId',r)then return false;end if;ids:=array_append(ids,g->>'id');
 end loop;
 return true;
end$$;
create or replace function xelay_student_private.pre_study_progress_valid(p jsonb,b jsonb) returns boolean language plpgsql immutable set search_path='' as $$
declare pair record;v jsonb;q jsonb;parts text[];begin
 if not xelay_student_private.fields(p,array['answers','submitted','cardRatings','doneTasks']) or jsonb_typeof(p->'answers')<>'object' or jsonb_typeof(p->'submitted')<>'array' or jsonb_typeof(p->'cardRatings')<>'object' or jsonb_typeof(p->'doneTasks')<>'array' or octet_length(p::text)>12000 then return false;end if;
 for pair in select key,value from jsonb_each(p->'answers')loop
  select value into q from jsonb_array_elements(b->'questions')where value->>'id'=pair.key;
  if q is null or jsonb_typeof(pair.value)<>'number' or(pair.value#>>'{}')!~'^[0-5]$' or(pair.value#>>'{}')::integer>=jsonb_array_length(q->'options')then return false;end if;
 end loop;
 if jsonb_array_length(p->'submitted')>(case when b->>'mode'='plan'then least(20,jsonb_array_length(b->'questions'))else 12 end) or jsonb_array_length(p->'submitted')<>(select count(distinct value)from jsonb_array_elements(p->'submitted'))or jsonb_array_length(p->'doneTasks')>112 or jsonb_array_length(p->'doneTasks')<>(select count(distinct value)from jsonb_array_elements(p->'doneTasks'))then return false;end if;
 for v in select value from jsonb_array_elements(p->'submitted')loop if jsonb_typeof(v)<>'string' or not(p->'answers' ? (v#>>'{}'))then return false;end if;end loop;
 for pair in select key,value from jsonb_each(p->'cardRatings')loop if not exists(select 1 from jsonb_array_elements(b->'cards')c where c->>'id'=pair.key)or pair.value not in('"known"'::jsonb,'"repeat"'::jsonb)then return false;end if;end loop;
 for v in select value from jsonb_array_elements(p->'doneTasks')loop
  if jsonb_typeof(v)<>'string' or(v#>>'{}')!~'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}:[0-7]$'then return false;end if;
  parts:=string_to_array(v#>>'{}',':');select value into q from jsonb_array_elements(b->'plan')where value->>'id'=parts[1];
  if q is null or parts[2]::integer>=jsonb_array_length(q->'tasks')then return false;end if;
 end loop;return true;
end$$;
revoke all on function xelay_student_private.topic_reference_valid(jsonb,jsonb)from public,anon,authenticated,service_role;
-- Replaced validators retain their narrow private ACLs. Caller identity, RLS,
-- immutable source/history ownership, moderation, reservation and charging stay mandatory.
notify pgrst,'reload schema';
commit;
