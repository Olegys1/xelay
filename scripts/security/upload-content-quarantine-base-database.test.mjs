// Executes exactly upload quarantine migration003 without optional retirement004.
// No cloud connection, real account, working files or audit environment is used.
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'
const PGlite=createRequire(path.join(fileURLToPath(new URL('../../',import.meta.url)),'package.json'))('@electric-sql/pglite').PGlite
const root=fileURLToPath(new URL('../../',import.meta.url))
// All SQL is executed only by the isolated in-memory fixture below.
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const group = id(11), otherGroup = id(12), author = id(2), classmate = id(5), teacher = id(1), head = id(3), pending = id(6)
const filePath = `${group}/${author}/${id(101)}.pdf`, presentationId = id(102)
let db, legacyBefore, legacyAfter
async function actor(user, operation) {
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.role','authenticated',false); select set_config('request.jwt.claim.sub','${user}',false)`)
  try { return await operation() } finally { await db.exec("reset role; select set_config('request.jwt.claim.role','',false); select set_config('request.jwt.claim.sub','',false)") }
}
const draft = (overrides = {}) => ({ subject: 'Економічна теорія', title: 'Ринкова рівновага', lesson_date: '2026-10-27', description: 'Презентація після заняття', links: [{ label: 'Презентація', url: 'https://example.org/presentation.pdf' }], attachments: [], ...overrides })
const save = (id, version, data) => db.query('select public.xelay_save_group_presentation($1::uuid,$2::uuid,$3::integer,$4::jsonb) as item', [group, id, version, JSON.stringify(data)])

before(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    create table public.study_groups(id uuid primary key, representative_id uuid not null);
    create table public.study_group_members(group_id uuid,user_id uuid,status text);
    create table public.profiles(id uuid primary key,full_name text);
    create table public.study_group_material_subjects(group_id uuid,name text);
    create table public.study_group_schedule(group_id uuid,subject text);
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant select,insert,update,delete on storage.objects to anon,authenticated;
    create policy "Legacy permissive storage policy" on storage.objects for all to anon,authenticated using(true) with check(true);
    create function public.xelay_study_group_permissions(p_group uuid) returns text[] language sql stable security definer as $$
      select case when exists(select 1 from public.study_groups where id=p_group and representative_id=auth.uid()) then array['materials']::text[] else '{}'::text[] end $$;
    insert into public.study_groups values('${group}','${head}'),('${otherGroup}','${head}');
    insert into public.study_group_members values('${group}','${author}','accepted'),('${group}','${classmate}','accepted'),('${group}','${pending}','pending');
    insert into public.profiles values('${author}','Марія Прикладенко'),('${classmate}','Назар Прикладенко'),('${teacher}','Викладач Прикладенко'),('${head}','Староста Прикладенко');
    insert into public.study_group_schedule values('${group}','Економічна теорія');
  `)
  const source = await readFile(path.join(root, 'supabase/migrations/202610050002_study_group_materials.sql'), 'utf8')
  for (const name of ['xelay_material_file_mime', 'xelay_material_file_path_valid', 'xelay_material_links_valid', 'xelay_material_attachments_valid']) {
    const definition = source.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))?.[0]
    assert.ok(definition, `Existing dependency ${name} found`); await db.exec(definition)
  }
  await db.exec(await readFile(path.join(root, 'supabase/migrations/202610270010_student_group_presentations.sql'), 'utf8'))  // Real presentation feature fixture above; other table shapes below isolate
  // the generic descriptor gate and do not stand in for feature authorization.
  await db.exec(`
    create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
    create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
    insert into auth.users select id,now(),null,null from public.profiles;
    alter role service_role bypassrls;
    grant select,delete on storage.objects to service_role;
    alter table storage.objects add column owner uuid default auth.uid();
    alter table storage.objects add column owner_id text default auth.uid()::text;
    alter table storage.objects add column created_at timestamptz default now();
    alter table storage.objects add column updated_at timestamptz default now();
    alter table storage.objects add column version text default gen_random_uuid()::text;
    create table public.teaching_items(id uuid primary key,attachments jsonb not null default '[]');
    create table public.teaching_submissions(id uuid primary key,attachments jsonb not null default '[]',draft_attachments jsonb not null default '[]');
    create table public.teaching_submission_history(id uuid primary key,attachments jsonb not null default '[]');
    create table public.study_group_materials(id uuid primary key,attachments jsonb not null default '[]');
    insert into storage.buckets(id,name,public) values('xelay-teaching-files','xelay-teaching-files',false),('xelay-submission-files','xelay-submission-files',false),('xelay-study-materials','xelay-study-materials',false),('teaching-grade-voices','teaching-grade-voices',false);
  `)
  const teaching=await readFile(path.join(root,'supabase/migrations/202610130002_teaching_workspace.sql'),'utf8')
  const allowed=teaching.match(/create or replace function public\.xelay_teaching_file_allowed\([\s\S]*?\n\$\$;/)?.[0]
  assert.ok(allowed);await db.exec(allowed)
  await actor(author,()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('xelay-group-presentations',$1,$2::jsonb)",[group+'/'+author+'/'+id(800)+'.pdf',JSON.stringify({size:20,mimetype:'application/pdf'})]))
  await actor(author,()=>save(id(802),0,draft({links:[],attachments:[{path:group+'/'+author+'/'+id(800)+'.pdf',file_name:'Legacy.pdf',mime_type:'application/pdf',file_size:20}]})))
  await actor(author,()=>db.query("insert into storage.objects(bucket_id,name,metadata) values('xelay-group-presentations',$1,$2::jsonb)",[group+'/'+author+'/'+id(804)+'.pdf',JSON.stringify({size:20,mimetype:'application/pdf'})]))
  legacyBefore = (await db.query("select (select jsonb_agg(to_jsonb(o) order by o.id) from storage.objects o) as objects,(select jsonb_agg(to_jsonb(p) order by p.id) from study_group_presentations p) as presentations")).rows
  await db.exec(await readFile(path.join(root,'supabase/migrations/202610300003_upload_content_quarantine.sql'),'utf8'))
  legacyAfter = (await db.query("select (select jsonb_agg(to_jsonb(o) order by o.id) from storage.objects o) as objects,(select jsonb_agg(to_jsonb(p) order by p.id) from study_group_presentations p) as presentations")).rows
  await db.query('insert into auth.users values($1,now(),null,null)',[id(901)])
  await db.query('insert into profiles values($1,$2)',[id(901),'Synthetic rejection fixture'])
  await db.query("insert into study_group_members values($1,$2,'accepted')",[group,id(901)])

})
after(async()=>{await db?.close()})
const buckets=['xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials']
const metadata=(size=20)=>JSON.stringify({size,mimetype:'application/pdf'})
const legacyPath=group+'/'+author+'/'+id(800)+'.pdf'
const objectPath=(n,who=author)=>group+'/'+who+'/'+id(n)+'.pdf'
const rows=async(sql,args=[])=>(await db.query(sql,args)).rows
const upload=async(bucket,name,size=20,who=author)=>actor(who,()=>db.query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3::jsonb)',[bucket,name,metadata(size)]))
const candidate=async(bucket,name,who=author)=>(await actor(who,()=>db.query('select public.xelay_upload_scan_candidate($1,$2) value',[bucket,name]))).rows[0].value
const service=async(operation)=>{
  await db.exec("set role service_role;select set_config('request.jwt.claim.role','service_role',false);select set_config('request.jwt.claim.sub','',false)")
  try{return await operation()}finally{await db.exec("reset role;select set_config('request.jwt.claim.role','',false)")}
}
const record=async(snapshot,changes={})=>(await service(()=>db.query('select public.xelay_record_upload_content_verification($1::jsonb,$2,$3,$4,$5) value',[
  JSON.stringify(snapshot),'a'.repeat(64),'b'.repeat(64),changes.mime||'application/pdf',changes.version??1,
]))).rows[0].value
const ready=async(bucket,name)=>(await rows('select public.xelay_upload_object_verified($1,$2) value',[bucket,name]))[0].value
const visible=async(bucket,name,who=classmate)=>(await actor(who,()=>db.query('select id from storage.objects where bucket_id=$1 and name=$2',[bucket,name]))).rows.length
const denied=promise=>assert.rejects(promise,error=>error.code==='42501')

test('migration003 preserves all pre-existing object metadata and published presentation rows byte-for-byte',async()=>{
  assert.deepEqual(legacyAfter,legacyBefore)
  const receipts=await rows("select verification_kind,content_sha256,validation_sha256 from xelay_upload_content_receipts order by object_id")
  assert.equal(receipts.length,2);assert.ok(receipts.every(row=>row.verification_kind==='legacy_inventory'&&row.content_sha256===null&&row.validation_sha256===null))
  assert.equal((await rows("select to_regprocedure('public.xelay_reject_unverified_upload(jsonb)') as retirement"))[0].retirement,null)
})

test('receipt and budget tables and recording RPC cannot be forged or read by ordinary users',async()=>{
  for(const table of ['xelay_upload_content_receipts','xelay_upload_scan_budgets']){
    await denied(actor(author,()=>db.query('select * from public.'+table)))
    await denied(service(()=>db.query('select * from public.'+table)))
  }
  await denied(actor(author,()=>db.query("insert into public.xelay_upload_scan_budgets values($1,now(),0,0)",[author])))
  await denied(actor(author,()=>db.query('select public.xelay_record_upload_content_verification($1::jsonb,$2,$3,$4,1)',['{}','a'.repeat(64),'b'.repeat(64),'application/pdf'])))
  for(const role of ['anon','authenticated']){
    const result=await rows("select has_function_privilege($1,'public.xelay_record_upload_content_verification(jsonb,text,text,text,integer)','EXECUTE') allowed",[role]);assert.equal(result[0].allowed,false)
  }
})

test('legacy is an exact pre-migration inventory, not proof of a content scan and not a timestamp bypass',async()=>{
  assert.equal(await ready('xelay-group-presentations',legacyPath),true)
  assert.equal(await visible('xelay-group-presentations',legacyPath),1)
  const old=await candidate('xelay-group-presentations',legacyPath)
  assert.equal(old.already_verified,false,'Grandfathered objects have not been advertised as scanned')
  const name=objectPath(801)
  await actor(author,()=>db.query("insert into storage.objects(bucket_id,name,metadata,created_at,updated_at) values('xelay-group-presentations',$1,$2::jsonb,'2000-01-01','2000-01-01')",[name,metadata()]))
  assert.equal(await ready('xelay-group-presentations',name),false)
  assert.equal(await visible('xelay-group-presentations',name),0)
})

test('four academic buckets quarantine new objects and an exact service receipt releases the additional gate',async()=>{
  for(const [i,bucket]of buckets.entries()){
    const name=objectPath(810+i);await upload(bucket,name)
    assert.equal(await visible(bucket,name),0)
    assert.equal(await visible(bucket,name,author),0,'Even the uploader cannot issue a readable/signed object before verification')
    const snapshot=await candidate(bucket,name)
    assert.equal(snapshot.owner_id,author);assert.equal(snapshot.already_verified,false)
    assert.equal(snapshot.bucket_id,bucket);assert.equal(snapshot.storage_path,name);assert.equal(snapshot.size,20)
    assert.equal(await record(snapshot),true)
    assert.equal(await ready(bucket,name),true);assert.equal((await candidate(bucket,name)).already_verified,true)
    if(bucket==='xelay-group-presentations'){
      assert.equal(await visible(bucket,name),0,'Verification supplements the feature policy and must not publish an unbound presentation file')
      await actor(author,()=>save(id(803),0,draft({links:[],attachments:[{path:name,file_name:'Verified.pdf',mime_type:'application/pdf',file_size:20}]})))
    }
    assert.equal(await visible(bucket,name),1)
  }
})

test('other users and unauthenticated role cannot ask the server to scan an object or charge its owner budget',async()=>{
  const name=objectPath(820);await upload('xelay-group-presentations',name)
  const before=await rows('select attempts,total_bytes from public.xelay_upload_scan_budgets where owner_id=$1',[author])
  await denied(candidate('xelay-group-presentations',name,classmate))
  await denied(service(()=>db.query('select public.xelay_upload_scan_candidate($1,$2)',['xelay-group-presentations',name])))
  assert.deepEqual(await rows('select attempts,total_bytes from public.xelay_upload_scan_budgets where owner_id=$1',[author]),before)
})

test('service receipt rejects stale snapshot, wrong type/version and caller-added metadata fields',async()=>{
  const name=objectPath(830);await upload('xelay-group-presentations',name)
  const snapshot=await candidate('xelay-group-presentations',name)
  assert.equal(await record(snapshot,{mime:'text/html'}),false)
  await assert.rejects(record(snapshot,{version:2}),error=>error.code==='22023')
  assert.equal(await record({...snapshot,size:21}),false)
  assert.equal(await record({...snapshot,owner_id:classmate}),false)
  assert.equal(await record({...snapshot,extra:'must not be accepted'}),false)
  await db.query("update storage.objects set updated_at=clock_timestamp(),version='replacement-v2' where bucket_id=$1 and name=$2",['xelay-group-presentations',name])
  assert.equal(await record(snapshot),false)
  assert.equal(await ready('xelay-group-presentations',name),false)
  assert.equal(await record(await candidate('xelay-group-presentations',name)),true)
})

test('an overwrite or delete immediately invalidates both verified and legacy receipts; ordinary overwrite is blocked',async()=>{
  const name=objectPath(840);await upload('xelay-group-presentations',name)
  assert.equal(await record(await candidate('xelay-group-presentations',name)),true)
  const update=await actor(author,()=>db.query("update storage.objects set metadata=metadata||'{\"other\":true}'::jsonb where bucket_id=$1 and name=$2 returning id",['xelay-group-presentations',name]))
  assert.equal(update.rows.length,0)
  assert.equal(await ready('xelay-group-presentations',name),true)
  await db.query("update storage.objects set metadata=metadata||'{\"other\":true}'::jsonb where bucket_id=$1 and name=$2",['xelay-group-presentations',name])
  assert.equal(await ready('xelay-group-presentations',name),false);assert.equal(await visible('xelay-group-presentations',name),0)
  await db.query('update storage.objects set updated_at=clock_timestamp() where bucket_id=$1 and name=$2',['xelay-group-presentations',legacyPath])
  assert.equal(await ready('xelay-group-presentations',legacyPath),false)
  const next=await candidate('xelay-group-presentations',name);assert.equal(await record(next),true)
  await db.query('delete from storage.objects where bucket_id=$1 and name=$2',['xelay-group-presentations',name])
  await upload('xelay-group-presentations',name)
  assert.equal(await ready('xelay-group-presentations',name),false)
  assert.equal(await record(next),false,'A recreated path has another object id/version and cannot reuse its receipt')
})

test('unverified descriptors cannot bind to teaching items, submission drafts/history, group materials or actual presentation RPC',async()=>{
  for(const [i,bucket]of buckets.entries()){
    const name=objectPath(850+i);await upload(bucket,name)
    const teaching={storage_path:name,name:'tiny.pdf',mime_type:'application/pdf',size:20}
    const material={path:name,file_name:'tiny.pdf',mime_type:'application/pdf',file_size:20}
    const file=bucket.includes('teaching')||bucket.includes('submission')?teaching:material
    let writes
    if(bucket==='xelay-teaching-files')writes=()=>db.query('insert into public.teaching_items(id,attachments) values($1,$2::jsonb)',[id(860+i),JSON.stringify([file])])
    else if(bucket==='xelay-submission-files')writes=()=>db.query('insert into public.teaching_submissions(id,draft_attachments) values($1,$2::jsonb)',[id(860+i),JSON.stringify([file])])
    else if(bucket==='xelay-study-materials')writes=()=>db.query('insert into public.study_group_materials(id,attachments) values($1,$2::jsonb)',[id(860+i),JSON.stringify([file])])
    else writes=()=>actor(author,()=>save(id(860+i),0,draft({links:[],attachments:[file]})))
    await assert.rejects(writes(),/UPLOAD_VERIFICATION_REQUIRED/)
    if(bucket==='xelay-submission-files')await assert.rejects(db.query('insert into public.teaching_submission_history(id,attachments)values($1,$2::jsonb)',[id(899),JSON.stringify([file])]),/UPLOAD_VERIFICATION_REQUIRED/)
    assert.equal(await record(await candidate(bucket,name)),true)
    await writes()
  }
})

test('a verified receipt never replaces the existing presentation author or group permissions',async()=>{
  const name=objectPath(870);await upload('xelay-group-presentations',name)
  assert.equal(await record(await candidate('xelay-group-presentations',name)),true)
  const file={path:name,file_name:'tiny.pdf',mime_type:'application/pdf',file_size:20}
  const saved=await actor(author,()=>save(id(871),0,draft({links:[],attachments:[file]})))
  assert.equal(saved.rows[0].item.created_by,author)
  await denied(actor(classmate,()=>save(id(871),1,draft({links:[],attachments:[file]}))))
  assert.equal(await visible('xelay-group-presentations',name,teacher),0)
})

test('unverified scan budget is atomic and bounded, while already-scanned reuse consumes no attempts',async()=>{
  const who=id(880), name=objectPath(881,who)
  await db.query('insert into auth.users values($1,now(),null,null)',[who])
  await db.query("insert into study_group_members values($1,$2,'accepted')",[group,who])
  await upload('xelay-group-presentations',name,20,who)
  let snapshot
  for(let i=0;i<20;i++)snapshot=await candidate('xelay-group-presentations',name,who)
  await assert.rejects(candidate('xelay-group-presentations',name,who),error=>error.code==='PT429')
  assert.equal(await record(snapshot),true)
  const before=await rows('select attempts,total_bytes from public.xelay_upload_scan_budgets where owner_id=$1',[who])
  for(let i=0;i<3;i++)assert.equal((await candidate('xelay-group-presentations',name,who)).already_verified,true)
  assert.deepEqual(await rows('select attempts,total_bytes from public.xelay_upload_scan_budgets where owner_id=$1',[who]),before)
})

test('250 MiB budget stops the sixth 50 MiB metadata candidate without allocating or downloading a large object',async()=>{
  const who=id(890),name=objectPath(891,who)
  await db.query('insert into auth.users values($1,now(),null,null)',[who])
  await db.query("insert into study_group_members values($1,$2,'accepted')",[group,who])
  await upload('xelay-group-presentations',name,52428800,who)
  for(let i=0;i<5;i++)await candidate('xelay-group-presentations',name,who)
  await assert.rejects(candidate('xelay-group-presentations',name,who),error=>error.code==='PT429')
  const budget=await rows('select attempts,total_bytes::text bytes from public.xelay_upload_scan_budgets where owner_id=$1',[who])
  assert.deepEqual(budget,[{attempts:5,bytes:'262144000'}])
})

test('unrelated voice bucket is outside this new content gate',async()=>{
  await db.query("insert into storage.objects(bucket_id,name,metadata)values('teaching-grade-voices','unrelated-voice','{}')")
  const result=await actor(classmate,()=>db.query("select name from storage.objects where bucket_id='teaching-grade-voices'"))
  assert.equal(result.rows.length,1,'This fixture only checks exclusion, not voice feature authorization')
})
