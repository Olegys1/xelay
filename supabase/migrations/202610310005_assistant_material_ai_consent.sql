-- LOCAL PREPARATION ONLY. Separate author opt-in, false for every old material.
-- No model dispatch, billing, target changes or previous consent backfill.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$begin
 if to_regclass('public.study_group_materials') is null or to_regclass('public.teaching_items') is null
   or to_regprocedure('public.xelay_can_read_study_group_materials(uuid)') is null
   or to_regprocedure('public.xelay_teaching_can_read_item(uuid,uuid)') is null then
   raise exception 'ASSISTANT_MATERIAL_AI_PREREQUISITES_MISSING';
 end if;
end $$;
create table public.assistant_material_ai_consents(
 source_kind text not null check(source_kind in('study','teaching')),
 material_id uuid not null,
 author_id uuid not null references auth.users(id) on delete cascade,
 allowed boolean not null default false,
 material_version text not null check(material_version ~ '^[a-f0-9]{32}$'),
 revision bigint not null default 1 check(revision>0),
 changed_at timestamptz not null default clock_timestamp(),
 primary key(source_kind,material_id)
);
alter table public.assistant_material_ai_consents enable row level security;
revoke all on table public.assistant_material_ai_consents from public,anon,authenticated,service_role;

-- Private helper uses the existing material-view predicates, never an admin
-- role supplied by a caller. A source edit invalidates the old bound consent.
create function public.xelay_private_assistant_material_source(p_kind text,p_material_id uuid,p_lock boolean default false)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare u uuid:=auth.uid();s jsonb;v text;owned_files boolean;
begin
 if u is null or p_material_id is null or p_kind is null or p_kind not in('study','teaching')
   or not exists(select 1 from auth.users where id=u and email_confirmed_at is not null and deleted_at is null
     and(banned_until is null or banned_until<=clock_timestamp())) then
   raise exception 'ASSISTANT_MATERIAL_FORBIDDEN' using errcode='42501';end if;
 if p_kind='study' then
   if p_lock then select to_jsonb(m) into s from public.study_group_materials m where id=p_material_id for update;
   else select to_jsonb(m) into s from public.study_group_materials m where id=p_material_id;end if;
   if s is null or not public.xelay_can_read_study_group_materials((s->>'group_id')::uuid) then
     raise exception 'ASSISTANT_MATERIAL_FORBIDDEN' using errcode='42501';end if;
 else
   if p_lock then select to_jsonb(m) into s from public.teaching_items m where id=p_material_id and kind='material' for update;
   else select to_jsonb(m) into s from public.teaching_items m where id=p_material_id and kind='material';end if;
   if s is null or s->>'withdrawn_at' is not null or not public.xelay_teaching_can_read_item(p_material_id,u) then
     raise exception 'ASSISTANT_MATERIAL_FORBIDDEN' using errcode='42501';end if;
 end if;
 if jsonb_typeof(s->'attachments') is distinct from 'array' or jsonb_array_length(s->'attachments')>20 then
   raise exception 'ASSISTANT_MATERIAL_INVALID' using errcode='22023';end if;
 -- A copied descriptor cannot let a different author grant AI access to
 -- another person's protected bytes. Replace borrowed files with owned ones.
 select not exists(select 1 from jsonb_array_elements(s->'attachments') f
   where coalesce(f->>'storage_path',f->>'path','') !~ '^[a-fA-F0-9-]{36}/[a-fA-F0-9-]{36}/[a-fA-F0-9-]{36}[.][a-zA-Z0-9]{1,5}$'
     or split_part(coalesce(f->>'storage_path',f->>'path',''),'/',2) is distinct from s->>'created_by') into owned_files;
 v:=pg_catalog.md5(jsonb_build_object('source',p_kind,'id',p_material_id,'title',s->'title','body',s->'body',
   'attachments',s->'attachments','links',s->'links','author',s->'created_by','version',s->'version',
   'updated',s->'updated_at','status',s->'status','access_until',s->'access_until','withdrawn_at',s->'withdrawn_at')::text);
 return jsonb_build_object('id',p_material_id,'sourceKind',p_kind,'materialVersion',v,'canChange',s->>'created_by'=u::text,'courseId',s->>'course_id','groupId',s->>'group_id',
   'authorId',s->>'created_by','ownedFiles',owned_files,'title',s->>'title','body',s->>'body','attachments',s->'attachments');
end $$;

create function public.xelay_assistant_material_ai(p_kind text,p_material_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s jsonb;c public.assistant_material_ai_consents%rowtype;effective boolean;revision bigint;
begin
 s:=public.xelay_private_assistant_material_source(p_kind,p_material_id,false);
 select * into c from public.assistant_material_ai_consents where source_kind=p_kind and material_id=p_material_id
   and author_id=(s->>'authorId')::uuid;
 revision:=coalesce(c.revision,0);
 effective:=coalesce(c.allowed and c.material_version=s->>'materialVersion' and(s->>'ownedFiles')::boolean,false);
 return (s-'authorId'-'ownedFiles')||jsonb_build_object('allowAi',effective,
   'rightsVersion',pg_catalog.md5((s->>'materialVersion')||':'||revision::text));
end $$;

create function public.xelay_assistant_material_ai_batch(p_kind text,p_material_ids uuid[])
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare item uuid;g jsonb;result jsonb:='[]'::jsonb;
begin
 if p_material_ids is null or cardinality(p_material_ids)>101 or array_position(p_material_ids,null) is not null then
   raise exception 'ASSISTANT_MATERIAL_INVALID' using errcode='22023';end if;
 foreach item in array p_material_ids loop
   g:=public.xelay_assistant_material_ai(p_kind,item);
   result:=result||jsonb_build_array(g-'title'-'body'-'attachments');
 end loop;
 return result;
end $$;

create function public.xelay_assistant_set_material_ai(p_kind text,p_material_id uuid,p_allow boolean,p_expected_version text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare s jsonb;g jsonb;v_revision bigint;
begin
 if p_allow is null or p_expected_version is null or p_expected_version !~ '^[a-f0-9]{32}$' then
   raise exception 'ASSISTANT_MATERIAL_INVALID' using errcode='22023';end if;
 s:=public.xelay_private_assistant_material_source(p_kind,p_material_id,true);
 if (s->>'canChange')::boolean is distinct from true then
   raise exception 'ASSISTANT_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
 if p_allow and(s->>'ownedFiles')::boolean is distinct from true then
   raise exception 'ASSISTANT_MATERIAL_OWNED_FILES_REQUIRED' using errcode='42501';end if;
 select revision into v_revision from public.assistant_material_ai_consents where source_kind=p_kind and material_id=p_material_id for update;
 g:=public.xelay_assistant_material_ai(p_kind,p_material_id);
 if g->>'rightsVersion' is distinct from p_expected_version then
   raise exception 'ASSISTANT_MATERIAL_CHANGED' using errcode='PT409';end if;
 insert into public.assistant_material_ai_consents(source_kind,material_id,author_id,allowed,material_version)
 values(p_kind,p_material_id,auth.uid(),p_allow,s->>'materialVersion')
 on conflict(source_kind,material_id) do update set allowed=excluded.allowed,author_id=excluded.author_id,
   material_version=excluded.material_version,revision=public.assistant_material_ai_consents.revision+1,changed_at=clock_timestamp();
 return public.xelay_assistant_material_ai(p_kind,p_material_id)-'title'-'body'-'attachments';
end $$;
revoke all on function public.xelay_private_assistant_material_source(text,uuid,boolean),public.xelay_assistant_material_ai(text,uuid),
 public.xelay_assistant_material_ai_batch(text,uuid[]),public.xelay_assistant_set_material_ai(text,uuid,boolean,text)
 from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_material_ai(text,uuid),public.xelay_assistant_material_ai_batch(text,uuid[]),
 public.xelay_assistant_set_material_ai(text,uuid,boolean,text) to authenticated;
comment on table public.assistant_material_ai_consents is 'Separate current author opt-in. Existing materials remain AI-blocked. Source content/file updates invalidate the bound permission; colleagues cannot change it. No model call or previous-consent backfill.';
notify pgrst,'reload schema';
commit;
