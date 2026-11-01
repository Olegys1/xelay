import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const read=filename=>readFile(new URL('../../supabase/migrations/'+filename,import.meta.url),'utf8')
const [base,expanded,timetable,links]=await Promise.all([read('202610310003_assistant_schedule_create.sql'),read('202610310006_assistant_expanded_writes.sql'),read('202610030003_study_group_timetable.sql'),read('202610290005_schedule_additional_links.sql')])
const exact=(source,name)=>{const start=source.indexOf(name),end=source.indexOf('$$;',start);assert.ok(start>=0&&end>start);return source.slice(start,end+3)}
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const USER=id(1),OTHER=id(2),GROUP=id(10),FOREIGN=id(11),SOURCE=id(20),NEW=id(21),HW=id(30)
const code=v=>e=>e.code===v
const shape=(patch={})=>({id:NEW,group_id:GROUP,weekday:2,starts_at:'11:20',ends_at:'12:40',subject:'Вища математика',teacher_name:'Тестовий викладач',lesson_type:'lecture',location:'101',online_url:null,online_url_secondary:null,online_url_label:null,online_url_secondary_label:null,online_links_extra:[],conference_id:null,conference_access_code:null,valid_from:'2026-11-03',valid_until:'2026-12-31',week_pattern:'upper',week_anchor_date:'2026-11-02',created_by:USER,...patch})

test('expanded schedule commands execute exact migration with real identity guards and RLS', {timeout:120000},async t=>{
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;
 create table study_groups(id uuid primary key,representative_id uuid);insert into study_groups values('${GROUP}','${USER}'),('${FOREIGN}','${OTHER}');
 create table study_group_schedule(id uuid primary key,group_id uuid not null references study_groups(id),weekday smallint not null,starts_at time not null,ends_at time not null check(ends_at>starts_at),subject text not null,teacher_name text not null default'',lesson_type text not null,location text not null default'',online_url text,online_url_secondary text,online_url_label text,online_url_secondary_label text,online_links_extra jsonb not null default'[]',conference_id text,conference_access_code text,valid_from date not null,valid_until date not null,week_pattern text not null default'every',week_anchor_date date,created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),excluded_dates date[] not null default'{}',copied_from_schedule_id uuid,inherit_source_links boolean default false);
 create table study_group_homework(id uuid primary key default gen_random_uuid(),group_id uuid not null references study_groups(id),schedule_item_id uuid not null references study_group_schedule(id),lesson_date date not null,lesson_topic text,body text not null,url text,resource_links jsonb not null default'[]',resource_link_labels jsonb not null default'{}',attachments jsonb not null default'[]',created_by uuid not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(schedule_item_id,lesson_date));
 create function xelay_has_study_group_permission(p_group_id uuid,p_permission text) returns boolean language sql stable security definer set search_path='' as $$select exists(select 1 from public.study_groups where id=p_group_id and representative_id=auth.uid()) and current_setting('test.revoke_schedule',true) is distinct from'true' and(p_permission<>'homework' or current_setting('test.revoke_homework',true) is distinct from'true')$$;
 create function xelay_lock_study_group_permission(p_group_id uuid,p_permission text,p_required boolean) returns void language plpgsql as $$begin if not public.xelay_has_study_group_permission(p_group_id,p_permission) then raise exception'NO_PERMISSION' using errcode='42501';end if;end$$;
 grant select on study_groups to authenticated;grant select,insert,update on study_group_schedule,study_group_homework to authenticated;
 alter table study_group_schedule enable row level security;alter table study_group_homework enable row level security;
 create policy own_schedule on study_group_schedule to authenticated using(exists(select 1 from study_groups where id=group_id and representative_id=auth.uid())) with check(exists(select 1 from study_groups where id=group_id and representative_id=auth.uid()));
 create policy own_homework on study_group_homework to authenticated using(exists(select 1 from study_groups where id=group_id and representative_id=auth.uid())) with check(exists(select 1 from study_groups where id=group_id and representative_id=auth.uid()));`)
 await db.exec(exact(timetable,'create or replace function public.xelay_schedule_occurs_on_date('))
 await db.exec(exact(links,'create function public.xelay_normalize_schedule_extra_links('))
 await db.exec(exact(timetable,'create or replace function public.xelay_validate_study_group_delegated_content('))
 await db.exec(exact(timetable,'create or replace function public.xelay_validate_study_group_homework('))
 await db.exec(`create trigger content_schedule before insert or update or delete on study_group_schedule for each row execute function xelay_validate_study_group_delegated_content();create trigger content_homework before insert or update or delete on study_group_homework for each row execute function xelay_validate_study_group_delegated_content();create trigger validate_homework before insert or update on study_group_homework for each row execute function xelay_validate_study_group_homework();`)
 await db.exec(base);await db.exec(expanded)
 const q=async(sql,args=[]) =>(await db.query(sql,args)).rows
 const as=async(fn,user=USER,role='authenticated')=>{await db.exec(`set role ${role}`);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);try{return await fn()}finally{await db.exec("reset role;select set_config('request.jwt.claim.sub','',false)")}}
 const reset=()=>db.exec("truncate study_group_homework,study_group_schedule;select set_config('test.revoke_schedule','false',false);select set_config('test.revoke_homework','false',false)")
 const seed=async(patch={})=>{const value=shape({id:SOURCE,starts_at:'08:30',ends_at:'09:50',valid_until:'2026-12-31',week_pattern:'every',week_anchor_date:null,...patch});await as(async()=>{await db.query('select xelay_assistant_create_recurring_schedule($1::jsonb)',[value])});return(await q('select updated_at from study_group_schedule where id=$1',[SOURCE]))[0].updated_at}
 const move=async(stamp,patch={})=>as(async()=> (await q('select xelay_assistant_move_schedule($1,$2,$3,$4,$5,$6,$7,$8) result',[GROUP,SOURCE,'2026-11-03',patch.day??'2026-11-04',patch.start??'10:00',patch.end??'11:20',stamp,NEW]))[0].result)
 await t.test('only caller role can execute invoker business writes; private validator stays ungranted',async()=>{
  for(const name of ['xelay_assistant_move_schedule(uuid,uuid,date,date,text,text,timestamptz,uuid)','xelay_assistant_update_schedule(uuid,uuid,timestamptz,jsonb)','xelay_assistant_create_recurring_schedule(jsonb)']){assert.equal((await q('select prosecdef from pg_proc where oid=$1::regprocedure',[name]))[0].prosecdef,false);for(const role of ['anon','authenticated','service_role'])assert.equal((await q('select has_function_privilege($1,$2,\'execute\') allowed',[role,name]))[0].allowed,role==='authenticated')}
  assert.equal((await q("select has_function_privilege('authenticated','xelay_assistant_draft_document_valid(jsonb)','execute') allowed"))[0].allowed,false)
 })
 await t.test('recurrence covers full period and overlap on a later actual week rolls back whole insert',async()=>{
  await reset();await as(()=>db.query('select xelay_assistant_create_recurring_schedule($1::jsonb)',[shape()]));assert.equal((await q('select valid_until::text valid_until,week_pattern from study_group_schedule'))[0].valid_until,'2026-12-31');assert.equal((await q('select week_pattern from study_group_schedule'))[0].week_pattern,'upper')
  await assert.rejects(as(()=>db.query('select xelay_assistant_create_recurring_schedule($1::jsonb)',[shape({id:id(22),valid_from:'2026-11-17'})])),code('PT409'))
  assert.equal((await q('select count(*)::int n from study_group_schedule'))[0].n,1)
  await as(()=>db.query('select xelay_assistant_create_recurring_schedule($1::jsonb)',[shape({id:id(23),week_pattern:'lower'})]));assert.equal((await q('select count(*)::int n from study_group_schedule'))[0].n,2)
 })
 await t.test('move copies exact homework/resources and preserves cancelled original history/author',async()=>{
  await reset();const stamp=await seed();await as(()=>db.query('insert into study_group_homework(id,group_id,schedule_item_id,lesson_date,lesson_topic,body,resource_links,attachments,due_at,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[HW,GROUP,SOURCE,'2026-11-03','Тема','Якщо буде пара, прочитайте; інакше не здавайте.',['https://example.com/notes'],[{storage_path:'fictional-existing-group-file.pdf',name:'Лекція.pdf'}],'2026-11-05T12:00:00Z',USER]))
  assert.deepEqual(await move(stamp),{id:NEW});const rows=await q('select id,schedule_item_id,lesson_date::text lesson_date,body,resource_links,attachments,due_at,created_by from study_group_homework order by lesson_date');assert.equal(rows.length,2);assert.equal(rows[0].id,HW);assert.equal(rows[0].schedule_item_id,SOURCE);assert.equal(rows[1].schedule_item_id,NEW);assert.equal(rows[1].lesson_date,'2026-11-04');assert.equal(rows[1].body,rows[0].body);assert.deepEqual(rows[1].attachments,rows[0].attachments);assert.deepEqual(rows[1].resource_links,rows[0].resource_links);assert.equal(rows[1].created_by,USER)
  assert.deepEqual((await q('select excluded_dates::text[] excluded_dates from study_group_schedule where id=$1',[SOURCE]))[0].excluded_dates,['2026-11-03'])
  const target=(await q('select copied_from_schedule_id,inherit_source_links from study_group_schedule where id=$1',[NEW]))[0];assert.equal(target.copied_from_schedule_id,SOURCE);assert.equal(target.inherit_source_links,true)
 })
 await t.test('revoked homework right and target overlap restore source and never create partial rows',async()=>{
  await reset();let stamp=await seed();await as(()=>db.query('insert into study_group_homework(id,group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,$4,$5,$6)',[HW,GROUP,SOURCE,'2026-11-03','ДЗ',USER]));await db.exec("select set_config('test.revoke_homework','true',false)");await assert.rejects(move(stamp),code('42501'));assert.equal((await q('select count(*)::int n from study_group_schedule'))[0].n,1);assert.deepEqual((await q('select excluded_dates from study_group_schedule'))[0].excluded_dates,[])
  await reset();stamp=await seed();await as(()=>db.query('select xelay_assistant_create_schedule($1::jsonb)',[shape({id:id(24),weekday:3,starts_at:'10:00',ends_at:'11:20',valid_from:'2026-11-04',valid_until:'2026-11-04',week_pattern:'every',week_anchor_date:null})]));await assert.rejects(move(stamp),code('PT409'));assert.equal((await q('select count(*)::int n from study_group_schedule'))[0].n,2)
 })
 await t.test('same-day recurring occurrence splits safely and stale version/foreign caller cannot move',async()=>{
  await reset();const stamp=await seed();assert.deepEqual(await move(stamp,{day:'2026-11-03',start:'10:00',end:'11:20'}),{id:NEW});await assert.rejects(move(stamp),code('PT409'))
  await assert.rejects(as(()=>db.query('select xelay_assistant_create_recurring_schedule($1::jsonb)',[shape({id:id(25),group_id:GROUP,created_by:OTHER})]),OTHER),code('42501'))
 })
 await t.test('atomic edit cannot overlap another actual occurrence or bypass immutable homework identity',async()=>{
  await reset();const stamp=await seed();const values=shape({id:SOURCE,starts_at:'11:20',ends_at:'12:40'});delete values.id
  assert.deepEqual((await as(()=>q('select xelay_assistant_update_schedule($1,$2,$3,$4::jsonb) result',[SOURCE,GROUP,stamp,values])))[0].result,{id:SOURCE})
  const updated=(await q('select updated_at from study_group_schedule where id=$1',[SOURCE]))[0].updated_at
  await as(()=>db.query('insert into study_group_homework(id,group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,$4,$5,$6)',[HW,GROUP,SOURCE,'2026-11-03','ДЗ',USER]))
  await assert.rejects(as(()=>db.query('select xelay_assistant_update_schedule($1,$2,$3,$4::jsonb)',[SOURCE,GROUP,updated,{...values,weekday:3}])),code('23514'))
  assert.equal((await q('select weekday from study_group_schedule where id=$1',[SOURCE]))[0].weekday,2)
 })
 await t.test('seminar wrapper delegates only an exact current own-group revision under the shared lock',async()=>{
  await db.exec(`create table study_group_seminar_subjects(id uuid primary key default gen_random_uuid(),group_id uuid,name text,updated_at timestamptz default now());grant select,insert,update on study_group_seminar_subjects to authenticated;
    create function xelay_save_seminar_subject(p_group_id uuid,p_subject_id uuid,p_name text) returns uuid language plpgsql security invoker set search_path='public' as $$declare v uuid;begin if p_subject_id is null then insert into study_group_seminar_subjects(group_id,name) values(p_group_id,p_name) returning id into v;else update study_group_seminar_subjects set name=p_name,updated_at=clock_timestamp() where id=p_subject_id and group_id=p_group_id returning id into v;end if;return v;end$$;
    grant execute on function xelay_save_seminar_subject(uuid,uuid,text) to authenticated;`)
  const args={p_group_id:GROUP,p_subject_id:null,p_name:'Вища математика'}
  const generated=(await as(()=>q('select xelay_assistant_save_seminar($1,$2,$3::jsonb) id',['subject',null,args])))[0].id
  assert.match(generated,/^[0-9a-f-]{36}$/)
  const stamp=(await q('select updated_at from study_group_seminar_subjects where id=$1',[generated]))[0].updated_at
  assert.equal((await as(()=>q('select xelay_assistant_save_seminar($1,$2,$3::jsonb) id',['subject',stamp,{...args,p_subject_id:generated,p_name:'Оновлена назва'}])))[0].id,generated)
  await assert.rejects(as(()=>q('select xelay_assistant_save_seminar($1,$2,$3::jsonb) id',['subject',stamp,{...args,p_subject_id:generated,p_name:'Застаріла назва'}])),code('PT409'))
  assert.equal((await q('select name from study_group_seminar_subjects where id=$1',[generated]))[0].name,'Оновлена назва')
  await assert.rejects(as(()=>q('select xelay_assistant_save_seminar($1,$2,$3::jsonb) id',['subject',null,args]),OTHER),code('42501'))
  await assert.rejects(as(()=>q('select xelay_assistant_save_seminar($1,$2,$3::jsonb) id',['subject',null,{...args,sql:'arbitrary'}])),code('22023'))
 })
})
