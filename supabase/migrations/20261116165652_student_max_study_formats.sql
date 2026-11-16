-- Version2 personal study artifacts. Existing version1 runs remain byte-for-byte
-- unchanged. No official assessment table, grade, payment or entitlement changes.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$declare spec text;definition text;name text;begin
 if to_regprocedure('xelay_student_private.grounded_bundle_valid(jsonb,jsonb)')is null
 or to_regprocedure('xelay_student_private.pre_study_request_valid(jsonb)')is not null then raise exception 'MAX_STUDY_PREREQUISITE_OR_DRIFT';end if;
 foreach spec in array array['request_valid(jsonb)','bundle_valid(jsonb,jsonb)','progress_valid(jsonb,jsonb)']loop
  name:=split_part(spec,'(',1);definition:=pg_get_functiondef(('xelay_student_private.'||spec)::regprocedure);
  execute replace(definition,'CREATE OR REPLACE FUNCTION xelay_student_private.'||name||'(','CREATE FUNCTION xelay_student_private.pre_study_'||name||'(');
 end loop;
end$$;
create or replace function xelay_student_private.request_valid(v jsonb)returns boolean language plpgsql immutable set search_path=''as $$begin
 if not(v?'studyFormat')then return xelay_student_private.pre_study_request_valid(v);end if;
 if jsonb_typeof(v->'studyFormat')is distinct from'string'or v->>'studyFormat'not in('true_false','gap_fill','smart_text','written','exercise','podcast')
 or v->>'mode'is distinct from(case when v->>'studyFormat'='true_false'then'quiz'else'explain'end)
 or jsonb_typeof(v->'sources')is distinct from'array'then return false;end if;
 if jsonb_array_length(v->'sources')=0 then return false;end if;
 return xelay_student_private.pre_study_request_valid(v-'studyFormat');
end$$;
create function xelay_student_private.study_text(v jsonb,n integer,allow_empty boolean default false)returns boolean
language sql immutable set search_path=''as $$select coalesce(jsonb_typeof(v)='string'and length(v#>>'{}')<=n and(allow_empty or length(btrim(v#>>'{}'))>0)
 and(v#>>'{}')!~'[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]'and(v#>>'{}')!~*'</?[a-z][^>]*>',false);$$;
create function xelay_student_private.study_valid(s jsonb,r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
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
  if source_text is null or strpos(source_text,g->'acceptedAnswers'->>0)=0 then return false;end if;
  terms:='{}';for v in select value from jsonb_array_elements(g->'acceptedAnswers')loop
   if not xelay_student_private.study_text(v,200)or lower(btrim(v#>>'{}'))=any(terms)then return false;end if;terms:=array_append(terms,lower(btrim(v#>>'{}')));
  end loop;ids:=array_append(ids,g->>'id');
 end loop;
 for g in select value from jsonb_array_elements(s->'reading')loop
  if not xelay_student_private.fields(g,array['id','text','terms','sourceId'])or not xelay_student_private.identifier(g->>'id')or(g->>'id')=any(ids)
  or not xelay_student_private.study_text(g->'text',1800)or jsonb_typeof(g->'terms')is distinct from'array'
  or not exists(select 1 from jsonb_array_elements(r->'sources')where value->>'id'=g->>'sourceId')then return false;end if;
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
  or jsonb_typeof(g->'criteria')is distinct from'array'or not exists(select 1 from jsonb_array_elements(r->'sources')where value->>'id'=g->>'sourceId')then return false;end if;
  if jsonb_array_length(g->'criteria')not between 1 and 6 then return false;end if;
  for t in select value from jsonb_array_elements(g->'criteria')loop if not xelay_student_private.study_text(t,300)then return false;end if;end loop;ids:=array_append(ids,g->>'id');
 end loop;
 for g in select value from jsonb_array_elements(s->'dialogue')loop
  if not xelay_student_private.fields(g,array['id','speaker','text','sourceId'])or not xelay_student_private.identifier(g->>'id')or(g->>'id')=any(ids)
  or g->>'speaker'not in('tutor','student')or jsonb_typeof(g->'speaker')is distinct from'string'
  or not xelay_student_private.study_text(g->'text',700)or not exists(select 1 from jsonb_array_elements(r->'sources')where value->>'id'=g->>'sourceId')then return false;end if;ids:=array_append(ids,g->>'id');
 end loop;
 return true;
end$$;
create or replace function xelay_student_private.bundle_valid(b jsonb,r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare q jsonb;base jsonb;begin
 if not(r?'studyFormat')then return xelay_student_private.pre_study_bundle_valid(b,r);end if;
 if not xelay_student_private.request_valid(r)or not xelay_student_private.fields(b,array['version','mode','title','introduction','steps','questions','cards','plan','math','citations','study'])
 or b->'version'is distinct from'2'::jsonb then return false;end if;
 base:=(b-'study')||'{"version":1}'::jsonb;
 if not xelay_student_private.pre_study_bundle_valid(base,r-'studyFormat')or not xelay_student_private.study_valid(b->'study',r)
 or b->'cards'is distinct from'[]'::jsonb or b->'plan'is distinct from'[]'::jsonb or b->'math'is distinct from'null'::jsonb then return false;end if;
 if r->>'studyFormat'='true_false'then
  for q in select value from jsonb_array_elements(b->'questions')loop if q->'options'is distinct from'["Правда","Неправда"]'::jsonb then return false;end if;end loop;
 elsif r->>'studyFormat'='smart_text'then if jsonb_array_length(b->'questions')>3 then return false;end if;
 elsif b->'questions'is distinct from'[]'::jsonb then return false;end if;
 return true;
end$$;
create or replace function xelay_student_private.progress_valid(p jsonb,b jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare pair record;v jsonb;item jsonb;written boolean;begin
 if b->'version'is distinct from'2'::jsonb then return xelay_student_private.pre_study_progress_valid(p,b);end if;
 if not xelay_student_private.fields(p,array['answers','submitted','cardRatings','doneTasks','version','studyAnswers','studySubmitted','studyRatings','studyDone'])
 or p->'version'is distinct from'2'::jsonb or jsonb_typeof(p->'studyAnswers')is distinct from'object'
 or jsonb_typeof(p->'studySubmitted')is distinct from'array'or jsonb_typeof(p->'studyRatings')is distinct from'object'
 or jsonb_typeof(p->'studyDone')is distinct from'array'or octet_length(p::text)>40000
 or not xelay_student_private.pre_study_progress_valid(p-array['version','studyAnswers','studySubmitted','studyRatings','studyDone'],b)then return false;end if;
 for pair in select key,value from jsonb_each(p->'studyAnswers')loop
  written:=false;select value into item from jsonb_array_elements(b->'study'->'gaps')where value->>'id'=pair.key;
  if item is null then select value into item from jsonb_array_elements(b->'study'->'written')where value->>'id'=pair.key;written:=true;end if;
  if item is null or not xelay_student_private.study_text(pair.value,case when written then 4000 else 200 end,true)then return false;end if;
 end loop;
 if jsonb_array_length(p->'studySubmitted')<>(select count(distinct value)from jsonb_array_elements(p->'studySubmitted'))or jsonb_array_length(p->'studyDone')<>(select count(distinct value)from jsonb_array_elements(p->'studyDone'))then return false;end if;
 for v in select value from jsonb_array_elements(p->'studySubmitted')loop
  if jsonb_typeof(v)is distinct from'string'or not(p->'studyAnswers'?(v#>>'{}'))or length(btrim(p->'studyAnswers'->>(v#>>'{}')))=0 then return false;end if;
 end loop;
 for pair in select key,value from jsonb_each(p->'studyRatings')loop
  if pair.value not in('"repeat"'::jsonb,'"known"'::jsonb)or not(p->'studySubmitted'@>jsonb_build_array(pair.key))
  or not exists(select 1 from jsonb_array_elements(b->'study'->'written')where value->>'id'=pair.key)then return false;end if;
 end loop;
 for v in select value from jsonb_array_elements(p->'studyDone')loop
  if jsonb_typeof(v)is distinct from'string'or not exists(select 1 from(select value from jsonb_array_elements(b->'study'->'reading')union all select value from jsonb_array_elements(b->'study'->'dialogue'))items where value->>'id'=v#>>'{}')then return false;end if;
 end loop;
 return true;
end$$;
create function xelay_student_private.initialize_study_progress()returns trigger language plpgsql set search_path=''as $$begin
 if new.bundle->'version'='2'::jsonb then
  if new.progress='{"answers":{},"submitted":[],"cardRatings":{},"doneTasks":[]}'::jsonb then
   new.progress:=new.progress||'{"version":2,"studyAnswers":{},"studySubmitted":[],"studyRatings":{},"studyDone":[]}'::jsonb;
  end if;
  if not xelay_student_private.progress_valid(new.progress,new.bundle)then raise exception 'MAX_STUDY_PROGRESS_INVALID'using errcode='22023';end if;
 end if;return new;
end$$;
create trigger max_initialize_study_progress before insert on xelay_student_private.runs for each row execute function xelay_student_private.initialize_study_progress();
revoke all on function xelay_student_private.pre_study_request_valid(jsonb),xelay_student_private.pre_study_bundle_valid(jsonb,jsonb),xelay_student_private.pre_study_progress_valid(jsonb,jsonb),xelay_student_private.study_text(jsonb,integer,boolean),xelay_student_private.study_valid(jsonb,jsonb),xelay_student_private.initialize_study_progress()from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
