-- Private notes/review metadata. Generated material and progress stay in the
-- existing owner-scoped runs table. No official tests, grades or payment rows change.
begin;
set local lock_timeout='5s';set local statement_timeout='60s';
do $$begin
 if to_regprocedure('xelay_student_private.caller()')is null or to_regclass('xelay_student_private.runs')is null
 or to_regclass('xelay_student_private.library_documents')is not null then raise exception 'STUDENT_LIBRARY_PREREQUISITE_OR_DRIFT';end if;
end$$;
create index student_library_run_archive on xelay_student_private.runs(user_id,created_at desc,id desc)where(bundle->>'mode')<>'chat';
create table xelay_student_private.library_documents(
 user_id uuid primary key references public.profiles(id)on delete cascade,
 document jsonb not null default '{"version":1,"notes":[],"reviews":[]}',
 revision bigint not null default 0 check(revision between 0 and 2147483647),updated_at timestamptz not null default clock_timestamp(),
 check(octet_length(document::text)<=212000)
);
create table xelay_student_private.library_mutations(
 user_id uuid not null references public.profiles(id)on delete cascade,mutation_id text not null,
 fingerprint text not null,accepted_revision bigint not null,created_at timestamptz not null default clock_timestamp(),
 primary key(user_id,mutation_id),check(length(mutation_id)between 1 and 80),check(fingerprint~'^[a-f0-9]{64}$')
);
alter table xelay_student_private.library_documents enable row level security;
alter table xelay_student_private.library_mutations enable row level security;
revoke all on xelay_student_private.library_documents,xelay_student_private.library_mutations from public,anon,authenticated,service_role;

create function xelay_student_private.library_can_edit(u uuid)returns boolean language sql stable security definer set search_path=''as $$
 select coalesce(e->>'audience'='student'and e->>'planId'in('plus','max')and(e->>'expiresAt')::timestamptz>clock_timestamp(),false)
 from(select xelay_student_private.entitlement(u)e)s;
$$;
create function xelay_student_private.library_snapshot(u uuid)returns jsonb language sql stable security definer set search_path=''as $$
 select jsonb_build_object('revision',coalesce(d.revision,0),'document',coalesce(d.document,'{"version":1,"notes":[],"reviews":[]}'::jsonb),
 'updatedAt',d.updated_at,'canEdit',xelay_student_private.library_can_edit(u))
 from(select 1)s left join xelay_student_private.library_documents d on d.user_id=u;
$$;
create function xelay_student_private.library_document_valid(u uuid,v jsonb)returns boolean language plpgsql stable security definer set search_path=''as $$
declare n jsonb;r jsonb;b jsonb;seen text[]:='{}';refs text[]:='{}';ref text;begin
 if v is null or octet_length(v::text)>212000 then return false;end if;
 if not xelay_student_private.fields(v,array['version','notes','reviews'])or v->'version'<>'1'::jsonb
 or jsonb_typeof(v->'notes')is distinct from'array'or jsonb_typeof(v->'reviews')is distinct from'array'
 or jsonb_array_length(v->'notes')>64 or jsonb_array_length(v->'reviews')>1000 then return false;end if;
 for n in select value from jsonb_array_elements(v->'notes')loop
  if not xelay_student_private.fields(n,array['id','title','subject','text','updatedAt'])or jsonb_typeof(n->'id')is distinct from'string'or not xelay_student_private.identifier(n->>'id')
  or(n->>'id')=any(seen)or jsonb_typeof(n->'title')is distinct from'string'or length(n->>'title')>200 or not xelay_student_private.plain(n->>'title',200)
  or jsonb_typeof(n->'subject')is distinct from'string'or length(n->>'subject')>100
  or((n->>'subject')<>''and not xelay_student_private.plain(n->>'subject',100))
  or jsonb_typeof(n->'text')is distinct from'string'or length(n->>'text')>20000
  or((n->>'text')<>''and not xelay_student_private.plain(n->>'text',20000))
  or jsonb_typeof(n->'updatedAt')is distinct from'string'or length(n->>'updatedAt')not between 20 and 40
  or(n->>'updatedAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'then return false;end if;
  begin perform(n->>'updatedAt')::timestamptz;exception when others then return false;end;
  seen:=array_append(seen,n->>'id');
 end loop;
 seen:='{}';
 for r in select value from jsonb_array_elements(v->'reviews')loop
  if not xelay_student_private.fields(r,array['id','runId','itemId','kind','rating','dueAt','intervalDays','repetitions'])
  or jsonb_typeof(r->'id')is distinct from'string'or not xelay_student_private.identifier(r->>'id')or(r->>'id')=any(seen)
  or jsonb_typeof(r->'runId')is distinct from'string'or jsonb_typeof(r->'itemId')is distinct from'string'
  or not xelay_student_private.identifier(r->>'runId')or not xelay_student_private.identifier(r->>'itemId')
  or r->>'kind'is null or r->>'kind'not in('card','mistake')or r->>'rating'is null or r->>'rating'not in('again','hard','good','easy')
  or jsonb_typeof(r->'intervalDays')is distinct from'number'or(r->>'intervalDays')!~'^[0-9]{1,3}$'or(r->>'intervalDays')::integer>365
  or jsonb_typeof(r->'repetitions')is distinct from'number'or(r->>'repetitions')!~'^[0-9]{1,5}$'or(r->>'repetitions')::integer>10000
  or jsonb_typeof(r->'dueAt')is distinct from'string'or length(r->>'dueAt')not between 20 and 40
  or(r->>'dueAt')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'then return false;end if;
  begin perform(r->>'dueAt')::timestamptz;exception when others then return false;end;
  ref:=(r->>'kind')||':'||(r->>'runId')||':'||(r->>'itemId');if ref=any(refs)then return false;end if;
  select bundle into b from xelay_student_private.runs where user_id=u and id=r->>'runId';
  if b is null then return false;end if;
  if not exists(select 1 from jsonb_array_elements(coalesce(b->case when r->>'kind'='card'then'cards'else'questions'end,'[]'::jsonb))i where i->>'id'=r->>'itemId')then return false;end if;
  seen:=array_append(seen,r->>'id');refs:=array_append(refs,ref);
 end loop;
 -- JSONB text adds one separator space per field and between array items.
 -- The strict shape checks above make that overhead exact, so this enforces
 -- the same compact UTF-8 limit as the browser/API without changing its cap.
 return octet_length(v::text)-(5+9*jsonb_array_length(v->'notes')+15*jsonb_array_length(v->'reviews')
  +greatest(jsonb_array_length(v->'notes')-1,0)+greatest(jsonb_array_length(v->'reviews')-1,0))<=192000;
end$$;
create function xelay_student_private.library_run_json(r xelay_student_private.runs)returns jsonb language sql stable set search_path=''as $$
 select jsonb_build_object('id',r.id,'createdAt',r.created_at,'demo',false,'request',r.request,'bundle',r.bundle,'progress',r.progress,'revision',r.revision);
$$;
create function xelay_student_private.library_run_page(u uuid,p_cursor text)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare cursor_row xelay_student_private.runs;r xelay_student_private.runs;items jsonb:='[]';candidate jsonb;last_id text;more boolean;begin
 if p_cursor is not null then
  if not xelay_student_private.identifier(p_cursor)then raise exception 'LIBRARY_CURSOR_INVALID'using errcode='22023';end if;
  select*into cursor_row from xelay_student_private.runs where user_id=u and id=p_cursor and bundle->>'mode'<>'chat';
  if not found then raise exception 'LIBRARY_CURSOR_REQUIRED'using errcode='42501';end if;
 end if;
 for r in select*from xelay_student_private.runs where user_id=u and bundle->>'mode'<>'chat'
 and(p_cursor is null or(created_at,id)<(cursor_row.created_at,cursor_row.id))order by created_at desc,id desc limit 30 loop
  candidate:=xelay_student_private.library_run_json(r);
  if octet_length((items||jsonb_build_array(candidate))::text)>1350000 then
   if jsonb_array_length(items)=0 then raise exception 'LIBRARY_RUN_TOO_LARGE'using errcode='54000';end if;exit;
  end if;
  items:=items||jsonb_build_array(candidate);last_id:=r.id;
 end loop;
 more:=last_id is not null and exists(select 1 from xelay_student_private.runs t join xelay_student_private.runs last_row on last_row.user_id=u and last_row.id=last_id
  where t.user_id=u and t.bundle->>'mode'<>'chat'and(t.created_at,t.id)<(last_row.created_at,last_row.id));
 return jsonb_build_object('runs',items,'nextCursor',case when more then last_id else null end);
end$$;
create function public.xelay_student_library_get(p_cursor text default null)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();begin
 return xelay_student_private.library_snapshot(u)||xelay_student_private.library_run_page(u,p_cursor);
end$$;
create function public.xelay_student_library_run(p_run_id text)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();r xelay_student_private.runs;begin
 if not xelay_student_private.identifier(p_run_id)then raise exception 'LIBRARY_RUN_INVALID'using errcode='22023';end if;
 select*into r from xelay_student_private.runs where user_id=u and id=p_run_id;
 if not found then raise exception 'LIBRARY_RUN_REQUIRED'using errcode='42501';end if;
 return xelay_student_private.library_run_json(r);
end$$;
create function public.xelay_student_library_runs_batch(p_run_ids text[])returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();item text;r xelay_student_private.runs;candidate jsonb;items jsonb:='[]';remaining text[]:='{}';full_page boolean:=false;begin
 if p_run_ids is null or cardinality(p_run_ids)not between 1 and 30 or cardinality(p_run_ids)<>(select count(distinct x)from unnest(p_run_ids)x)
 or exists(select 1 from unnest(p_run_ids)x where not xelay_student_private.identifier(x))then raise exception 'LIBRARY_BATCH_INVALID'using errcode='22023';end if;
 if exists(select 1 from unnest(p_run_ids)x where not exists(select 1 from xelay_student_private.runs where user_id=u and id=x))then raise exception 'LIBRARY_RUN_REQUIRED'using errcode='42501';end if;
 foreach item in array p_run_ids loop
  if full_page then remaining:=array_append(remaining,item);continue;end if;
  select*into r from xelay_student_private.runs where user_id=u and id=item;
  candidate:=xelay_student_private.library_run_json(r);
  if octet_length((items||jsonb_build_array(candidate))::text)>1350000 then
   if jsonb_array_length(items)=0 then raise exception 'LIBRARY_RUN_TOO_LARGE'using errcode='54000';end if;
   full_page:=true;remaining:=array_append(remaining,item);
  else items:=items||jsonb_build_array(candidate);end if;
 end loop;
 return jsonb_build_object('runs',items,'nextRunIds',to_jsonb(remaining));
end$$;
create function public.xelay_student_library_put(p_document jsonb,p_expected_revision bigint,p_mutation_id text)returns jsonb language plpgsql security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();m xelay_student_private.library_mutations;d xelay_student_private.library_documents;finger text;begin
 if p_expected_revision is null or p_expected_revision not between 0 and 2147483646 or not xelay_student_private.identifier(p_mutation_id)
 or not xelay_student_private.library_document_valid(u,p_document)then raise exception 'LIBRARY_DOCUMENT_INVALID'using errcode='22023';end if;
 if not xelay_student_private.library_can_edit(u)then raise exception 'LIBRARY_EDIT_REQUIRED'using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('student-library:'||u::text,0));
 finger:=encode(sha256(convert_to(p_document::text||':'||p_expected_revision::text,'UTF8')),'hex');
 select*into m from xelay_student_private.library_mutations where user_id=u and mutation_id=p_mutation_id;
 if found then
  if m.fingerprint<>finger then raise exception 'LIBRARY_MUTATION_CONFLICT'using errcode='PT409';end if;
  return jsonb_build_object('state','saved','acceptedRevision',m.accepted_revision,'replayed',true)||xelay_student_private.library_snapshot(u);
 end if;
 insert into xelay_student_private.library_documents(user_id)values(u)on conflict do nothing;
 select*into d from xelay_student_private.library_documents where user_id=u for update;
 if d.revision<>p_expected_revision then return jsonb_build_object('state','conflict')||xelay_student_private.library_snapshot(u);end if;
 if(select count(*)from xelay_student_private.library_mutations where user_id=u and created_at>clock_timestamp()-interval'1 minute')>=120 then raise exception 'LIBRARY_WRITE_RATE_LIMIT'using errcode='PT429';end if;
 update xelay_student_private.library_documents set document=p_document,revision=revision+1,updated_at=clock_timestamp()where user_id=u returning*into d;
 insert into xelay_student_private.library_mutations(user_id,mutation_id,fingerprint,accepted_revision)values(u,p_mutation_id,finger,d.revision);
 delete from xelay_student_private.library_mutations where user_id=u and mutation_id in(select mutation_id from xelay_student_private.library_mutations where user_id=u order by accepted_revision desc offset 256);
 return jsonb_build_object('state','saved','acceptedRevision',d.revision,'replayed',false)||xelay_student_private.library_snapshot(u);
end$$;
revoke all on function xelay_student_private.library_can_edit(uuid),xelay_student_private.library_snapshot(uuid),xelay_student_private.library_document_valid(uuid,jsonb),xelay_student_private.library_run_json(xelay_student_private.runs),xelay_student_private.library_run_page(uuid,text)from public,anon,authenticated,service_role;
revoke all on function public.xelay_student_library_get(text),public.xelay_student_library_run(text),public.xelay_student_library_runs_batch(text[]),public.xelay_student_library_put(jsonb,bigint,text)from public,anon,authenticated,service_role;
grant execute on function public.xelay_student_library_get(text),public.xelay_student_library_run(text),public.xelay_student_library_runs_batch(text[]),public.xelay_student_library_put(jsonb,bigint,text)to authenticated;
commit;
