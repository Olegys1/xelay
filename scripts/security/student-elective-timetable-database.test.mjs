import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const id=n=>`61000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const A=id(1),B=id(2),HEAD=id(3),PENDING=id(4),TEACHER=id(5),ADMIN=id(6),BANNED=id(7),GROUP=id(10),FOREIGN=id(11),SOURCE=id(20)
const FROM='2026-11-02',UNTIL='2027-01-31'
const meeting=(patch={})=>({id:id(30),subject:'Персональний курс',weekday:3,starts_at:'10:00',ends_at:'11:20',lesson_type:'lecture',teacher_name:'',location:'',online_url:null,online_url_secondary:null,online_links_extra:[],conference_id:null,conference_access_code:null,week_pattern:'every',week_anchor_date:null,...patch})
const migration=await readFile(new URL('../../supabase/migrations/202611010001_student_elective_timetable.sql',import.meta.url),'utf8')
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close())
 await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin;create schema auth;
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role()returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
 grant usage on schema auth,public to authenticated,anon,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table public.profiles(id uuid primary key references auth.users(id));
 create table public.study_groups(id uuid primary key,representative_id uuid);
 create table public.study_group_members(id uuid default gen_random_uuid(),group_id uuid,user_id uuid,status text);
 create table public.study_group_schedule(id uuid primary key,group_id uuid,weekday smallint,starts_at time,ends_at time,subject text,lesson_type text,valid_from date,valid_until date,week_pattern text,week_anchor_date date,excluded_dates date[],copied_from_schedule_id uuid);
 create function public.xelay_schedule_occurs_on_date(p_weekday smallint,p_from date,p_until date,p_week text,p_anchor date,p_day date)returns boolean language sql immutable as $$
 select p_day between p_from and p_until and extract(isodow from p_day)=p_weekday and(p_week='every' or p_week in('upper','lower') and p_anchor is not null and mod(mod(((date_trunc('week',p_day::timestamp)::date-p_anchor)/7),2)+2,2)=case when p_week='upper' then 0 else 1 end)$$;`)
 for(const user of [A,B,HEAD,PENDING,TEACHER,ADMIN,BANNED]){await db.query('insert into auth.users(id,email_confirmed_at,banned_until)values($1,now(),$2)',[user,user===BANNED?'2099-01-01':null]);await db.query('insert into public.profiles(id)values($1)',[user])}
 await db.query('insert into public.study_groups values($1,$2),($3,$2)',[GROUP,HEAD,FOREIGN])
 for(const [user,status]of [[A,'accepted'],[B,'accepted'],[PENDING,'pending'],[BANNED,'accepted']])await db.query('insert into public.study_group_members(group_id,user_id,status)values($1,$2,$3)',[GROUP,user,status])
 await db.query('insert into public.study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,week_pattern,excluded_dates)values($1,$2,2,\'14:00\',\'15:20\',\'Вибіркові дисципліни\',\'other\',$3,$4,\'every\',\'{}\')',[SOURCE,GROUP,FROM,UNTIL])
 await db.exec(migration)
 await db.query('update public.study_group_schedule set is_elective_block=true where id=$1',[SOURCE])
 const as=async(user,role='authenticated')=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role',$2,false)",[user||'',role]);await db.exec('set role '+role)}
 const save=async(lessons=[meeting()],version=null,patch={})=>(await db.query('select public.xelay_save_student_elective_plan($1,$2,$3,$4::jsonb,$5,$6,$7) as plan',[patch.group??GROUP,patch.from??FROM,patch.until??UNTIL,JSON.stringify(lessons),version,patch.configured??true,patch.planId??null])).rows[0].plan
 return{db,as,save}
}
const denied=(operation,message)=>assert.rejects(operation,error=>message.test(error.message))

test('prepared migration stores one private own plan, leaving the shared schedule and other members unchanged',async t=>{
 const f=await fixture(t);await f.as(A)
 const saved=await f.save();assert.equal(saved.user_id,A);assert.equal(saved.group_id,GROUP);assert.equal(saved.version,1);assert.equal(saved.lessons[0].id,id(30));assert.equal(saved.lessons[0].starts_at,'10:00')
 const own=await f.db.query('select * from public.student_elective_plans');assert.equal(own.rows.length,1)
 await f.as(B);assert.equal((await f.db.query('select * from public.student_elective_plans')).rows.length,0)
 const other=await f.save([meeting({id:id(31),subject:'Інший приватний курс'})]);assert.equal(other.user_id,B)
 await f.db.exec('reset role');const shared=await f.db.query('select subject,starts_at,is_elective_block from public.study_group_schedule where id=$1',[SOURCE]);assert.deepEqual(shared.rows[0],{subject:'Вибіркові дисципліни',starts_at:'14:00:00',is_elective_block:true})
})

test('pending invitees, teacher/admin role alone, banned users, anon and foreign groups cannot save or read personal plans',async t=>{
 const f=await fixture(t);await f.as(A);await f.save()
 for(const user of [PENDING,TEACHER,ADMIN,BANNED]){await f.as(user);assert.equal((await f.db.query('select * from public.student_elective_plans')).rows.length,0);await denied(f.save(),/STUDENT_ELECTIVE_MEMBER_REQUIRED/)}
 await f.as(A);await denied(f.save(undefined,null,{group:FOREIGN}),/STUDENT_ELECTIVE_MEMBER_REQUIRED/)
 await f.as(null,'anon');await denied(f.save(),/permission denied/)
 await f.as(A,'service_role');await denied(f.save(),/permission denied/)
 await f.as(HEAD);assert.equal((await f.save()).user_id,HEAD)
})

test('ordinary callers have no direct insert/update/delete or private validator capability',async t=>{
 const f=await fixture(t);await f.as(A);await f.save()
 for(const sql of ["update public.student_elective_plans set configured=false","delete from public.student_elective_plans","insert into public.student_elective_plans(user_id,group_id,valid_from,valid_until)values('"+B+"','"+GROUP+"','2026-11-02','2027-01-31')","select public.xelay_normalize_student_elective_lessons('[]','2026-11-02','2027-01-31')"]){await denied(f.db.exec(sql),/permission denied/)}
 assert.equal((await f.db.query('select version from public.student_elective_plans')).rows[0].version,1)
})

test('versioned saves and deletes reject replay, concurrent queued edits and cross-owner deletion without SQL40001 retry semantics',async t=>{
 const f=await fixture(t);await f.as(A);const original=await f.save()
 const results=await Promise.allSettled([f.save([meeting({subject:'Перший варіант'})],1),f.save([meeting({subject:'Другий варіант'})],1)])
 assert.equal(results.filter(item=>item.status==='fulfilled').length,1)
 const rejected=results.find(item=>item.status==='rejected').reason;assert.equal(rejected.code,'P0001');assert.match(rejected.message,/CONFLICT/)
 await denied(f.save(),/CONFLICT/)
 await f.as(B);await denied(f.db.query('select public.xelay_remove_student_elective_plan($1,$2)',[original.id,2]),/NOT_FOUND/)
 await f.as(A);await denied(f.db.query('select public.xelay_remove_student_elective_plan($1,$2)',[original.id,1]),/CONFLICT/)
 assert.equal((await f.db.query('select public.xelay_remove_student_elective_plan($1,$2) as removed',[original.id,2])).rows[0].removed,true)
 assert.equal((await f.db.query('select * from public.student_elective_plans')).rows.length,0)
})

test('a choice needs a live shared elective block and non-overlapping bounded terms, while later blocks reuse existing settings',async t=>{
 const f=await fixture(t);await f.as(A);await f.save()
 await denied(f.save([meeting()],null,{from:'2027-01-01',until:'2027-02-01'}),/TERM_CONFLICT/)
 await denied(f.save([meeting()],null,{from:'2026-02-01',until:'2026-01-01'}),/TERM_INVALID/)
 await denied(f.save([meeting()],null,{from:'2026-01-01',until:'2027-02-01'}),/TERM_INVALID/)
 await f.db.exec('reset role');await f.db.query('update public.study_group_schedule set is_elective_block=false where id=$1',[SOURCE]);await f.as(A)
 await denied(f.save([meeting()],1),/BLOCK_REQUIRED/)
 await f.db.exec('reset role');await f.db.query('update public.study_group_schedule set is_elective_block=true where id=$1',[SOURCE]);await f.as(A)
 assert.equal((await f.save([meeting()],1)).version,2)
})

test('existing term dates update by owned plan ID and version, with overlap and foreign-owner protection',async t=>{
 const f=await fixture(t);await f.as(A);const original=await f.save()
 const moved=await f.save(undefined,1,{planId:original.id,from:'2026-11-09',until:'2027-01-25'})
 assert.equal(moved.id,original.id);assert.equal(moved.version,2);assert.equal(moved.valid_from,'2026-11-09');assert.equal(moved.valid_until,'2027-01-25')
 await f.save([meeting({id:id(31)})],null,{from:'2026-11-02',until:'2026-11-08'})
 await denied(f.save(undefined,2,{planId:original.id,from:'2026-11-02',until:'2027-01-25'}),/TERM_CONFLICT/)
 await denied(f.save(undefined,1,{planId:original.id,from:'2026-11-16',until:'2027-01-25'}),/CONFLICT/)
 await denied(f.save(undefined,null,{planId:original.id}),/INVALID/)
 await f.as(B);await denied(f.save(undefined,2,{planId:original.id,from:'2026-11-16',until:'2027-01-25'}),/CONFLICT/)
 await f.as(A);const stored=(await f.db.query('select version,valid_from::text as valid_from from public.student_elective_plans where id=$1',[original.id])).rows[0]
 assert.deepEqual(stored,{version:2,valid_from:'2026-11-09'})
})

test('server validates actual content, recurrence, links, duplicates and same-week overlaps before persisting',async t=>{
 const f=await fixture(t);await f.as(A)
 for(const lessons of [[meeting({subject:''})],[meeting({subject:'Bad\u202e'})],[meeting({subject:'x'.repeat(121)})],[meeting({weekday:8})],[meeting({starts_at:'24:00'})],[meeting({ends_at:'09:00'})],[meeting({lesson_type:'elective'})],[meeting({online_url:'javascript:alert(1)'})],[meeting({online_url:'https://name:password@example.com/'})],[meeting({week_pattern:'upper',week_anchor_date:'2026-11-03'})],[meeting({week_pattern:'lower',week_anchor_date:'2026-02-31'})],[meeting({group_id:FOREIGN})],[meeting(),meeting()],Array.from({length:21},(_,i)=>meeting({id:id(100+i)})),[meeting(),meeting({id:id(31),starts_at:'11:00',ends_at:'12:20'})]]){
   await denied(f.save(lessons),/STUDENT_ELECTIVE_(INVALID|OVERLAP)/)
 }
 assert.equal((await f.db.query('select * from public.student_elective_plans')).rows.length,0)
 const alternating=[meeting({week_pattern:'upper',week_anchor_date:FROM}),meeting({id:id(31),week_pattern:'lower',week_anchor_date:FROM})]
 assert.equal((await f.save(alternating)).lessons.length,2)
})

test('losing membership immediately hides own stored configuration and prevents further mutations',async t=>{
 const f=await fixture(t);await f.as(A);const saved=await f.save()
 await f.db.exec('reset role');await f.db.query("update public.study_group_members set status='removed' where group_id=$1 and user_id=$2",[GROUP,A]);await f.as(A)
 assert.equal((await f.db.query('select * from public.student_elective_plans')).rows.length,0)
 await denied(f.save(undefined,1),/MEMBER_REQUIRED/)
 await denied(f.db.query('select public.xelay_remove_student_elective_plan($1,$2)',[saved.id,1]),/MEMBER_REQUIRED/)
})

test('shared day copy inherits only the elective marker and never duplicates student configurations',async t=>{
 const f=await fixture(t);await f.as(A);await f.save();await f.db.exec('reset role')
 await f.db.query('insert into public.study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,week_pattern,copied_from_schedule_id)select $1,group_id,6,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,week_pattern,id from public.study_group_schedule where id=$2',[id(21),SOURCE])
 assert.equal((await f.db.query('select is_elective_block from public.study_group_schedule where id=$1',[id(21)])).rows[0].is_elective_block,true)
 assert.equal((await f.db.query('select count(*)::integer as n from public.student_elective_plans')).rows[0].n,1)
})
