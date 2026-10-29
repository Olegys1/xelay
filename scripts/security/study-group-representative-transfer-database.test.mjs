// Offline PostgreSQL execution of the real transfer migration and existing
// create/permission/notification functions. Every account and row is synthetic.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {freemem} from 'node:os'
import {PGlite} from '@electric-sql/pglite'

const read=file=>readFile(new URL(`../../${file}`,import.meta.url),'utf8')
const migration=await read('supabase/migrations/202610290003_study_group_representative_transfer.sql')
const legacy=await read('supabase/migrations/202610260002_study_group_legacy_collision_recovery.sql')
const oldGroups=await read('supabase/migrations/202609290001_study_groups_schedule.sql')
const deputySource=await read('supabase/migrations/202610020009_study_group_deputy_appointments.sql')
const permissionsSource=await read('supabase/migrations/202610030001_study_group_schedule_permissions.sql')
const functionFrom=(source,name)=>{
  const start=source.indexOf(`create or replace function public.${name}(`)
  assert.ok(start>=0,`real ${name} exists`)
  const body=source.slice(start),tag=body.match(/as (\$[a-z_]*\$)/i)?.[1]
  assert.ok(tag)
  const first=body.indexOf(tag),end=body.indexOf(tag,first+tag.length)
  assert.ok(end>first)
  return body.slice(0,end+tag.length+1)
}
const createBody=functionFrom(legacy,'xelay_create_study_group')
const createGuard=migration.match(/do \$create_guard\$[\s\S]*?\$create_guard\$;/)?.[0]
assert.ok(createGuard)
const id=n=>`e0000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const u=Object.fromEntries(['old','next','other','pending','removed','rejected','foreign','teacher','admin','banned','deleted','unconfirmed']
  .map((name,i)=>[name,id(i+1)]))
const group=id(100),otherGroup=id(101),request=id(200),otherRequest=id(201),command=id(300)

test('actual PostgreSQL: immediate representative transfer, retained data and closed rights',{timeout:60_000},async t=>{
  const minimumFreeMiB=Number(process.env.XELAY_REPRESENTATIVE_TRANSFER_SQL_MIN_FREE_MIB||1400)
  assert.ok([1200,1400].includes(minimumFreeMiB),'Only default1400 or explicit1200MiB minimum-free budgets are allowed')
  const freeBefore=freemem()/1024**2
  if(freeBefore<=minimumFreeMiB){t.skip(`Needs over${minimumFreeMiB}MiB free; available${Math.round(freeBefore)}MiB`);return}
  let peak=0
  const guard=setInterval(()=>{
    peak=Math.max(peak,process.memoryUsage().rss/1024**2)
    if(peak>600)process.exit(77)
    if(freemem()/1024**2<500)process.exit(79)
  },50)
  const deadline=setTimeout(()=>process.exit(78),60_000);guard.unref();deadline.unref()
  const db=new PGlite({postgresqlconf:['shared_buffers=4MB','work_mem=1MB','maintenance_work_mem=4MB']})
  const rows=async(sql,args=[]) =>(await db.query(sql,args)).rows
  const one=async(sql,args=[]) =>(await rows(sql,args))[0]
  const asUser=async(user,sql,args=[],role='authenticated')=>db.transaction(async tx=>{
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role,aal:'aal1'})])
    await tx.exec('set local role '+role)
    return(await tx.query(sql,args)).rows
  })
  const transfer=async(actor=u.old,target=u.next,key=command,expected=actor,g=group)=>(await asUser(actor,
    'select public.xelay_transfer_study_group_representative($1,$2,$3,$4) value',[g,target,expected,key]))[0].value
  const status=async user=>(await asUser(user,'select public.xelay_my_study_group_representative_status() value'))[0].value
  const denied=async(promise,code)=>assert.rejects(promise,error=>{
    if(code)assert.match(error.message,new RegExp(code));return true
  })
  const dump=async table=>(await one(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) value from public.${table} t`)).value
  const permissions=async user=>(await asUser(user,'select public.xelay_study_group_permissions($1) value',[group]))[0].value
  try{
    await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema fixture;
      grant usage on schema auth to anon,authenticated,service_role;
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid$$;
      create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),deleted_at timestamptz,banned_until timestamptz);
      create table public.profiles(id uuid primary key references auth.users(id),full_name text,study_year_needs_review boolean default false,
        university_id uuid,academic_unit_id uuid,specialty text,experience text,study_year integer,study_year_academic_year integer);
      create table public.class_representative_requests(id uuid primary key,user_id uuid references profiles(id),status text,
        university_id uuid,academic_unit_id uuid,specialty text,group_name text,cohort_start_year integer,study_level text,
        full_name text,telegram_username text,phone text,reviewed_by uuid,reviewed_at timestamptz,created_at timestamptz default now());
      create table public.study_groups(id uuid primary key default gen_random_uuid(),representative_request_id uuid unique not null references class_representative_requests(id),
        representative_id uuid not null references profiles(id),university_id uuid,academic_unit_id uuid,specialty text,group_name text,
        cohort_start_year integer,study_level text,created_at timestamptz default now());
      create table public.study_group_members(id uuid primary key default gen_random_uuid(),group_id uuid references study_groups(id),user_id uuid references profiles(id) on delete cascade,
        invited_by uuid,status text not null,accepted_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),unique(group_id,user_id));
      create table public.study_group_deputy_requests(id uuid primary key default gen_random_uuid(),group_id uuid references study_groups(id),user_id uuid,
        status text not null,permissions text[] not null default '{}',message text,created_at timestamptz default now(),updated_at timestamptz default now(),
        reviewed_by uuid,reviewed_at timestamptz,unique(group_id,user_id),check(status='approved' or cardinality(permissions)=0));
      create table public.study_group_cohort_collision_resolutions(request_id uuid,existing_group_id uuid,request_user_id uuid,existing_representative_id uuid,
        existing_representative_request_id uuid,university_id uuid,academic_unit_id uuid,specialty text,group_name text,new_cohort_start_year integer,
        new_study_level text,existing_cohort_start_year integer,existing_study_level text);
      create function public.xelay_private_profile_group_cohort(uuid,uuid,uuid,text) returns table(cohort_start_year integer,study_level text)
        language sql stable as $$select null::integer,null::text$$;
      create function public.xelay_is_platform_admin() returns boolean language sql stable as $$select auth.uid()='${u.admin}'::uuid$$;
      create function public.xelay_is_study_group_representative(p_group_id uuid) returns boolean language sql stable security definer set search_path='' as $$
        select exists(select 1 from public.study_groups where id=p_group_id and representative_id=auth.uid())$$;
      create table public.notifications(id uuid primary key default gen_random_uuid(),recipient_id uuid,actor_id uuid,actor_name text,type text,message text,
        is_read boolean,study_group_id uuid,study_group_member_id uuid);
      create table public.notification_email_outbox(notification_id uuid);
      create table public.participant_push_outbox(notification_id uuid);
      create function fixture.queue_email() returns trigger language plpgsql as $$begin insert into public.notification_email_outbox values(new.id);return new;end$$;
      create trigger fixture_email after insert on public.notifications for each row execute function fixture.queue_email();
      create function fixture.queue_push() returns trigger language plpgsql as $$begin insert into public.participant_push_outbox values(new.id);return new;end$$;
      create trigger fixture_push after insert on public.notifications for each row execute function fixture.queue_push();
      create table public.study_group_schedule(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.study_group_homework(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.study_group_materials(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.study_group_seminars(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.study_group_seminar_reservations(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.teaching_course_groups(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.teaching_grades(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.study_group_academic_year_archives(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.group_annual_entitlements(id uuid primary key default gen_random_uuid(),group_id uuid,payload jsonb);
      create table public.participant_entitlements(id uuid primary key default gen_random_uuid(),user_id uuid,payload jsonb);
      create table public.billing_orders(id uuid primary key default gen_random_uuid(),group_id uuid,user_id uuid,payload jsonb);
      revoke all on public.study_groups,public.study_group_members,public.study_group_deputy_requests,public.class_representative_requests from public,anon,authenticated;
      grant select on public.study_groups,public.study_group_members,public.study_group_deputy_requests,public.class_representative_requests to authenticated;
    `)
    for(const[name,user]of Object.entries(u)){
      await db.query('insert into auth.users(id) values($1)',[user])
      await db.query('insert into profiles(id,full_name) values($1,$2)',[user,'Synthetic '+name])
    }
    await db.exec(`update auth.users set banned_until='infinity' where id='${u.banned}';update auth.users set deleted_at=now() where id='${u.deleted}';
      update auth.users set email_confirmed_at=null where id='${u.unconfirmed}';
      insert into class_representative_requests(id,user_id,status,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level,
        full_name,phone,reviewed_by,reviewed_at)values
        ('${request}','${u.old}','approved','${id(500)}','${id(501)}','Synthetic OP','Synthetic A',2026,'bachelor','Synthetic old','synthetic-private-phone','${u.admin}',now()),
        ('${otherRequest}','${u.other}','approved','${id(500)}','${id(501)}','Synthetic OP','Synthetic B',2026,'bachelor','Synthetic other','synthetic-other-contact','${u.admin}',now());
      insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level)
        select '${group}',id,user_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level from class_representative_requests where id='${request}';
      insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level)
        select '${otherGroup}',id,user_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level from class_representative_requests where id='${otherRequest}';
      insert into study_group_members(group_id,user_id,invited_by,status,accepted_at)values
        ('${group}','${u.next}','${u.old}','accepted',now()),('${group}','${u.foreign}','${u.old}','accepted',now()),
        ('${group}','${u.pending}','${u.old}','pending',null),('${group}','${u.removed}','${u.old}','removed',null),
        ('${group}','${u.rejected}','${u.old}','rejected',null),('${otherGroup}','${u.other}','${u.other}','accepted',now()),
        ('${group}','${u.banned}','${u.old}','accepted',now()),('${group}','${u.deleted}','${u.old}','accepted',now()),
        ('${group}','${u.unconfirmed}','${u.old}','accepted',now());
      insert into study_group_deputy_requests(group_id,user_id,status,permissions,reviewed_by,reviewed_at)values
        ('${group}','${u.old}','approved',array['schedule'],'${u.old}',now()),
        ('${group}','${u.next}','approved',array['homework'],'${u.old}',now()),
        ('${group}','${u.foreign}','approved',array['seminars'],'${u.old}',now()),
        ('${otherGroup}','${u.old}','approved',array['schedule'],'${u.other}',now());`)
    await db.exec(functionFrom(oldGroups,'xelay_notify_study_group_member'))
    await db.exec(functionFrom(deputySource,'xelay_notify_study_group_deputy_request'))
    await db.exec(functionFrom(permissionsSource,'xelay_study_group_permissions'))
    await db.exec(`create trigger study_group_invite_notification_insert after insert on public.study_group_members for each row execute function public.xelay_notify_study_group_member();
      create trigger study_group_invite_notification_update after update of status on public.study_group_members for each row execute function public.xelay_notify_study_group_member();
      create trigger study_group_deputy_notifications after insert or update on public.study_group_deputy_requests for each row execute function public.xelay_notify_study_group_deputy_request();`)
    await db.exec(createBody.replaceAll('\n','\r\n'))
    await db.exec('revoke all on function public.xelay_create_study_group(uuid) from public,anon,service_role;grant execute on function public.xelay_create_study_group(uuid) to authenticated;')
    const createBefore=await one("select to_jsonb(p)-'prosrc' metadata,prosrc source from pg_proc p where oid='public.xelay_create_study_group(uuid)'::regprocedure")
    const protectedBefore=await one("select pg_get_functiondef('public.xelay_study_group_permissions(uuid)'::regprocedure) definition")
    const retained=['study_group_schedule','study_group_homework','study_group_materials','study_group_seminars','study_group_seminar_reservations',
      'teaching_course_groups','teaching_grades','study_group_academic_year_archives','group_annual_entitlements','participant_entitlements','billing_orders']
    for(const table of retained){
      if(table==='participant_entitlements')await db.query(`insert into ${table}(user_id,payload)values($1,$2)`,[u.old,{synthetic:table}])
      else await db.query(`insert into ${table}(group_id,payload)values($1,$2)`,[group,{synthetic:table}])
    }
    const retainedBefore=Object.fromEntries(await Promise.all(retained.map(async table=>[table,await dump(table)])))
    const requestBefore=await dump('class_representative_requests')
    const targetMembership=await one('select to_jsonb(m) value from study_group_members m where group_id=$1 and user_id=$2',[group,u.next])
    const groupBefore=await one('select to_jsonb(g)-\'representative_id\' value from study_groups g where id=$1',[group])
    await db.exec(migration)

    await t.test('create guard preserves raw CRLF source, OID, owner, ACL and all pg_proc metadata',async()=>{
      const after=await one("select to_jsonb(p)-'prosrc' metadata,prosrc source from pg_proc p where oid='public.xelay_create_study_group(uuid)'::regprocedure")
      assert.deepEqual(after.metadata,createBefore.metadata)
      assert.ok(after.source.includes('\r\n'))
      const added=after.source.replace(createBefore.source.split("if auth.uid() is null then raise exception 'Authentication required'; end if;")[0],'')
      assert.match(added,/STUDY_GROUP_REQUEST_TRANSFERRED/)
      assert.equal(after.source.replace(/\r\n  if exists\(select 1 from public.study_groups g where g.representative_request_id=p_request_id and g.representative_id<>auth.uid\(\)\) then raise exception 'STUDY_GROUP_REQUEST_TRANSFERRED' using errcode='42501';end if;/,''),createBefore.source)
      assert.deepEqual(await one("select pg_get_functiondef('public.xelay_study_group_permissions(uuid)'::regprocedure) definition"),protectedBefore)
    })
    await t.test('private receipt/helper and transfer/status API grants deny anonymous and service callers',async()=>{
      for(const role of['anon','service_role']){
        await denied(asUser(u.old,'select xelay_transfer_study_group_representative($1,$2,$3,$4)',[group,u.next,u.old,command],role),/permission denied/.source)
        await denied(asUser(u.old,'select xelay_my_study_group_representative_status()',[],role),'permission denied')
      }
      for(const sql of['select * from study_group_representative_transfers','insert into study_group_representative_transfers default values',
        'select xelay_private_representative_account_active(auth.uid())'])await denied(asUser(u.old,sql),'permission denied')
      await denied(asUser(u.old,'update study_groups set representative_id=$1 where id=$2',[u.next,group]),'permission denied')
      await denied(transfer(null),'AUTH_REQUIRED')
    })
    await t.test('ordinary member, deputy, teacher-only and unrelated platform administrator cannot take ownership',async()=>{
      for(const actor of[u.next,u.foreign,u.teacher,u.admin])await denied(transfer(actor,u.old),'NOT_OWNER')
      await denied(transfer(u.next,u.foreign,command,u.old),'NOT_OWNER')
      await denied(transfer(u.old,u.old),'INVALID_ARGUMENT')
      await denied(transfer(u.old,u.next,null),'INVALID_ARGUMENT')
    })
    await t.test('pending, rejected, removed, foreign-group and teacher-only targets are refused without writes',async()=>{
      for(const target of[u.pending,u.rejected,u.removed,u.other,u.teacher])await denied(transfer(u.old,target),'TARGET_NOT_ACCEPTED')
      assert.equal((await one('select representative_id from study_groups where id=$1',[group])).representative_id,u.old)
    })
    await t.test('banned, deleted and unconfirmed accounts cannot be actors or promoted targets',async()=>{
      for(const user of[u.banned,u.deleted,u.unconfirmed]){
        await denied(transfer(u.old,user),'ACCOUNT_UNAVAILABLE')
        await denied(transfer(user,u.next),'ACCOUNT_UNAVAILABLE')
        await denied(status(user),'ACCOUNT_UNAVAILABLE')
      }
    })
    await t.test('owner-only role status does not infer unrelated application, admin or teaching grants',async()=>{
      assert.deepEqual(await status(u.old),{is_representative:true,owned_group_ids:[group],available_request_ids:[request],can_create_group:false})
      for(const user of[u.next,u.admin,u.teacher])assert.deepEqual(await status(user),{is_representative:false,owned_group_ids:[],available_request_ids:[],can_create_group:false})
    })
    let firstReceipt
    await t.test('atomic transfer retains group/approval/content/billing and outgoing accepted membership without any delivery',async()=>{
      firstReceipt=await transfer()
      assert.equal(firstReceipt.representative_id,u.next);assert.equal(firstReceipt.replayed,false)
      assert.deepEqual(await one('select to_jsonb(g)-\'representative_id\' value from study_groups g where id=$1',[group]),groupBefore)
      assert.deepEqual(await dump('class_representative_requests'),requestBefore)
      assert.deepEqual(await one('select to_jsonb(m) value from study_group_members m where group_id=$1 and user_id=$2',[group,u.next]),targetMembership)
      assert.equal((await one('select status from study_group_members where group_id=$1 and user_id=$2',[group,u.old])).status,'accepted')
      for(const table of retained)assert.deepEqual(await dump(table),retainedBefore[table],table)
      for(const table of['notifications','notification_email_outbox','participant_push_outbox'])assert.deepEqual(await dump(table),[])
    })
    await t.test('both current deputy rows are cleared, audit retains them and unrelated appointments survive',async()=>{
      const receipt=await one('select * from study_group_representative_transfers where request_id=$1',[command])
      assert.equal(receipt.cleared_deputy_appointments.length,2)
      assert.deepEqual(await rows('select user_id from study_group_deputy_requests where group_id=$1 order by user_id',[group]),[{user_id:u.foreign}])
      assert.equal((await one('select status from study_group_deputy_requests where group_id=$1 and user_id=$2',[otherGroup,u.old])).status,'approved')
      assert.deepEqual(await permissions(u.old),[])
      assert.ok((await permissions(u.next)).includes('schedule'))
      assert.deepEqual(await permissions(u.foreign),['seminars'])
    })
    await t.test('new headman needs no application and old approval cannot recreate or recover transferred group',async()=>{
      assert.deepEqual(await status(u.old),{is_representative:false,owned_group_ids:[],available_request_ids:[],can_create_group:false})
      assert.deepEqual(await status(u.next),{is_representative:true,owned_group_ids:[group],available_request_ids:[],can_create_group:false})
      await denied(asUser(u.old,'select xelay_create_study_group($1)',[request]),'STUDY_GROUP_REQUEST_TRANSFERRED')
      assert.equal((await one('select count(*)::int count from study_groups')).count,2)
    })
    await t.test('exact retry returns same receipt, changed payload and UUID reuse cannot produce another transfer',async()=>{
      const replay=await transfer();assert.deepEqual({...replay,replayed:false},firstReceipt);assert.equal(replay.replayed,true)
      await denied(transfer(u.old,u.foreign),'REQUEST_REUSED')
      await denied(transfer(u.other,u.foreign,command,u.other,otherGroup),'REQUEST_REUSED')
      assert.equal((await one('select count(*)::int count from study_group_representative_transfers')).count,1)
    })
    await t.test('serialized stale second transfer fails; current new headman can transfer again and exact old retry cannot revert it',async()=>{
      await assert.rejects(transfer(u.old,u.foreign,id(301)),error=>{
        assert.equal(error.code,'PT409');assert.match(error.message,/STALE/);return true
      })
      const second=await transfer(u.next,u.foreign,id(302));assert.equal(second.representative_id,u.foreign)
      assert.equal((await transfer()).replayed,true)
      assert.equal((await one('select representative_id from study_groups where id=$1',[group])).representative_id,u.foreign)
      assert.deepEqual(await permissions(u.next),[])
      assert.deepEqual(await permissions(u.old),[])
    })
    await t.test('historical receipts do not prevent deleting a former headman profile or erase transfer audit',async()=>{
      // This former headman was promoted without an application and now owns
      // no group. The original creator's unrelated historic approval FK stays
      // unchanged; this case isolates the new receipt's deletion compatibility.
      const auditBefore=await dump('study_group_representative_transfers')
      assert.equal((await one('select count(*)::int count from study_groups where representative_id=$1',[u.next])).count,0)
      assert.equal((await one('select count(*)::int count from class_representative_requests where user_id=$1',[u.next])).count,0)
      assert.equal((await rows('delete from profiles where id=$1 returning id',[u.next])).length,1)
      assert.deepEqual(await dump('study_group_representative_transfers'),auditBefore)
      assert.equal((await one('select count(*)::int count from study_group_members where user_id=$1',[u.next])).count,0)
      assert.equal((await one('select representative_id from study_groups where id=$1',[group])).representative_id,u.foreign)
      // Reset only the synthetic fixture identity for the subsequent independent
      // unbound-approval case; no permissions, receipt or membership is restored.
      await db.query('insert into profiles(id,full_name)values($1,$2)',[u.next,'Synthetic next'])
    })
    await t.test('failure after mutation rolls the entire transfer back, including memberships and deputy deletion',async()=>{
      await db.exec(`create function fixture.fail_receipt() returns trigger language plpgsql as $$begin raise exception 'SYNTHETIC_RECEIPT_FAILURE';end$$;
        create trigger fixture_fail_receipt before insert on study_group_representative_transfers for each row execute function fixture.fail_receipt();`)
      const before={group:await dump('study_groups'),members:await dump('study_group_members'),deputies:await dump('study_group_deputy_requests')}
      await denied(transfer(u.foreign,u.old,id(303)),'SYNTHETIC_RECEIPT_FAILURE')
      assert.deepEqual(await dump('study_groups'),before.group);assert.deepEqual(await dump('study_group_members'),before.members)
      assert.deepEqual(await dump('study_group_deputy_requests'),before.deputies)
      await db.exec('drop trigger fixture_fail_receipt on study_group_representative_transfers')
    })
    await t.test('other genuine ownership and unconsumed approvals remain valid, without truncating boolean flags',async()=>{
      await db.query('update study_groups set representative_id=$1 where id=$2',[u.old,otherGroup])
      assert.equal((await status(u.old)).is_representative,true)
      assert.deepEqual((await status(u.old)).owned_group_ids,[otherGroup])
      const unbound=id(220)
      await db.query('insert into class_representative_requests(id,user_id,status,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level)values($1,$2,\'approved\',$3,$4,\'Synthetic OP\',\'New group\',2026,\'bachelor\')',[unbound,u.next,id(500),id(501)])
      assert.equal((await status(u.next)).can_create_group,true)
      const created=(await asUser(u.next,'select xelay_create_study_group($1) id',[unbound]))[0].id
      assert.equal((await one('select representative_id from study_groups where id=$1',[created])).representative_id,u.next)
    })
    await t.test('create guard also round-trips LF source and refuses changed or duplicate authentication without touching metadata',async()=>{
      await db.exec(createBody)
      const before=await one("select to_jsonb(p)-'prosrc' metadata,prosrc source from pg_proc p where oid='public.xelay_create_study_group(uuid)'::regprocedure")
      await db.exec(createGuard)
      const after=await one("select to_jsonb(p)-'prosrc' metadata,prosrc source from pg_proc p where oid='public.xelay_create_study_group(uuid)'::regprocedure")
      assert.deepEqual(after.metadata,before.metadata);assert.ok(!after.source.includes('\r'))
      for(const variant of[
        createBody.replace("if auth.uid() is null then raise exception 'Authentication required'; end if;","if false then raise exception 'Authentication required'; end if;"),
        createBody.replace("if auth.uid() is null then raise exception 'Authentication required'; end if;","if auth.uid() is null then raise exception 'Authentication required'; end if;\nif auth.uid() is null then raise exception 'Authentication required'; end if;")]){
        await db.exec(variant);const source=(await one("select prosrc from pg_proc where oid='public.xelay_create_study_group(uuid)'::regprocedure")).prosrc
        await denied(db.exec(createGuard),'CREATE_SOURCE_DRIFT')
        assert.equal((await one("select prosrc from pg_proc where oid='public.xelay_create_study_group(uuid)'::regprocedure")).prosrc,source)
      }
    })
    peak=Math.max(peak,process.memoryUsage().rss/1024**2)
    t.diagnostic(JSON.stringify({actualMigrationExecuted:true,syntheticOnly:true,noProductionConnections:true,
      peakRssMiB:Math.round(peak),rssCapMiB:600,freeBeforeMiB:Math.round(freeBefore),minimumFreeMiB,
      concurrencyEvidence:'single PostgreSQL session verifies serialized stale/retry outcomes and actual lock calls; not a multi-session load test'}))
  }finally{await db.close();clearInterval(guard);clearTimeout(deadline)}
})
