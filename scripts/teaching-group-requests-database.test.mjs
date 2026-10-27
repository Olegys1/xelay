// Runs only the new request wrapper against an in-memory PostgreSQL fixture.
// It does not connect to Supabase, an audit service, WSL or a network endpoint.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('sent group request SQL: author scope, conflict checks, cancellation and preserved records', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.profiles(id uuid primary key,full_name text);
    create table public.teaching_courses(id uuid primary key,owner_id uuid,title text,semester text,archived_at timestamptz);
    create table public.study_groups(id uuid primary key,group_name text,representative_id uuid);
    create table public.teaching_course_groups(id uuid primary key,course_id uuid,group_id uuid,status text,invited_by uuid,created_at timestamptz default now(),updated_at timestamptz default now(),accepted_at timestamptz);
    create table public.synthetic_preserved_grades(id int primary key,score numeric);
    insert into public.synthetic_preserved_grades values(1,87);
    create function public.xelay_teaching_assert_user() returns uuid language plpgsql stable security definer set search_path='' as $$
      declare u uuid:=nullif(current_setting('request.jwt.claim.sub',true),'')::uuid; begin if u is null then raise exception 'UNAUTHENTICATED'; end if; return u; end $$;
    create function public.xelay_teaching_permissions(c uuid,u uuid) returns text[] language sql stable security definer set search_path='' as $$
      select case when exists(select 1 from public.teaching_courses where id=c and owner_id=u) then array['manage']::text[] else array[]::text[] end $$;
    create function public.xelay_teaching_lock_course(c uuid,p text) returns void language plpgsql security definer set search_path='' as $$
      declare r public.teaching_courses%rowtype; begin select * into r from public.teaching_courses where id=c for update;
      if not found or r.owner_id<>public.xelay_teaching_assert_user() then raise exception 'TEACHING_FORBIDDEN'; end if;
      if r.archived_at is not null then raise exception 'TEACHING_ARCHIVED'; end if; end $$;
    create function public.xelay_teaching_workspace() returns jsonb language sql stable security definer set search_path='' as $$ select jsonb_build_object('sentinel','existing workspace data','courses','[]'::jsonb) $$;
    create function public.xelay_teaching_mutate(p_action text,p_payload jsonb default '{}'::jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
      declare l public.teaching_course_groups%rowtype; u uuid:=public.xelay_teaching_assert_user(); begin
      if p_action='existing_action' then return jsonb_build_object('preserved',true); end if;
      select * into l from public.teaching_course_groups where id=(p_payload->>'link_id')::uuid for update;
      if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
      if p_action='remove_group' then
        perform public.xelay_teaching_lock_course(l.course_id,'manage');
        update public.teaching_course_groups set status='removed',updated_at=clock_timestamp() where id=l.id;
      elsif p_action='respond_group' then
        if l.status<>'pending_group' or not exists(select 1 from public.study_groups where id=l.group_id and representative_id=u) then raise exception 'TEACHING_CONFLICT'; end if;
        update public.teaching_course_groups set status='accepted',updated_at=clock_timestamp(),accepted_at=clock_timestamp() where id=l.id;
      else raise exception 'TEACHING_INVALID_INPUT'; end if;
      return jsonb_build_object('id',l.id); end $$;
    revoke all on function public.xelay_teaching_workspace(),public.xelay_teaching_mutate(text,jsonb) from public,anon;
    grant execute on function public.xelay_teaching_workspace(),public.xelay_teaching_mutate(text,jsonb) to authenticated;
  `)
  await db.query('insert into public.profiles values($1,$2)', [id(3), 'Synthetic Head'])
  for (const [number, owner, archived] of [[101, 1, false], [102, 2, false], [103, 1, true]]) await db.query('insert into public.teaching_courses values($1,$2,$3,$4,$5)', [id(number), id(owner), `Synthetic subject ${number}`, 'Synthetic 2026', archived ? '2026-01-01T00:00Z' : null])
  for (let n = 201; n <= 205; n++) await db.query('insert into public.study_groups values($1,$2,$3)', [id(n), `Synthetic group ${n}`, id(3)])
  for (const [number, course, group, status, author] of [[301, 101, 201, 'pending_group', 1], [302, 101, 202, 'accepted', 1], [303, 101, 203, 'rejected', 1], [304, 103, 204, 'pending_group', 1], [305, 102, 205, 'pending_group', 2]]) await db.query('insert into public.teaching_course_groups(id,course_id,group_id,status,invited_by) values($1,$2,$3,$4,$5)', [id(number), id(course), id(group), status, id(author)])
  // Supabase projects may pre-grant newly created functions to application roles.
  await db.exec('alter default privileges in schema public grant execute on functions to anon, authenticated, service_role')
  await db.exec(await readFile(new URL('../supabase/migrations/202610270020_teaching_semesters_group_requests.sql', import.meta.url), 'utf8'))
  async function rpc(who, name, args = [], role = 'authenticated') {
    await db.exec(`set role ${role}`)
    try {
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [who ? id(who) : ''])
      return (await db.query(`select public.${name}(${args.map((_, index) => '$' + (index + 1)).join(',')}) as value`, args)).rows[0].value
    } finally { await db.exec('reset role') }
  }
  const workspace = who => rpc(who, 'xelay_teaching_workspace')
  const mutate = (who, action, payload) => rpc(who, 'xelay_teaching_mutate', [action, JSON.stringify(payload)])
  const row = async number => (await db.query('select * from public.teaching_course_groups where id=$1', [id(number)])).rows[0]
  const cancel = async (who, number, patch = {}) => mutate(who, 'cancel_group_invite', { link_id: id(number), expected_updated_at: (await row(number)).updated_at, ...patch })

  await t.test('the existing workspace payload is retained and requests belong to this author only', async () => {
    const owner = await workspace(1), other = await workspace(2), head = await workspace(3)
    assert.equal(owner.sentinel, 'existing workspace data')
    assert.deepEqual(owner.sent_group_requests.map(item => item.id).sort(), [301, 302, 303, 304].map(id))
    assert.deepEqual(other.sent_group_requests.map(item => item.id), [id(305)])
    assert.deepEqual(head.sent_group_requests, [])
    assert.equal(owner.sent_group_requests.find(item => item.id === id(301)).can_cancel, true)
    assert.equal(owner.sent_group_requests.find(item => item.id === id(304)).can_cancel, false)
  })
  await t.test('anonymous callers and direct bypass entrypoints are unavailable', async () => {
    await assert.rejects(rpc(null, 'xelay_teaching_workspace', [], 'anon'), /permission denied/)
    await assert.rejects(rpc(1, 'xelay_teaching_workspace_before_group_requests_20261027'), /permission denied/)
    await assert.rejects(rpc(1, 'xelay_teaching_mutate_before_group_requests_20261027', ['existing_action', '{}']), /permission denied/)
    const grants = (await db.query(`select has_function_privilege('service_role','public.xelay_teaching_workspace()','execute') as workspace,
      has_function_privilege('service_role','public.xelay_teaching_mutate(text,jsonb)','execute') as mutate,
      has_function_privilege('service_role','public.xelay_teaching_workspace_before_group_requests_20261027()','execute') as old_workspace,
      has_function_privilege('service_role','public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)','execute') as old_mutate`)).rows[0]
    assert.deepEqual(grants, { workspace: false, mutate: false, old_workspace: false, old_mutate: false })
  })
  await t.test('another teacher and a group head cannot cancel the author invitation', async () => {
    await assert.rejects(cancel(2, 301), /FORBIDDEN/)
    await assert.rejects(cancel(3, 301), /FORBIDDEN/)
    await assert.rejects(cancel(1, 305), /FORBIDDEN/)
  })
  await t.test('accepted, rejected, archived and changed invitations reject cancellation', async () => {
    await assert.rejects(cancel(1, 302), /CONFLICT/)
    await assert.rejects(cancel(1, 303), /CONFLICT/)
    await assert.rejects(cancel(1, 304), /ARCHIVED/)
    await assert.rejects(cancel(1, 301, { expected_updated_at: '2000-01-01T00:00Z' }), /CONFLICT/)
    assert.equal((await row(301)).status, 'pending_group')
  })
  await t.test('a pending cancellation retains historical data and closes the old invitation', async () => {
    await cancel(1, 301)
    assert.equal((await row(301)).status, 'removed')
    assert.equal(Number((await db.query('select score from public.synthetic_preserved_grades')).rows[0].score), 87)
    await assert.rejects(mutate(3, 'respond_group', { link_id: id(301), accept: true }), /CONFLICT/)
    assert.equal((await workspace(1)).sent_group_requests.find(item => item.id === id(301)).can_cancel, false)
  })
  await t.test('a response arriving before cancellation is retained', async () => {
    const original = await row(305)
    await mutate(3, 'respond_group', { link_id: id(305), accept: true })
    await assert.rejects(cancel(2, 305, { expected_updated_at: original.updated_at }), /CONFLICT/)
    assert.equal((await row(305)).status, 'accepted')
  })
  await t.test('unrelated teaching mutations still delegate to the existing implementation', async () => {
    assert.deepEqual(await mutate(1, 'existing_action', {}), { preserved: true })
  })
})
