// Only an in-memory PostgreSQL fixture. No live keys, rows, storage or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const sql = await readFile(new URL('../supabase/setup/home_dashboard_summary_20261028.sql', import.meta.url), 'utf8')

test('home summary preserves own-work privacy and existing scoped classroom authority', async t => {
  const db = new PGlite(); t.after(() => db.close())
  // Helpers below stand in for the already installed authorization helpers.
  // Deliberately include a broad item-read helper: the new function must ALSO
  // verify exact target membership or exact classroom-staff authority itself.
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.synthetic_accounts(id uuid primary key, current_access boolean default true);
    create table public.synthetic_members(group_id uuid,user_id uuid,status text);
    create table public.synthetic_grants(course_id uuid,group_id uuid,user_id uuid,permissions text[]);
    create table public.teaching_courses(id uuid primary key, archived_at timestamptz);
    create table public.teaching_course_groups(course_id uuid,group_id uuid,status text);
    create table public.teaching_items(id uuid primary key,course_id uuid,kind text,status text,withdrawn_at timestamptz,title text,max_points numeric);
    create table public.teaching_item_targets(item_id uuid,group_id uuid,primary key(item_id,group_id));
    create table public.teaching_submissions(id uuid primary key,item_id uuid,course_id uuid,group_id uuid,user_id uuid,status text,submitted_at timestamptz,private_body text,unique(item_id,group_id,user_id));
    create table public.teaching_activities(id uuid primary key,item_id uuid,course_id uuid,group_id uuid);
    create table public.teaching_entries(id uuid primary key,course_id uuid,group_id uuid,user_id uuid);
    create table public.teaching_grades(id uuid primary key,activity_id uuid,entry_id uuid,published_at timestamptz,published_score numeric,draft_score numeric);
    create function public.xelay_teaching_assert_user() returns uuid language plpgsql stable security definer set search_path='' as $$
      declare u uuid:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
      begin if u is null or not exists(select 1 from public.synthetic_accounts where id=u) then raise exception 'TEACHING_AUTH_REQUIRED' using errcode='42501';end if;return u;end $$;
    create function public.xelay_teaching_group_permissions(c uuid,g uuid,u uuid) returns text[] language sql stable security definer set search_path='' as $$
      select coalesce((select permissions from public.synthetic_grants grant_row join public.synthetic_accounts a on a.id=grant_row.user_id
        where grant_row.course_id=c and grant_row.group_id=g and grant_row.user_id=u and a.current_access),'{}'::text[]) $$;
    create function public.xelay_teaching_is_member(g uuid,u uuid) returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.synthetic_members where group_id=g and user_id=u and status='accepted') $$;
    create function public.xelay_classroom_staff(c uuid,g uuid,u uuid) returns boolean language sql stable security definer set search_path='' as $$
      select public.xelay_teaching_group_permissions(c,g,u)&&array['assignments','grades']::text[]
        and exists(select 1 from public.teaching_course_groups where course_id=c and group_id=g and status='accepted') $$;
    create function public.xelay_classroom_student(i uuid,g uuid,u uuid) returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.synthetic_members where group_id=g and user_id=u and status='accepted')
        and exists(select 1 from public.teaching_items item join public.teaching_item_targets target on target.item_id=item.id and target.group_id=g
          join public.teaching_course_groups link on link.course_id=item.course_id and link.group_id=g and link.status='accepted'
          where item.id=i and item.kind='assignment' and item.status='published') $$;
    create function public.xelay_teaching_can_read_item(i uuid,u uuid) returns boolean language sql stable security definer set search_path='' as $$
      select exists(select 1 from public.teaching_items item join public.teaching_item_targets target on target.item_id=item.id
        where item.id=i and item.withdrawn_at is null and (public.xelay_classroom_staff(item.course_id,target.group_id,u) or public.xelay_classroom_student(i,target.group_id,u))) $$;
    create function public.xelay_private_teaching_closes_at(i uuid,g uuid,u uuid) returns timestamptz language sql stable security definer set search_path='' as $$ select '2026-11-01T18:00:00Z'::timestamptz $$;
    revoke all on all tables in schema public from public,anon,authenticated,service_role;
  `)
  for (let number = 1; number <= 9; number++) await db.query('insert into public.synthetic_accounts values($1,$2)', [id(number), number !== 8])
  for (const [group, user, status] of [[200,1,'accepted'],[200,2,'accepted'],[200,4,'accepted'],[200,3,'invited']]) await db.query('insert into public.synthetic_members values($1,$2,$3)', [id(group),id(user),status])
  await db.query('insert into public.teaching_courses values($1,null),($2,$3)', [id(100),id(101),'2026-01-01T00:00Z'])
  for (const [course,group,status] of [[100,200,'accepted'],[100,201,'accepted'],[100,202,'removed'],[101,200,'accepted']]) await db.query('insert into public.teaching_course_groups values($1,$2,$3)',[id(course),id(group),status])
  for (const [user,group,permissions] of [[5,200,['assignments','grades']],[6,200,['assignments']],[7,200,['materials']],[8,200,['assignments','grades']],[9,201,['grades']]]) await db.query('insert into public.synthetic_grants values($1,$2,$3,$4)',[id(100),id(group),id(user),permissions])
  for (const [number,course,status,withdrawn,max] of [[300,100,'published',false,10],[301,100,'published',false,null],[302,100,'draft',false,10],[303,100,'published',true,10],[304,101,'published',false,10],[305,100,'published',false,10],[307,100,'published',false,10],[308,100,'published',false,10]]) {
    await db.query('insert into public.teaching_items values($1,$2,$3,$4,$5,$6,$7)',[id(number),id(course),'assignment',status,withdrawn?'2026-10-28T12:00Z':null,`Assignment ${number}`,max])
    await db.query('insert into public.teaching_item_targets values($1,$2)',[id(number),id(number===305?202:200)])
  }
  await db.query('insert into public.teaching_item_targets values($1,$2)',[id(300),id(201)])
  for (const [number,item,group,user,status] of [[1001,300,200,1,'draft'],[1002,300,200,2,'submitted'],[1003,300,200,3,'reviewed'],[1004,300,200,4,'submitted'],[1005,300,201,2,'submitted'],[1006,301,200,2,'reviewed'],[1007,301,200,1,'submitted'],[1008,302,200,1,'draft'],[1009,303,200,2,'submitted'],[1010,304,200,2,'submitted'],[1011,305,202,2,'submitted'],[1012,308,200,1,'returned']]) {
    await db.query('insert into public.teaching_submissions values($1,$2,$3,$4,$5,$6,$7,$8)',[id(number),id(item),id(item===304?101:100),id(group),id(user),status,status==='draft'?null:'2026-10-28T09:00:00Z','NEVER RETURN THIS BODY'])
  }
  await db.query('insert into public.teaching_activities values($1,$2,$3,$4)',[id(400),id(300),id(100),id(200)])
  await db.query('insert into public.teaching_entries values($1,$2,$3,$4)',[id(500),id(100),id(200),id(4)])
  await db.query('insert into public.teaching_grades values($1,$2,$3,$4,$5,$6)',[id(600),id(400),id(500),'2026-10-28T09:00Z',8,2])
  await db.exec(sql)

  async function rpc(user, groups = null, role = 'authenticated') {
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user===null?'':id(user)])
    await db.exec(`set role ${role}`)
    try { return (await db.query('select public.xelay_home_teaching_summary($1::uuid[]) as result',[groups?.map(id)??null])).rows[0].result }
    finally { await db.exec('reset role') }
  }

  await t.test('student gets only own explicit states including no submission, not classmates or private content',async()=>{
    const result=await rpc(1,[200])
    assert.deepEqual(result.assignments.map(row=>[row.item_id,row.status]),[[id(300),'draft'],[id(301),'submitted'],[id(307),null],[id(308),'returned']])
    assert.ok(result.assignments.every(row=>row.user_id===id(1)&&row.group_id===id(200)))
    assert.equal(result.teacher_reviews.length,0)
    assert.ok(!JSON.stringify(result).includes('NEVER RETURN THIS BODY'))
    assert.ok(result.assignments.every(row=>!('body'in row)&&!('draft_score'in row)&&!('published_score'in row)))
  })
  await t.test('headman has own statuses but no staff queue or classmates identities',async()=>{
    const result=await rpc(4,[200])
    assert.equal(result.teacher_reviews.length,0)
    assert.ok(result.assignments.every(row=>row.user_id===id(4)))
  })
  await t.test('exact staff group grant counts submissions and grades once, with zero-score grade handled as published',async()=>{
    const result=await rpc(5)
    assert.equal(result.assignments.length,0)
    const assessed=result.teacher_reviews.find(row=>row.item_id===id(300))
    assert.deepEqual([assessed.group_id,assessed.submitted_count,assessed.ungraded_count,assessed.pending_count],[id(200),2,2,3])
    assert.ok(result.teacher_reviews.every(row=>row.group_id===id(200)))
    assert.equal(result.teacher_reviews.find(row=>row.item_id===id(301)).ungraded_count,0,'Unassessed work does not need numeric grades')
    await db.query('update public.teaching_grades set published_score=0 where id=$1',[id(600)])
    const again=(await rpc(5)).teacher_reviews.find(row=>row.item_id===id(300))
    assert.equal(again.ungraded_count,2,'Zero is a valid published score')
  })
  await t.test('assignment-only colleague sees submission counts but no grading information',async()=>{
    const result=await rpc(6)
    const assessed=result.teacher_reviews.find(row=>row.item_id===id(300))
    assert.deepEqual([assessed.submitted_count,assessed.ungraded_count,assessed.pending_count],[2,null,2])
  })
  await t.test('outsider, invited member, material-only colleague and expired teacher get neither private branch',async()=>{
    for(const user of [3,7,8]) assert.deepEqual(await rpc(user),{assignments:[],teacher_reviews:[]})
    assert.deepEqual(await rpc(1,[201]),{assignments:[],teacher_reviews:[]})
    assert.deepEqual(await rpc(5,[201]),{assignments:[],teacher_reviews:[]})
    assert.deepEqual(await rpc(5,[]),{assignments:[],teacher_reviews:[]})
    const second=await rpc(9)
    assert.ok(second.teacher_reviews.every(row=>row.group_id===id(201)))
  })
  await t.test('revocation and group-scope changes take effect on the next read',async()=>{
    await db.query('delete from public.synthetic_grants where user_id=$1',[id(5)])
    assert.deepEqual(await rpc(5),{assignments:[],teacher_reviews:[]})
    await db.query("update public.synthetic_members set status='removed' where user_id=$1",[id(1)])
    assert.deepEqual(await rpc(1),{assignments:[],teacher_reviews:[]})
  })
  await t.test('auth and RPC execution are required; raw private table reads remain revoked',async()=>{
    await assert.rejects(rpc(null),/TEACHING_AUTH_REQUIRED/)
    await assert.rejects(rpc(5,null,'anon'),/permission denied/)
    await assert.rejects(rpc(5,[...Array(101)].map((_,index)=>index+200)),/HOME_GROUP_SCOPE_INVALID/)
    await db.exec('set role authenticated')
    try { await assert.rejects(db.query('select * from public.teaching_submissions'),/permission denied/) }
    finally { await db.exec('reset role') }
    const meta=(await db.query("select provolatile,prosecdef,proconfig from pg_proc where oid='public.xelay_home_teaching_summary(uuid[])'::regprocedure")).rows[0]
    assert.equal(meta.provolatile,'s');assert.equal(meta.prosecdef,true)
    assert.ok(meta.proconfig.includes('search_path=""'))
  })
})
