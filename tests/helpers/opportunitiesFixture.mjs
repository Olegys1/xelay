import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export async function opportunitiesFixture({ release = false } = {}) {
  const db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claim.role',true),''),'authenticated')$$;
    create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('aal',coalesce(nullif(current_setting('request.jwt.claim.aal',true),''),'aal1'))$$;
    create table auth.mfa_factors(user_id uuid,status text);
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz default now(),deleted_at timestamptz,banned_until timestamptz,raw_user_meta_data jsonb default '{}');
    create table public.profiles(id uuid primary key,full_name text,university_id uuid,faculty text,year integer,academic_unit_id uuid,study_year integer,specialty text);
    create table public.user_roles(user_id uuid,role text);
    create table public.universities(id uuid primary key,name text);
    create table public.notification_preferences(user_id uuid,notifications_enabled boolean,email_notifications_enabled boolean);
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text,owner uuid,metadata jsonb,updated_at timestamptz);
    create function public.xelay_is_platform_admin() returns boolean language sql stable security definer as $$select exists(select 1 from public.user_roles where user_id=auth.uid() and role='ADMIN')$$;
    create function public.xelay_has_participant_access(uuid) returns boolean language sql stable as $$select false$$;
    grant usage on schema auth,public,storage to anon,authenticated,service_role;
    grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;
  `)
  const base = await readFile(new URL('../../supabase/migrations/202610110001_opportunities_workspace.sql', import.meta.url),'utf8')
  const migration = await readFile(new URL('../../supabase/migrations/20261118134443_opportunities_organizations.sql', import.meta.url),'utf8')
  try { await db.exec(base); await db.exec(migration) } catch(e) { await db.close(); throw new Error(e.message) }
  if (release) {
    await db.exec(`create table public.xelay_google_registrations(user_id uuid,completed_at timestamptz);
      create table auth.identities(user_id uuid,provider text,identity_data jsonb);
      alter table public.profiles enable row level security;
      create policy own_profile on public.profiles for select to authenticated using(id=auth.uid());
      grant select on public.profiles to authenticated;`)
    await db.exec(await readFile(new URL('../../supabase/migrations/20261118184439_opportunities_release.sql', import.meta.url),'utf8'))
  }
  const ids = Object.fromEntries(['company','school','student','stranger','admin','editor'].map(key=>[key,randomUUID()]))
  for (const [name,id] of Object.entries(ids)) await db.query('insert into auth.users(id,email,raw_user_meta_data)values($1,$2,$3)',[id,name+'@example.test',JSON.stringify({full_name:name})])
  await db.query("insert into user_roles values($1,'ADMIN')",[ids.admin])
  await db.query("insert into auth.mfa_factors values($1,'verified')",[ids.admin])
  for (const name of ['company','school']) await db.query("insert into opportunities_business_accounts(user_id,full_name,company_name,terms_version,organization_kind)values($1,$2,$2,'opportunities-v1',$3)",[ids[name],name,name])
  await db.exec(`update opportunities_settings set data=data||'{"enabled":true}'`)
  async function asUser(user,sql,args=[],role='authenticated',aal=user===ids.admin?'aal2':'aal1') {
    await db.exec('begin')
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claim.role',$2,true)",[user||'',role])
      await db.query("select set_config('request.jwt.claim.aal',$1,true)",[aal])
      await db.exec('set local role '+role)
      const result = await db.query(sql,args); await db.exec('commit'); return result
    } catch(e) { await db.exec('rollback'); throw e }
  }
  const rpc = async (user,command) => (await asUser(user,'select xelay_opportunities_command($1::jsonb) data',[JSON.stringify(command)])).rows[0].data
  const load = async user => (await asUser(user,'select xelay_opportunities_workspace() data')).rows[0].data
  const organization = (name='company') => ({id:randomUUID(),revision:0,kind:name,ownerId:ids[name],name:'Synthetic '+name,tagline:'Synthetic organization',description:'A synthetic organization for isolated authorization checks.',industry:'Education',city:'Kyiv',website:'https://example.test',contactEmail:'contact@example.test',contactName:'Synthetic Representative',legalName:'Synthetic Legal Entity',registrationCode:'12345678',logo:'',color:'#eee7ef',verificationNote:'Synthetic authorized representative of this organization.',verificationFile:null,status:'approved',partner:true,reviewNote:'forged approval',createdAt:new Date().toISOString()})
  const offer = (companyId,kind='job') => ({id:randomUUID(),revision:0,companyId,kind,title:'Synthetic opportunity',summary:'Synthetic summary',description:'Detailed synthetic opportunity with transparent terms.',requirements:'Interest',benefits:'Mentoring',city:'Kyiv',format:'remote',employment:'4 weeks',experience:'None',compensation:'1000 UAH',paid:'yes',direction:'Analytics',deadline:'',startsAt:'',applicationMode:'internal',externalUrl:'',status:'approved',reviewNote:'forged',files:[],syllabus:'Topic one, topic two',instructors:'Synthetic instructor',schedule:'Monday at 18:00',createdAt:new Date().toISOString()})
  async function approveOrganization(name) {let c=organization(name);let state=await rpc(ids[name],{type:'company.save',company:c});c=state.companies.find(x=>x.id===c.id);state=await rpc(ids[name],{type:'company.submit',id:c.id});c=state.companies.find(x=>x.id===c.id);await rpc(ids.admin,{type:'company.review',id:c.id,expectedRevision:c.revision,status:'approved',note:'Verified synthetic details'});return c.id}
  async function publish(user,item) {await rpc(user,{type:'opportunity.save',opportunity:item});const state=await rpc(user,{type:'opportunity.submit',id:item.id});const row=state.opportunities.find(x=>x.id===item.id);await rpc(ids.admin,{type:'opportunity.review',id:item.id,expectedRevision:row.revision,status:'approved',note:''});return item.id}
  return {db,ids,asUser,rpc,load,organization,offer,approveOrganization,publish,close:()=>db.close()}
}
