// Real old birthday-gift SQL plus this migration, in isolated PostgreSQL.
// Minimal synthetic Auth/group/delivery prerequisites; no network or real users.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { freemem } from 'node:os'
import { PGlite } from '@electric-sql/pglite'

const read = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
const oldGift = await read('supabase/migrations/202610260001_birthday_gifts.sql')
const migration = await read('supabase/migrations/202610290002_profile_birthdays.sql')
const pushSource = await read('supabase/migrations/202610070007_participant_appearance_push.sql')
const actualPush = pushSource.match(/create or replace function public\.xelay_queue_participant_push\(\)[\s\S]*?\$\$;/)?.[0]
assert.ok(actualPush)
const inboxDefinition=oldGift.match(/create function public\.xelay_my_birthday_gifts\(\)[\s\S]*?end \$\$;/)?.[0]?.replace('create function','create or replace function')
const inboxGuard=migration.match(/do \$own_inbox\$[\s\S]*?end \$own_inbox\$;/)?.[0]
assert.ok(inboxDefinition&&inboxGuard)
const authStatement="if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;"
// Repository source converted to CRLF exactly matches PostgreSQL17.11's
// read-only reported420-byte source and MD5. No user data is embedded.
const productionInboxBody=inboxDefinition.match(/as \$\$([\s\S]*?)\$\$;/i)[1].replaceAll('\n','\r\n')
const oneSpaceInboxBody=['','declare v_user uuid:=auth.uid();','begin',
  ' '+authStatement,
  ' return coalesce((select jsonb_agg(public.xelay_private_birthday_gift_json(g.id,false)',
  ' order by g.offered_at desc,g.id)',
  ' from (select id,offered_at from public.birthday_gifts where recipient_id=v_user',
  " order by offered_at desc,id limit 20) g),'[]'::jsonb);",'end '].join('\r\n')
assert.equal(createHash('md5').update(productionInboxBody).digest('hex'),'38704ed5a74a76926ab01dd59dfaaa11')
const id = n => `d0000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const names = ['birthday','rep','member','repB','pending','former','teacher','admin','unconfirmed','banned','deleted',
  'dateEdited','cleared','subjectLeft','recipientLeft','manual','leap','midnight','notificationsOff']
const users = Object.fromEntries(names.map((name, index) => [name, id(index + 1)]))
const groupA = id(100), groupB = id(101)
const first = result => result.rows[0]

test('profile birthdays are optional/private, gifts annual and group announcements live-consent scoped', {
  timeout: 60_000,
}, async t => {
  const minimumFreeMiB=Number(process.env.XELAY_BIRTHDAY_SQL_MIN_FREE_MIB||1400)
  assert.ok([1200,1400].includes(minimumFreeMiB),'Only default1400 or explicit1200MiB minimum-free budgets are allowed')
  const beforeFree = freemem() / 1024 ** 2
  if (beforeFree <= minimumFreeMiB) { t.skip(`Needs over${minimumFreeMiB}MiB free for isolated PostgreSQL; available${Math.round(beforeFree)}MiB.`);return }
  let peakRss = 0
  const guard = setInterval(() => {
    peakRss = Math.max(peakRss,process.memoryUsage().rss/1024**2)
    if(peakRss>600)process.exit(77)
    if(freemem()/1024**2<500)process.exit(79)
  },50)
  const deadline = setTimeout(() => process.exit(78),60_000)
  guard.unref();deadline.unref()
  const db = new PGlite({postgresqlconf:['shared_buffers=4MB','work_mem=1MB','maintenance_work_mem=4MB']})
  const rows = async(sql,params=[]) => (await db.query(sql,params)).rows
  const asUser = async(user,sql,params=[],{role='authenticated',aal='aal1'}={}) => db.transaction(async tx => {
    await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role,aal})])
    await tx.exec('set local role '+role)
    return (await tx.query(sql,params)).rows
  })
  const save = async(user,day,month,share=false) => (await asUser(user,'select xelay_save_my_birthday_profile($1,$2,$3) value',[day,month,share]))[0].value
  const gifts = async user => (await asUser(user,'select xelay_my_birthday_gifts() value'))[0].value
  const worker = async(limit=100) => (await asUser(null,'select xelay_process_due_birthdays($1) value',[limit],{role:'service_role'}))[0].value
  const group = async(user,groupId=groupA) => (await asUser(user,'select xelay_group_birthdays($1) value',[groupId]))[0].value
  const notices = async(user,actor=users.birthday) => asUser(user,"select id,actor_id,recipient_id,study_group_id,birthday_event_id,type from notifications where type='group_birthday' and actor_id=$1",[actor])
  const setTime = value => db.query('update fixture.clock set value=$1',[value])
  const count = async(table,where='',params=[]) => first(await db.query(`select count(*)::int n from public.${table} ${where}`,params)).n
  const denied = work => assert.rejects(work,error=>error.code==='42501')
  try {
    await db.exec(`
      create role anon;create role authenticated;create role service_role bypassrls;
      create schema auth;create schema fixture;
      create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as $$select (auth.jwt()->>'sub')::uuid$$;
      create function auth.role() returns text language sql stable as $$select auth.jwt()->>'role'$$;
      grant usage on schema public,auth to anon,authenticated,service_role;
      create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
      create table auth.mfa_factors(user_id uuid,status text);
      create table public.profiles(id uuid primary key references auth.users(id),full_name text,avatar_url text default '');
      create table public.study_groups(id uuid primary key,representative_id uuid references profiles(id));
      create table public.study_group_members(id uuid primary key default gen_random_uuid(),group_id uuid references study_groups(id),user_id uuid references profiles(id),status text,unique(group_id,user_id));
      create table fixture.teaching_grants(user_id uuid,group_id uuid);
      create table fixture.clock(value timestamptz);
      insert into fixture.clock values('2026-10-29T10:00:00Z');
      create table public.notifications(id uuid primary key default gen_random_uuid(),recipient_id uuid not null,actor_id uuid not null,
        actor_name text not null,type text not null,message text not null,is_read boolean default false,created_at timestamptz default now(),
        study_group_id uuid,academic_event_key text,academic_tab text,shared_organizer_workspace_id uuid,shared_organizer_invitation_id uuid,organizer_task_id uuid,
        check((academic_event_key is null and academic_tab is null and shared_organizer_workspace_id is null and shared_organizer_invitation_id is null
          and type not in('study_group_update','shared_organizer_invite','shared_organizer_update'))
          or(academic_event_key is not null and type in('study_group_update','group_homework') and study_group_id is not null and academic_tab in('schedule','seminars','timetable','materials'))));
      alter table public.notifications enable row level security;
      grant select on public.notifications to authenticated;grant update(is_read) on public.notifications to authenticated;
      grant all on public.notifications to service_role;
      create policy recipient_select on public.notifications for select to authenticated using(recipient_id=auth.uid());
      create policy recipient_select_guard on public.notifications as restrictive for select to authenticated using(recipient_id=auth.uid());
      create policy recipient_update on public.notifications for update to authenticated using(recipient_id=auth.uid()) with check(recipient_id=auth.uid());
      create table public.participant_entitlements(id uuid primary key default gen_random_uuid(),user_id uuid,source text,term_months integer,
        valid_from timestamptz,valid_until timestamptz,revoked_at timestamptz,created_at timestamptz default now());
      create table public.billing_audit_log(id uuid primary key default gen_random_uuid(),actor_id uuid,action text,target_user_id uuid,detail jsonb);
      create table public.notification_email_outbox(notification_id uuid references notifications(id) on delete cascade,notification_type text);
      create table public.notification_preferences(user_id uuid,notifications_enabled boolean);
      create table public.participant_push_subscriptions(id uuid primary key default gen_random_uuid(),user_id uuid,enabled boolean);
      create table public.participant_push_outbox(subscription_id uuid,notification_id uuid references notifications(id) on delete cascade,unique(subscription_id,notification_id));
      create function public.xelay_is_platform_admin() returns boolean language sql stable as $$select auth.uid()='${users.admin}'::uuid$$;
      create function public.xelay_reflow_participant_access(uuid) returns void language plpgsql as $$begin return;end$$;
      create function public.xelay_has_participant_access(uuid) returns boolean language sql stable as $$select true$$;
      create function public.xelay_queue_notification_email() returns trigger language plpgsql security definer set search_path='' as $$
        begin insert into public.notification_email_outbox values(new.id,new.type);return new;end$$;
      create trigger notification_email_queue after insert on public.notifications for each row execute function public.xelay_queue_notification_email();
      ${actualPush}
      create trigger xelay_participant_push_queue after insert on public.notifications for each row execute function public.xelay_queue_participant_push();
    `)
    for(const [name,user] of Object.entries(users)) {
      await db.query("insert into auth.users values($1,$2,now(),null,null)",[user,name+'@example.test'])
      await db.query('insert into profiles(id,full_name) values($1,$2)',[user,'Synthetic '+name])
      await db.query('insert into participant_push_subscriptions(user_id,enabled) values($1,true)',[user])
    }
    await db.exec(`update auth.users set email_confirmed_at=null where id='${users.unconfirmed}';
      update auth.users set banned_until='infinity' where id='${users.banned}';
      update auth.users set deleted_at=now() where id='${users.deleted}';
      insert into auth.mfa_factors values('${users.admin}','verified');
      insert into study_groups values('${groupA}','${users.rep}'),('${groupB}','${users.repB}');
      insert into fixture.teaching_grants values('${users.teacher}','${groupA}');
      insert into study_group_members(group_id,user_id,status) values
        ('${groupA}','${users.birthday}','accepted'),('${groupB}','${users.birthday}','accepted'),
        ('${groupA}','${users.member}','accepted'),('${groupB}','${users.member}','accepted'),
        ('${groupA}','${users.pending}','pending'),('${groupA}','${users.former}','removed'),
        ('${groupA}','${users.banned}','accepted'),('${groupA}','${users.deleted}','accepted'),
        ('${groupA}','${users.notificationsOff}','accepted');
      insert into notification_preferences values('${users.notificationsOff}',false);`)
    await db.exec(oldGift)
    await db.exec(`create or replace function public.xelay_private_birthday_gift_clock() returns timestamptz language sql volatile set search_path='' as $$select value from fixture.clock$$;
      drop trigger notification_email_queue on notifications;
      create trigger notification_email_queue after insert on notifications for each row when(new.type is distinct from 'birthday_gift' and new.type is distinct from 'appreciation_gift') execute function public.xelay_queue_notification_email();`)
    const claimBefore=(await rows("select pg_get_functiondef('public.xelay_claim_birthday_gift(uuid)'::regprocedure) body"))[0].body
    const reflowBefore=(await rows("select pg_get_functiondef('public.xelay_reflow_participant_access(uuid)'::regprocedure) body"))[0].body
    const inboxAcl=(await rows("select proacl::text,proowner,prosecdef,proconfig from pg_proc where oid='public.xelay_my_birthday_gifts()'::regprocedure"))[0]
    await t.test('inbox guard preserves production CRLF/one-space and repository LF/two-space bodies and all metadata, rejecting changed or duplicated authentication',async()=>{
      await db.exec('create function public.xelay_private_ensure_profile_birthday_gift(uuid) returns boolean language sql as $$select false$$')
      const productionDefinition=body=>"create or replace function public.xelay_my_birthday_gifts() returns jsonb language plpgsql stable security definer set search_path='' as $production$"+body+'$production$;'
      const state=async()=>first(await db.query("select prosrc source,to_jsonb(p)-'prosrc' metadata from pg_proc p where p.oid='public.xelay_my_birthday_gifts()'::regprocedure"))
      for(const definition of [inboxDefinition,productionDefinition(productionInboxBody),productionDefinition(oneSpaceInboxBody)])for(const guardSql of [inboxGuard,inboxGuard.replaceAll('\n','\r\n')]) {
        await db.exec(definition)
        const before=await state()
        await db.exec(guardSql)
        const after=await state()
        assert.deepEqual(after.metadata,before.metadata)
        const line=before.source.match(/(^|\n)([ \t]*)if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;(\r?\n)/)
        const inserted=line[0]+line[2]+'perform public.xelay_private_ensure_profile_birthday_gift(v_user);'+line[3]
        assert.equal(after.source,before.source.replace(line[0],inserted))
        assert.equal(after.source.replace(inserted,line[0]),before.source)
      }
      for(const body of [productionInboxBody.replace('Authentication required','Different authentication'),
        productionInboxBody.replace('if v_user is null','if v_user is not null'),
        productionInboxBody.replace(authStatement,authStatement+'\r\n '+authStatement)]) {
        await db.exec(productionDefinition(body))
        const before=await state()
        await assert.rejects(db.exec(inboxGuard),/PROFILE_BIRTHDAY_INBOX_SOURCE_DRIFT/)
        assert.deepEqual(await state(),before)
      }
      await db.exec(inboxDefinition)
      await db.exec('drop function public.xelay_private_ensure_profile_birthday_gift(uuid)')
    })
    await t.test('installation preflight rejects incompatible notification checks or changed delivery triggers atomically',async()=>{
      await db.exec("alter table notifications add constraint fixture_reject_birthdays check(type is distinct from 'group_birthday')")
      await assert.rejects(db.exec(migration),/PROFILE_BIRTHDAY_NOTIFICATION_CHECK_UNSUPPORTED/)
      await db.exec('rollback')
      assert.equal((await rows("select to_regclass('public.profile_birthdays') value"))[0].value,null)
      await db.exec('alter table notifications drop constraint fixture_reject_birthdays')
      const original=(await rows("select pg_get_triggerdef(oid) body from pg_trigger where tgrelid='notifications'::regclass and tgname='notification_email_queue'"))[0].body
      await db.exec("drop trigger notification_email_queue on notifications;create trigger notification_email_queue after insert on notifications for each row when(new.type is distinct from 'birthday_gift') execute function xelay_queue_notification_email()")
      await assert.rejects(db.exec(migration),/PROFILE_BIRTHDAY_DELIVERY_TRIGGER_DRIFT/)
      await db.exec('rollback')
      assert.equal((await rows("select to_regclass('public.profile_birthdays') value"))[0].value,null)
      await db.exec('drop trigger notification_email_queue on notifications;'+original)
    })
    await db.exec(migration)
    assert.equal((await rows("select pg_get_functiondef('public.xelay_claim_birthday_gift(uuid)'::regprocedure) body"))[0].body,claimBefore)
    assert.equal((await rows("select pg_get_functiondef('public.xelay_reflow_participant_access(uuid)'::regprocedure) body"))[0].body,reflowBefore)
    assert.deepEqual((await rows("select proacl::text,proowner,prosecdef,proconfig from pg_proc where oid='public.xelay_my_birthday_gifts()'::regprocedure"))[0],inboxAcl)
    assert.equal(await count('birthday_gifts'),0)

    await t.test('private defaults, validation and explicit sharing without birth-year/age columns',async()=>{
      const initial=(await asUser(users.birthday,'select xelay_my_birthday_profile() value'))[0].value
      assert.deepEqual(initial,{day:null,month:null,share_with_groups:false})
      assert.deepEqual(await save(users.birthday,29,10),{day:29,month:10,share_with_groups:false})
      for(const args of [[31,4,false],[30,2,false],[0,1,false],[1,13,false],[null,1,false],[null,null,true]])
        await assert.rejects(save(users.birthday,...args),error=>error.code==='22023')
      for(const role of ['anon','authenticated','service_role'])
        await denied(asUser(users.birthday,'select * from profile_birthdays',[],{role}))
      for(const role of ['anon','authenticated','service_role'])
        await denied(asUser(users.birthday,'select xelay_private_ensure_profile_birthday_gift($1)',[users.birthday],{role}))
      await assert.rejects(asUser(users.member,'select xelay_save_my_birthday_profile(29,10,true,$1)',[users.birthday]),error=>error.code==='42883')
      await denied(asUser(null,'select xelay_my_birthday_profile()',[],{role:'anon'}))
      await denied(asUser(users.banned,'select xelay_my_birthday_profile()'))
      assert.equal((await rows("select column_name from information_schema.columns where table_name='profile_birthdays' and column_name~'(year|age|birth_date)'" )).length,0)
      const evidence=(await rows('select notice_version,consent_updated_at,updated_at from profile_birthdays where user_id=$1',[users.birthday]))[0]
      assert.equal(evidence.notice_version,'2026-10-29.1')
      assert.equal(new Date(evidence.consent_updated_at).toISOString(),'2026-10-29T10:00:00.000Z')
    })
    let gift
    await t.test('existing own inbox ensures one private annual offer but never starts an entitlement',async()=>{
      gift=(await gifts(users.birthday))[0]
      assert.equal(gift.recipient_name,'')
      assert.equal(gift.gift_year,2026)
      assert.equal(gift.claimed_at,null)
      assert.equal((await gifts(users.birthday))[0].id,gift.id)
      assert.equal(await count('birthday_gifts'),1)
      assert.equal(await count('participant_entitlements'),0)
      assert.equal((await worker()).group_notifications,0)
      assert.equal(await count('notification_email_outbox'),0)
      assert.equal(await count('participant_push_outbox'),0)
    })
    await t.test('upcoming group list is server-date scoped, accepts representatives without membership and denies teacher/admin/pending/outsider',async()=>{
      await save(users.rep,30,10,true)
      assert.deepEqual((await group(users.member)).map(item=>item.user_id),[users.rep])
      const next=(await group(users.birthday))[0]
      assert.equal(next.days_until,1);assert.equal(next.is_today,false)
      assert.deepEqual(Object.keys(next).sort(),['avatar_url','day','days_until','full_name','is_today','month','user_id'])
      for(const user of [users.teacher,users.admin,users.pending,users.former,users.repB])await denied(group(user))
      assert.equal((await group(users.rep))[0].user_id,users.rep)
    })
    await t.test('later same-day opt-in produces bounded, idempotent notices to exact accepted classmates once across overlapping groups',async()=>{
      await save(users.birthday,29,10,true)
      let result=await worker(1),calls=1
      assert.deepEqual(Object.keys(result).sort(),['gifts_offered','group_notifications','has_more','processed','today'])
      assert.ok(result.group_notifications<=1);assert.equal(result.gifts_offered,0)
      while(result.has_more&&calls++<8) {result=await worker(1);assert.ok(result.group_notifications<=1)}
      assert.equal(result.has_more,false)
      assert.equal(await count('birthday_profile_dispatches','where user_id=$1',[users.birthday]),3)
      assert.equal((await notices(users.member)).length,1)
      assert.equal((await notices(users.rep)).length,1)
      assert.equal((await notices(users.repB)).length,1)
      assert.equal((await notices(users.notificationsOff)).length,0)
      assert.equal(await count('birthday_profile_dispatches','where recipient_id=$1',[users.notificationsOff]),0)
      assert.equal((await worker()).group_notifications,0)
      assert.equal(await count('notification_email_outbox'),0)
      assert.equal(await count('participant_push_outbox'),0)
      await denied(asUser(users.member,'select xelay_process_due_birthdays(100)'))
      for(const limit of [0,101,null])await assert.rejects(worker(limit),error=>error.code==='22023')
      assert.equal((await group(users.member)).find(item=>item.user_id===users.birthday).is_today,true)
    })
    await t.test('global notification opt-out immediately hides stored group reminders without exposing hidden birthdays',async()=>{
      await db.query('insert into notification_preferences values($1,false)',[users.member])
      assert.equal((await notices(users.member)).length,0)
      await db.query('update notification_preferences set notifications_enabled=true where user_id=$1',[users.member])
      assert.equal((await notices(users.member)).length,1)
    })
    await t.test('new delivery-trigger boundary still excludes group birthdays if a future push function becomes generic',async()=>{
      const notice=(await notices(users.member))[0]
      await db.exec(`create or replace function public.xelay_queue_participant_push() returns trigger language plpgsql security definer set search_path='' as $$
        begin insert into public.participant_push_outbox(subscription_id,notification_id) select id,new.id from public.participant_push_subscriptions where user_id=new.recipient_id;return new;end$$;`)
      await db.query('delete from notifications where id=$1',[notice.id])
      await db.query(`insert into notifications(recipient_id,actor_id,actor_name,type,message,study_group_id,birthday_event_id)
        values($1,$2,'Synthetic','group_birthday','Synthetic',$3,$4)`,[users.member,users.birthday,notice.study_group_id,notice.birthday_event_id])
      assert.equal(await count('participant_push_outbox'),0)
      assert.equal(await count('notification_email_outbox'),0)
      await db.exec(actualPush)
    })
    await t.test('legacy broad browser grants cannot forge events, convert notification types, or attach private metadata',async()=>{
      const notice=(await notices(users.member))[0]
      // A legacy nullable type must not turn CHECK UNKNOWN into acceptance.
      await db.exec('alter table notifications alter column type drop not null')
      await assert.rejects(rows(`insert into notifications(recipient_id,actor_id,actor_name,type,message,study_group_id,birthday_event_id)
        values($1,$2,'Synthetic',null,'Invalid',$3,$4)`,[users.member,users.birthday,groupA,notice.birthday_event_id]),error=>error.code==='23514')
      await db.exec('alter table notifications alter column type set not null')
      await db.exec('grant insert,update on notifications to authenticated;create policy fixture_legacy_insert on notifications for insert to authenticated with check(true)')
      await denied(asUser(users.member,`insert into notifications(recipient_id,actor_id,actor_name,type,message,study_group_id,birthday_event_id)
        values($1,$2,'Synthetic','group_birthday','Forged',$3,$4)`,[users.member,users.birthday,groupA,notice.birthday_event_id]))
      const ordinary=(await rows("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Synthetic','answer','Ordinary') returning id",[users.member]))[0].id
      await denied(asUser(users.member,"update notifications set type='group_birthday',birthday_event_id=$2,study_group_id=$3 where id=$1",[ordinary,notice.birthday_event_id,groupA]))
      await denied(asUser(users.member,'update notifications set birthday_event_id=$2 where id=$1',[ordinary,notice.birthday_event_id]))
      await denied(asUser(users.member,"update notifications set message='Changed' where id=$1",[notice.id]))
      assert.equal((await asUser(users.member,'update notifications set is_read=true where id=$1 returning is_read',[notice.id]))[0].is_read,true)
      await db.exec('drop policy fixture_legacy_insert on notifications;revoke insert,update on notifications from authenticated;grant update(is_read) on notifications to authenticated')
      await db.query('delete from notifications where id=$1',[ordinary])
    })
    await t.test('no-op save preserves notices, but opt-out and re-opt-in permanently invalidate old revisions without repeats',async()=>{
      assert.equal((await notices(users.member)).length,1)
      const before=(await rows('select disclosure_revision from profile_birthdays where user_id=$1',[users.birthday]))[0].disclosure_revision
      await save(users.birthday,29,10,true)
      assert.equal((await rows('select disclosure_revision from profile_birthdays where user_id=$1',[users.birthday]))[0].disclosure_revision,before)
      assert.equal((await notices(users.member)).length,1)
      await save(users.birthday,29,10,false)
      assert.equal((await notices(users.member)).length,0)
      assert.equal((await group(users.member)).some(item=>item.user_id===users.birthday),false)
      await save(users.birthday,29,10,true)
      assert.equal((await notices(users.member)).length,0)
      assert.equal((await worker()).group_notifications,0)
    })
    await t.test('date editing, clearing and departure of either group participant hide existing bell rows directly through RLS',async()=>{
      for(const name of ['dateEdited','cleared','subjectLeft','recipientLeft']) {
        const user=users[name]
        await db.query("insert into study_group_members(group_id,user_id,status) values($1,$2,'accepted')",[groupA,user])
        await save(user,29,10,true);await worker()
        assert.equal((await notices(users.member,user)).length,1)
        if(name==='dateEdited')await save(user,30,10,true)
        if(name==='cleared')await save(user,null,null,false)
        if(name==='subjectLeft')await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groupA,user])
        if(name==='recipientLeft')await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groupA,users.member])
        assert.equal((await notices(users.member,user)).length,0)
        if(name==='recipientLeft')await db.query("update study_group_members set status='accepted' where group_id=$1 and user_id=$2",[groupA,users.member])
      }
    })
    await t.test('manual annual gifts consume the same slot, existing claim is idempotent and date changes cannot issue extra months',async()=>{
      const offered=(await asUser(users.admin,'select xelay_admin_offer_birthday_gift($1,$2) value',[users.manual,'Manual'],{aal:'aal2'}))[0].value
      await save(users.manual,29,10)
      assert.equal((await gifts(users.manual))[0].id,offered.id)
      assert.equal((await gifts(users.manual))[0].recipient_name,'Manual')
      const claimed=(await asUser(users.birthday,'select xelay_claim_birthday_gift($1) value',[gift.id]))[0].value
      assert.equal(claimed.newly_claimed,true)
      assert.equal((await asUser(users.birthday,'select xelay_claim_birthday_gift($1) value',[gift.id]))[0].value.newly_claimed,false)
      assert.equal(await count('participant_entitlements','where user_id=$1',[users.birthday]),1)
      await save(users.birthday,30,10,true);await setTime('2026-10-30T10:00:00Z')
      assert.equal((await gifts(users.birthday)).length,1)
      assert.equal(await count('participant_entitlements','where user_id=$1',[users.birthday]),1)
      await denied(asUser(users.member,'select xelay_claim_birthday_gift($1)',[gift.id]))
    })
    await t.test('Kyiv midnight, Feb29 observance, year rollover and expiring notices use only the server clock',async()=>{
      await save(users.midnight,29,10)
      await setTime('2027-10-28T20:59:59Z') // Kyiv UTC+3 before autumn transition.
      assert.equal((await gifts(users.midnight)).length,0)
      await setTime('2027-10-28T21:00:00Z')
      assert.equal((await gifts(users.midnight))[0].gift_year,2027)
      await save(users.leap,29,2)
      await setTime('2027-02-28T10:00:00Z');assert.equal((await gifts(users.leap))[0].gift_year,2027)
      await setTime('2028-02-28T10:00:00Z');assert.equal((await gifts(users.leap)).length,1)
      await setTime('2028-02-29T10:00:00Z');assert.equal((await gifts(users.leap))[0].gift_year,2028)
      await setTime('2026-10-30T10:00:00Z');assert.equal((await notices(users.rep)).length,0)
      assert.equal(await count('notification_email_outbox'),0)
      assert.equal(await count('participant_push_outbox'),0)
    })
    peakRss=Math.max(peakRss,process.memoryUsage().rss/1024**2)
    t.diagnostic(JSON.stringify({actualBirthdayMigrationsExecuted:true,peakRssMiB:Math.round(peakRss),rssCapMiB:600,freeBeforeMiB:Math.round(beforeFree),minimumFreeMiB,noProductionConnections:true}))
  } finally {await db.close();clearInterval(guard);clearTimeout(deadline)}
})
