// Focused offline PostgreSQL regressions. No network, recording or live users.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './security/teaching-scoped-fixture.mjs'

test('voice grade replies retain student privacy and current scoped teacher-only writes',async t=>{
  const fx=await createTeachingScopedFixture();t.after(()=>fx.close())
  const {db,ids,groups:[a,b],dates,rpc,mutate,asUser}=fx
  await db.exec(await readFile(new URL('../supabase/migrations/202610270001_teaching_group_scopes.sql',import.meta.url),'utf8'))
  const baseline=(await db.query("select md5(pg_get_functiondef('xelay_teaching_resolve_grade_request(uuid,integer,text)'::regprocedure)) old_resolver,md5(pg_get_functiondef('xelay_teaching_grade_requests(uuid)'::regprocedure)) old_reader")).rows[0]
  // Simulate permissive legacy rules: bucket-specific restrictive policies must win.
  await db.exec(`create policy fixture_old_storage_insert on storage.objects for insert to anon,authenticated with check(true);
    create policy fixture_old_storage_read on storage.objects for select to anon,authenticated using(true);
    create policy fixture_old_storage_update on storage.objects for update to anon,authenticated using(true) with check(true);
    create policy fixture_old_storage_delete on storage.objects for delete to anon,authenticated using(true);`)
  const migration=await readFile(new URL('../supabase/migrations/202610280002_teaching_grade_voice.sql',import.meta.url),'utf8')
  await db.exec(migration)
  const createRequest=async(group=a,student=ids.studentA)=>{
    const activity=(await mutate(ids.owner,'save_activity',{id:randomUUID(),version:0,course_id:ids.course,group_id:group,title:'Synthetic graded work',activity_date:dates.lesson_a,max_points:10,category:''})).id
    return rpc(student,'xelay_teaching_request_grade',[activity,'Synthetic private grade question',randomUUID()])
  }
  const prepare=(who,request,patch={})=>rpc(who,'xelay_teaching_prepare_grade_voice',[request.id,patch.id??randomUUID(),patch.mime??'audio/webm',patch.size??128,patch.duration??4.5])
  const put=(who,voice,patch={})=>asUser(who,"insert into storage.objects(bucket_id,name,owner,metadata) values('teaching-grade-voices',$1,$2,$3::jsonb)",[voice.storage_path,who,JSON.stringify({size:voice.size,mimetype:voice.mime_type,...patch})])
  const resolve=(who,request,text,voice)=>rpc(who,'xelay_teaching_resolve_grade_request_voice',[request.id,request.version,text,voice==null?null:JSON.stringify(voice)])
  const allowed=async(who,fn,path)=>(await asUser(who,`select ${fn}($1) allowed`,[path])).rows[0].allowed
  const remove=(who,path)=>asUser(who,"delete from storage.objects where bucket_id='teaching-grade-voices' and name=$1 returning name",[path])
  let request,voice,link
  await t.test('migration retains old text RPC/read definitions, private tables and a bounded private bucket',async()=>{
    assert.deepEqual((await db.query("select md5(pg_get_functiondef('xelay_teaching_resolve_grade_request(uuid,integer,text)'::regprocedure)) old_resolver,md5(pg_get_functiondef('xelay_teaching_grade_requests(uuid)'::regprocedure)) old_reader")).rows[0],baseline)
    const bucket=(await db.query("select public,file_size_limit,allowed_mime_types from storage.buckets where id='teaching-grade-voices'")).rows[0]
    assert.equal(bucket.public,false);assert.equal(Number(bucket.file_size_limit),10485760)
    assert.deepEqual(bucket.allowed_mime_types,['audio/webm','audio/ogg','audio/mp4'])
    for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_table_privilege($1,'teaching_grade_voice_uploads','select,insert,update,delete') allowed",[role])).rows[0].allowed,false)
    for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,'xelay_teaching_prepare_grade_voice(uuid,uuid,text,bigint,numeric)','execute') allowed",[role])).rows[0].allowed,false)
  })
  await t.test('students and unrelated colleagues cannot reserve or forge a voice upload',async()=>{
    request=await createRequest()
    for(const who of [ids.studentA,ids.studentB,ids.headA,ids.outsider,ids.admin,ids.otherTeacher])await assert.rejects(prepare(who,request),/FORBIDDEN|EXPIRED|UNVERIFIED/)
    await assert.rejects(asUser(ids.studentA,"insert into storage.objects(bucket_id,name,owner,metadata) values('teaching-grade-voices',$1,$2,'{\"mimetype\":\"audio/webm\",\"size\":128}')",[`${request.id}/${ids.studentA}/${randomUUID()}.webm`,ids.studentA]),/row-level security/)
    for(const patch of [{size:0},{size:10485761},{duration:0},{duration:301},{mime:'text/html'}])await assert.rejects(prepare(ids.owner,request,patch),/VOICE_INVALID/)
    voice=await prepare(ids.owner,request)
    assert.deepEqual(Object.keys(voice).sort(),['duration_seconds','mime_type','size','storage_path'])
    assert.match(voice.storage_path,new RegExp(`^${request.id}/${ids.owner}/[0-9a-f-]+\\.webm$`))
  })
  await t.test('metadata and immutable owner-bound reservation must match the actual uploaded object',async()=>{
    await assert.rejects(put(ids.owner,voice,{size:voice.size+1}),/row-level security/)
    await assert.rejects(put(ids.owner,voice,{mimetype:'audio/mp4'}),/row-level security/)
    await assert.rejects(put(ids.otherTeacher,voice),/row-level security/)
    await assert.rejects(resolve(ids.owner,request,'',voice),/VOICE_FORBIDDEN/)
    await put(ids.owner,voice)
    await assert.rejects(resolve(ids.owner,request,'',{...voice,size:127}),/VOICE_FORBIDDEN/)
    await assert.rejects(resolve(ids.studentA,request,'',voice),/FORBIDDEN|EXPIRED|UNVERIFIED/)
    assert.equal(await allowed(ids.owner,'xelay_teaching_can_read_grade_voice',voice.storage_path),true)
    assert.equal(await allowed(ids.studentA,'xelay_teaching_can_read_grade_voice',voice.storage_path),false)
  })
  await t.test('voice-only reply resolves once; owning student can listen and another student cannot',async()=>{
    const result=await resolve(ids.owner,request,'',voice)
    assert.equal(result.status,'resolved');assert.equal(result.version,request.version+1)
    const replay=await resolve(ids.owner,request,'',voice);assert.deepEqual(replay,result)
    const own=(await rpc(ids.studentA,'xelay_teaching_grade_requests',[])).requests.find(row=>row.id===request.id)
    assert.deepEqual(own.response_voice,voice);assert.equal(own.response,'')
    const other=(await rpc(ids.studentB,'xelay_teaching_grade_requests',[])).requests
    assert.equal(other.some(row=>row.id===request.id),false)
    assert.equal(await allowed(ids.studentA,'xelay_teaching_can_read_grade_voice',voice.storage_path),true)
    for(const who of [ids.studentB,ids.headA,ids.outsider,ids.otherTeacher])assert.equal(await allowed(who,'xelay_teaching_can_read_grade_voice',voice.storage_path),false)
    for(const who of [ids.studentB,ids.outsider])assert.equal((await asUser(who,"select name from storage.objects where bucket_id='teaching-grade-voices' and name=$1",[voice.storage_path])).rows.length,0)
    assert.equal((await db.query("select count(*)::int total from teaching_grade_request_audit where grade_request_id=$1 and event='resolved'",[request.id])).rows[0].total,1)
    const notifications=(await db.query("select message from notifications where teaching_event_key like $1",[`grade-request-resolved:${request.id}:%`])).rows
    assert.equal(notifications.length,1);assert.doesNotMatch(JSON.stringify(notifications),/storage_path|audio\/|Synthetic private|grade-voices/)
    await assert.rejects(resolve(ids.owner,request,'Changed',{...voice,duration_seconds:5}),/CONFLICT/)
  })
  await t.test('sent voice cannot be deleted/replaced; unused voice may be removed even after reservation expiry',async()=>{
    assert.equal(await allowed(ids.owner,'xelay_teaching_can_remove_grade_voice',voice.storage_path),false)
    assert.equal((await remove(ids.owner,voice.storage_path)).rows.length,0)
    assert.equal((await asUser(ids.owner,"update storage.objects set metadata='{}' where bucket_id='teaching-grade-voices' and name=$1 returning name",[voice.storage_path])).rows.length,0)
    const next=await createRequest(),unused=await prepare(ids.owner,next,{mime:'audio/mp4'})
    await put(ids.owner,unused)
    await db.query("update teaching_grade_voice_uploads set created_at=now()-interval '2 hours' where storage_path=$1",[unused.storage_path])
    assert.equal(await allowed(ids.owner,'xelay_teaching_can_upload_grade_voice',unused.storage_path),false)
    await assert.rejects(resolve(ids.owner,next,'',unused),/VOICE_FORBIDDEN/)
    assert.equal(await allowed(ids.owner,'xelay_teaching_can_remove_grade_voice',unused.storage_path),true)
    assert.equal((await remove(ids.owner,unused.storage_path)).rows.length,1)
  })
  await t.test('selected-group grading controls voice creation and revocation takes effect before replay/read',async()=>{
    link=await mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['grades'],group_scope:'selected',group_ids:[a]})
    await mutate(ids.colleague,'respond_teacher',{teacher_link_id:link.id,accept:true})
    assert.equal(await allowed(ids.colleague,'xelay_teaching_can_read_grade_voice',voice.storage_path),true)
    const groupB=await createRequest(b,ids.studentB)
    await assert.rejects(prepare(ids.colleague,groupB),/FORBIDDEN/)
    const next=await createRequest(),scoped=await prepare(ids.colleague,next,{mime:'audio/ogg'})
    await put(ids.colleague,scoped)
    await mutate(ids.owner,'update_teacher',{teacher_link_id:link.id,permissions:['materials'],group_scope:'selected',group_ids:[a]})
    assert.equal(await allowed(ids.colleague,'xelay_teaching_can_read_grade_voice',voice.storage_path),false)
    await assert.rejects(resolve(ids.colleague,next,'',scoped),/FORBIDDEN/)
    assert.equal((await remove(ids.colleague,scoped.storage_path)).rows.length,1)
    await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[a,ids.studentA])
    assert.equal(await allowed(ids.studentA,'xelay_teaching_can_read_grade_voice',voice.storage_path),false)
    await db.query("update study_group_members set status='accepted' where group_id=$1 and user_id=$2",[a,ids.studentA])
  })
  await t.test('old text answer remains compatible and new typed text-plus-voice path accepts both',async()=>{
    const text=await createRequest()
    const result=await rpc(ids.owner,'xelay_teaching_resolve_grade_request',[text.id,text.version,'Existing text answer'])
    assert.equal(result.status,'resolved')
    const both=await createRequest(),audio=await prepare(ids.owner,both)
    await put(ids.owner,audio)
    assert.equal((await resolve(ids.owner,both,'Additional explanation',audio)).status,'resolved')
  })
  await t.test('bounded reservation rates cannot be bypassed by new upload IDs or metadata replays',async()=>{
    const current=await createRequest(),valid=await prepare(ids.owner,current)
    const upload=valid.storage_path.split('/')[2].split('.')[0]
    const repeat=await prepare(ids.owner,current,{id:upload});assert.deepEqual(repeat,valid)
    await assert.rejects(prepare(ids.owner,current,{id:upload,size:129}),/CONFLICT/)
    const count=Number((await db.query("select count(*) total from teaching_grade_voice_uploads where uploaded_by=$1 and created_at>now()-interval '1 hour'",[ids.owner])).rows[0].total)
    for(let i=count;i<30;i++)await prepare(ids.owner,current)
    await assert.rejects(prepare(ids.owner,current),/VOICE_RATE_LIMIT/)
  })
  await t.test('expiry and account suspension close teacher voice access before reservation or replay',async()=>{
    await db.query("insert into teacher_academic_profiles(user_id,approved_valid_until) values($1,current_date-1) on conflict(user_id) do update set approved_valid_until=current_date-1",[ids.owner])
    assert.equal(await allowed(ids.owner,'xelay_teaching_can_read_grade_voice',voice.storage_path),false)
    await assert.rejects(prepare(ids.owner,request),/EXPIRED|UNVERIFIED/)
    await assert.rejects(resolve(ids.owner,request,'',voice),/EXPIRED|UNVERIFIED/)
    await db.query('update teacher_academic_profiles set approved_valid_until=null where user_id=$1',[ids.owner])
    await db.query("update auth.users set banned_until=now()+interval '1 day' where id=$1",[ids.owner])
    assert.equal(await allowed(ids.owner,'xelay_teaching_can_read_grade_voice',voice.storage_path),false)
    await assert.rejects(resolve(ids.owner,request,'',voice),/AUTH_REQUIRED/)
  })
  await t.test('new anonymous bucket boundaries independently deny voice access without affecting public buckets',async()=>{
    // The full legacy fixture has an unrelated anonymous classroom-helper ACL
    // error. Copy ONLY the actual new policy expressions to a disposable probe,
    // preserving the real policy roles/commands, to exercise this new boundary.
    await db.exec(`create table storage.voice_policy_probe(like storage.objects including defaults);
      alter table storage.voice_policy_probe enable row level security;
      grant all on storage.voice_policy_probe to anon,authenticated;
      create policy fixture_probe_legacy_permissive on storage.voice_policy_probe for all to anon,authenticated using(true) with check(true);
      do $$ declare p record;v_roles text;v_cmd text;v_sql text;begin
        for p in select * from pg_policy where polrelid='storage.objects'::regclass and polname like 'Grade voice%' loop
          select string_agg(quote_ident(rolname),',') into v_roles from pg_roles where oid=any(p.polroles);
          v_cmd:=case p.polcmd when 'r' then 'select' when 'a' then 'insert' when 'w' then 'update' when 'd' then 'delete' else 'all' end;
          v_sql:=format('create policy %I on storage.voice_policy_probe as %s for %s to %s',p.polname,case when p.polpermissive then 'permissive' else 'restrictive' end,v_cmd,v_roles);
          if p.polqual is not null then v_sql:=v_sql||' using ('||pg_get_expr(p.polqual,p.polrelid)||')';end if;
          if p.polwithcheck is not null then v_sql:=v_sql||' with check ('||pg_get_expr(p.polwithcheck,p.polrelid)||')';end if;
          execute v_sql;
        end loop;
      end $$;
      insert into storage.voice_policy_probe(bucket_id,name) values('teaching-grade-voices','synthetic-private.webm'),('avatars','synthetic-public.png');`)
    assert.deepEqual((await asUser(null,'select name from storage.voice_policy_probe',[],{role:'anon'})).rows.map(row=>row.name),['synthetic-public.png'])
    await assert.rejects(asUser(null,"insert into storage.voice_policy_probe(bucket_id,name) values('teaching-grade-voices','forged.webm')",[],{role:'anon'}),/row-level security/)
    assert.equal((await asUser(null,"delete from storage.voice_policy_probe where bucket_id='teaching-grade-voices' returning name",[],{role:'anon'})).rows.length,0)
  })
})
