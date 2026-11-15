import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration=await readFile(new URL('../../supabase/migrations/202611120100_partner_tools.sql',import.meta.url),'utf8')
const admin=randomUUID(), user=randomUUID(), disabled=randomUUID()
const fingerprint='a'.repeat(64), network='b'.repeat(64)
const payload={name:'Демонстраційний інструмент',description:'Вигаданий опис для локального тесту.',category:'study',logo_url:null,
  destination_url:'https://example.org/tool?from=xelay',status:'published',featured:true,sort_order:10}
const denied=job=>assert.rejects(job,e=>e.code==='42501')
async function fixture(){
  const db=new PGlite()
  await db.exec(`
    create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,deleted_at timestamptz,banned_until timestamptz);
    create table auth.mfa_factors(user_id uuid,status text);
    create table public.synthetic_admins(id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
    create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
    create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$;
    create function public.xelay_is_platform_admin() returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.synthetic_admins where id=auth.uid())$$;
    grant usage on schema auth,public,storage to anon,authenticated,service_role;
    grant execute on all functions in schema auth to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets,name text,metadata jsonb);
    alter table storage.objects enable row level security;
    grant all on storage.objects to anon,authenticated,service_role;
    create function storage.extension(text) returns text language sql immutable as $$select reverse(split_part(reverse($1),'.',1))$$;
    grant execute on all functions in schema storage to anon,authenticated;
    -- Simulate legacy wide policies: new restrictive boundaries must still win.
    create policy old_storage_everything on storage.objects for all to anon,authenticated using(true) with check(true);
    insert into storage.buckets values('other','other',true,null,null);
  `)
  await db.query('insert into auth.users(id) values($1),($2),($3)',[admin,user,disabled])
  await db.query('insert into synthetic_admins values($1),($2)',[admin,disabled])
  await db.query("insert into auth.mfa_factors values($1,'verified'),($2,'unverified')",[admin,disabled])
  await db.exec(migration)
  const as=async(id,sql,args=[],{role='authenticated',aal='aal2'}={})=>{
    await db.exec(`set role ${role}`)
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,aal,role})])
    try{return await db.query(sql,args)}finally{await db.exec('reset role');await db.exec('reset "request.jwt.claims"')}
  }
  const save=(data=payload,id=admin,opts)=>as(id,'select xelay_admin_save_partner_tool($1,$2) data',[data,id],opts).then(r=>r.rows[0].data)
  const list=(id=null,opts={role:'anon'})=>as(id,'select xelay_partner_tools() data',[],opts).then(r=>r.rows[0].data)
  const report=(from=null,to=null,id=admin,opts)=>as(id,'select xelay_admin_partner_tools($1,$2) data',[from,to],opts).then(r=>r.rows[0].data)
  const click=(id,fp=fingerprint,source='catalog',net=network,opts={role:'service_role'})=>as(null,
    'select xelay_record_partner_click($1,$2,$3,$4) data',[id,source,fp,net],opts).then(r=>r.rows[0].data)
  return {db,as,save,list,report,click,close:()=>db.close()}
}

test('partner catalogue exposes only published cards, guards admin MFA and concurrent edits',async t=>{
  const f=await fixture();t.after(()=>f.close())
  assert.deepEqual(await f.list(),{items:[]})
  await denied(f.save(payload,user));await denied(f.save(payload,admin,{aal:'aal1'}));await denied(f.save(payload,disabled))
  await denied(f.report(null,null,user));await denied(f.report(null,null,admin,{aal:'aal1'}))
  await denied(f.as(null,'select xelay_admin_partner_tools()',[ ],{role:'anon'}))
  await denied(f.as(null,'select * from partner_tools',[],{role:'anon'}))
  await denied(f.as(user,"insert into partner_tools(name) values('forged')"))
  const published=await f.save()
  const draft=await f.save({...payload,name:'Чернетка',status:'draft'})
  await f.save({...payload,name:'Прихована картка',status:'hidden'})
  const visible=await f.list();assert.equal(visible.items.length,1);assert.equal(visible.items[0].id,published.id)
  assert.equal('created_at' in visible.items[0],false)
  assert.equal((await f.report()).items.length,3)
  await assert.rejects(f.save({...published,name:'Concurrent stale',updated_at:'2000-01-01T00:00:00Z'}),/PARTNER_TOOL_CHANGED/)
  const edited=await f.save({...published,name:'Новий заголовок'})
  await assert.rejects(f.save({...published,name:'Second stale update'}),/PARTNER_TOOL_CHANGED/)
  assert.equal((await f.list()).items[0].name,'Новий заголовок')
  const hidden=await f.save({...edited,status:'hidden'});assert.equal(hidden.status,'hidden');assert.deepEqual(await f.list(),{items:[]})
  await denied(f.click(draft.id,fingerprint,'catalog',network,{role:'authenticated'}))
  await denied(f.click(draft.id,fingerprint,'catalog',network,{role:'anon'}))
  assert.equal((await f.click(draft.id)).counted,false)
  await assert.rejects(f.report('2025-01-01','2026-12-31'),/PARTNER_DATE_RANGE_INVALID/)
  await assert.rejects(f.report('2026-12-31','2026-01-01'),/PARTNER_DATE_RANGE_INVALID/)
  await f.db.query('update auth.users set banned_until=now()+interval\'1 day\' where id=$1',[admin]);await denied(f.report())
  await f.db.query('update auth.users set banned_until=null,deleted_at=now() where id=$1',[admin]);await denied(f.report())
})

test('destination and logo URL constraints reject executable, local, credential and parser-confusion inputs',async t=>{
  const f=await fixture();t.after(()=>f.close())
  for(const url of ['javascript:alert(1)','data:text/html,hello','http://example.org/','https://localhost/','https://tool.local/',
    'https://a.internal/','https://example.test/','https://home.arpa/','https://127.0.0.1/','https://127.1/','https://2130706433/',
    'https://0x7f000001/','https://[::1]/','https://example.org:444/','https://user:pass@example.org/',
    'https://example.org\\@127.0.0.1/','https://example.org/%0d%0aLocation:evil','https://example.org./','https://example.org/%zz']){
    await assert.rejects(f.save({...payload,destination_url:url}),/PARTNER_INPUT_INVALID/,url)
    await assert.rejects(f.save({...payload,logo_url:url}),/PARTNER_INPUT_INVALID/,url)
  }
  const row=await f.save({...payload,destination_url:'https://example.org:443/path?q=a%20b#details',logo_url:'https://cdn.example.org/a.png'})
  assert.match(row.destination_url,/^https:/)
  for(const changed of [{...payload,featured:'true'},{...payload,sort_order:1.5},{...payload,category:'unapproved'},
    {...payload,description:''},{...payload,description:'x'.repeat(241)},{...payload,name:'x'},
    {...payload,name:'x'.repeat(81)},{...payload,sort_order:10000},{...payload,name:'\u0000'}, {...payload,unexpected:'injected'}])await assert.rejects(f.save(changed))
})

test('catalogue capacity and public result size are bounded without preventing existing-card edits',async t=>{
  const f=await fixture();t.after(()=>f.close())
  await f.db.exec("insert into partner_tools(name,description,destination_url,status) select 'Synthetic card '||n,'Synthetic only','https://example.org/','published' from generate_series(1,500) n")
  assert.equal((await f.list()).items.length,500)
  await assert.rejects(f.save({...payload,name:'Card 501'}),/PARTNER_CATALOG_LIMIT/)
  const row=(await f.report()).items[0];const {clicks,...editable}=row
  assert.equal((await f.save({...editable,name:'Edited within capacity'})).name,'Edited within capacity')
  await f.db.exec("insert into partner_tools(name,description,destination_url,status) values('Synthetic owner bypass','Synthetic only','https://example.org/','published')")
  assert.equal((await f.list()).items.length,500)
})

test('server-only click counter dedupes rolling thirty minutes across sources, caps network bursts and preserves daily totals',async t=>{
  const f=await fixture();t.after(()=>f.close());const card=await f.save()
  assert.equal((await f.click(card.id)).counted,true)
  assert.equal((await f.click(card.id,fingerprint,'home')).counted,false)
  assert.equal((await f.click(card.id,'c'.repeat(64),'home')).counted,true)
  assert.equal((await f.report()).items[0].clicks,2)
  assert.equal((await f.report()).daily.reduce((n,r)=>n+Number(r.clicks),0),2)
  await f.db.query("update partner_tool_click_dedupe set last_counted_at=clock_timestamp()-interval '31 minutes' where fingerprint=$1",[fingerprint])
  assert.equal((await f.click(card.id,fingerprint,'home')).counted,true)
  await f.db.query("update partner_tool_click_rate set hits=600,window_started_at=clock_timestamp() where fingerprint=$1",[network])
  assert.equal((await f.click(card.id,'d'.repeat(64))).counted,false)
  assert.equal((await f.report()).items[0].clicks,3)
  await f.db.query("update partner_tool_click_rate set window_started_at=clock_timestamp()-interval '2 minutes' where fingerprint=$1",[network])
  assert.equal((await f.click(card.id,'d'.repeat(64))).counted,true)
  const today=(await f.report()).daily[0].date
  assert.equal((await f.report(today,today)).items[0].clicks,4)
  assert.equal((await f.report('2025-01-01','2025-01-02')).items[0].clicks,0)
  for(const table of ['partner_tool_click_daily','partner_tool_click_dedupe','partner_tool_click_rate'])await denied(f.as(user,`select * from ${table}`))
  await assert.rejects(f.click(card.id,'e'.repeat(64),'not-real'),/PARTNER_INPUT_INVALID/)
  await assert.rejects(f.click(card.id,'not-a-hash'),/PARTNER_INPUT_INVALID/)
  await f.db.exec('set role service_role');await f.db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})])
  try {
    const all=await Promise.all(Array.from({length:20},()=>f.db.query('select xelay_record_partner_click($1,$2,$3,$4) data',[card.id,'catalog','f'.repeat(64),network])))
    assert.equal(all.filter(r=>r.rows[0].data.counted).length,1)
  }finally{await f.db.exec('reset role');await f.db.exec('reset "request.jwt.claims"')}
  assert.equal((await f.report()).items[0].clicks,5)
})

test('partner logo writes stay admin-only even with legacy permissive storage policies',async t=>{
  const f=await fixture();t.after(()=>f.close())
  const bucket=(await f.db.query("select * from storage.buckets where id='partner-logos'")).rows[0]
  assert.equal(bucket.public,true);assert.equal(Number(bucket.file_size_limit),2097152)
  assert.deepEqual(bucket.allowed_mime_types,['image/png','image/jpeg','image/webp'])
  const insert=(who,name,opts)=>f.as(who,"insert into storage.objects(bucket_id,name,metadata) values('partner-logos',$1,'{}') returning id",[name],opts)
  await denied(insert(user,'forged.png'));await denied(insert(null,'anon.png',{role:'anon'}));await denied(insert(admin,'aal1.png',{aal:'aal1'}))
  await denied(insert(admin,'payload.svg'))
  const logo=await insert(admin,'approved/logo.png')
  assert.equal((await f.as(null,"select id from storage.objects where bucket_id='partner-logos'",[],{role:'anon'})).rows.length,1)
  assert.equal((await f.as(user,'delete from storage.objects where id=$1 returning id',[logo.rows[0].id])).rows.length,0)
  await denied(f.as(user,"insert into storage.objects(bucket_id,name) values('other','x.png') returning id").then(async r=>
    f.as(user,"update storage.objects set bucket_id='partner-logos' where id=$1",[r.rows[0].id])))
  await f.as(admin,'delete from storage.objects where id=$1',[logo.rows[0].id])
})
