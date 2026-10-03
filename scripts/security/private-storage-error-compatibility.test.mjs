// Offline PostgreSQL trigger tests. No Storage HTTP, blobs, accounts or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/202610030015_private_storage_error_compatibility.sql', root), 'utf8')
const sources = [
  ['xelay_private_guard_storage_upload', '202610030005_message_chat_security.sql', 5],
  ['xelay_private_guard_storage_size_update', '202610030005_message_chat_security.sql', 4],
  ['xelay_private_guard_storage_delete', '202610030012_media_cleanup_storage_versions.sql', 2],
  ['xelay_private_invalidate_seminar_cleanup', '202610030005_message_chat_security.sql', 1],
  ['xelay_chat_guard_media_delete', '202610020011_chat_publications_faculty_admins.sql', 1],
]
const definitions = new Map(await Promise.all(sources.map(async ([name, file, count]) => [name,
  { source: await readFile(new URL(`supabase/migrations/${file}`, root), 'utf8'), count }]
)))
const definition = (source, name) => source.replaceAll('\r\n', '\n').match(new RegExp(
  `create or replace function public\\.${name}\\(\\)[\\s\\S]*?\\nend \\$\\$;`
))[0]
const remap = (source) => source.replace(/raise exception ('[^']+');/g, "raise exception $1 using errcode='42501';")
const first = (result) => result.rows[0]
const rejected = (work, message, code = '42501') => assert.rejects(work,
  (error) => error.code === code && error.message.includes(message))

test('015 changes only thirteen default denial codes in five current Storage trigger definitions', () => {
  assert.deepEqual([...migration.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]), sources.map(([name]) => name))
  for (const [name, { source, count }] of definitions) {
    const oldDefinition = definition(source, name)
    assert.equal((oldDefinition.match(/raise exception '[^']+';/g) || []).length, count, name)
    assert.equal(definition(migration, name), remap(oldDefinition), name)
  }
  assert.doesNotMatch(migration, /\b(?:drop|grant)\b|create\s+(?:table|trigger|policy|index)|alter\s+(?:table|policy)/i)
  assert.match(migration, /from public,anon,authenticated,service_role;/)
})

test('current private Storage denials use42501 with unchanged uploads, locks and leases', async (t) => {
  const fx = await createFixture({ useStagingParity: true, through: '202610030014' })
  const { db, asUser, seedUser } = fx
  const owner = randomUUID(), recipient = randomUUID(), outsider = randomUUID()
  const bucket = 'xelay-message-media'
  const service = (sql, params = []) => asUser(null, sql, params, { role: 'service_role' })
  const reserve = (name, mediaBucket = bucket, user = owner) => asUser(user,
    'select xelay_private_reserve_media($1,$2)', [mediaBucket, name])
  const insert = (name, metadata = { size: 10, mimetype: 'image/png' }, mediaBucket = bucket, user = owner) => service(
    'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb) returning *',
    [mediaBucket, name, user, JSON.stringify(metadata)])
  const object = async (name) => first(await db.query('select * from storage.objects where name=$1', [name]))
  const reservation = async (name) => first(await db.query('select * from private_media_upload_reservations where storage_path=$1', [name]))
  const catalog = async () => (await db.query(`select p.oid::regprocedure::text as signature,p.proname,p.prosrc,p.proconfig,p.prosecdef
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' order by p.oid`)).rows
  let conversation
  const path = (label = 'file', user = owner, conv = conversation) => `${conv}/${user}/${randomUUID()}/${label}.png`
  const upload = async (name, mediaBucket = bucket, user = owner) => {
    await reserve(name, mediaBucket, user); return first(await insert(name, undefined, mediaBucket, user))
  }
  try {
    for (const user of [owner, recipient, outsider]) await seedUser(user)
    conversation = first(await db.query('insert into conversations(user_one_id,user_two_id) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) returning id', [owner, recipient])).id
    await db.query("insert into participant_entitlements(user_id,source,valid_from,valid_until) values($1,'admin_grant',now()-interval '1 day',now()+interval '1 year')", [owner])

    await t.test('reproduces unreserved P0001 before015; replacement is idempotent and changes no other functions', async () => {
      const name = path('unreserved')
      await rejected(insert(name), 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED', 'P0001')
      const before = await catalog()
      await db.exec(migration); await db.exec(migration)
      const after = await catalog()
      assert.equal(after.length, before.length)
      for (const old of before) {
        const current = after.find((row) => row.signature === old.signature)
        assert.deepEqual(current, { ...old, prosrc: definitions.has(old.proname) ? remap(old.prosrc) : old.prosrc }, old.signature)
      }
      await rejected(insert(name), 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED')
      assert.equal(await object(name), undefined)
      const triggers = (await db.query(`select p.proname from pg_trigger t join pg_proc p on p.oid=t.tgfoid
        where t.tgrelid='storage.objects'::regclass and not t.tgisinternal and p.proname=any($1::text[])`, [sources.map(([name]) => name)])).rows
      assert.equal(triggers.length, 5)
      for (const [name] of sources) for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal(first(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, `public.${name}()`])).allowed, false)
      }
    })

    await t.test('rolled-back permission preview and service final writes still work in both private buckets', async () => {
      for (const mediaBucket of [bucket, 'xelay-chat-media']) {
        const name = mediaBucket === bucket ? path('valid') : `${owner}/${randomUUID()}/valid.png`
        await reserve(name, mediaBucket)
        await db.exec('begin')
        try {
          await asUser(owner, 'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb)',
            [mediaBucket, name, owner, JSON.stringify({ mimetype: 'image/png', contentLength: 4096 })])
        } finally { await db.exec('rollback') }
        assert.equal(await object(name), undefined); assert.ok(await reservation(name))
        assert.equal(first(await insert(name, undefined, mediaBucket)).owner_id, owner)
        assert.equal(await reservation(name), undefined)
      }
    })

    await t.test('INSERT membership, invalid metadata and expired reservation denials preserve rows and reservations', async () => {
      const foreign = first(await db.query('insert into conversations(user_one_id,user_two_id) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) returning id', [recipient, outsider])).id
      const forbidden = path('foreign', owner, foreign)
      await rejected(asUser(owner, 'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb)',
        [bucket, forbidden, owner, JSON.stringify({ size: 10, mimetype: 'image/png' })]), 'PRIVATE_MEDIA_FORBIDDEN')
      const invalid = path('invalid'); await reserve(invalid)
      await rejected(insert(invalid, { size: 26214401, mimetype: 'image/png' }), 'PRIVATE_MEDIA_INVALID')
      assert.equal(await object(invalid), undefined); assert.ok(await reservation(invalid))
      const expired = path('expired'); await reserve(expired)
      await db.query("update private_media_upload_reservations set expires_at=now()-interval '1 second' where storage_path=$1", [expired])
      await rejected(insert(expired), 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED')
      assert.equal(await object(expired), undefined); assert.ok(await reservation(expired))
    })

    await t.test('metadata UPDATE guards preserve old object and pending reservation on rejection', async () => {
      const name = path('update'); await upload(name)
      const before = await object(name)
      await rejected(service('update storage.objects set metadata=$1::jsonb where name=$2',
        [JSON.stringify({ size: 26214401, mimetype: 'image/png' }), name]), 'PRIVATE_MEDIA_INVALID')
      assert.deepEqual(await object(name), before)
      await rejected(service('update storage.objects set owner_id=null,metadata=$1::jsonb where name=$2',
        [JSON.stringify({ size: 11, mimetype: 'image/png' }), name]), 'PRIVATE_MEDIA_FORBIDDEN')
      assert.deepEqual(await object(name), before)
      const pending = path('pending-update'); await reserve(pending)
      await insert(pending, { mimetype: 'image/png', contentLength: 10 })
      assert.ok(await reservation(pending))
      await db.query('delete from private_media_upload_reservations where storage_path=$1', [pending])
      const placeholder = await object(pending)
      await rejected(service('update storage.objects set metadata=$1::jsonb where name=$2',
        [JSON.stringify({ size: 10, mimetype: 'image/png' }), pending]), 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED')
      assert.deepEqual(await object(pending), placeholder)
      await rejected(reserve(pending), 'PRIVATE_MEDIA_IN_USE', 'P0001')
      // Reconstruct the original pending lease only in this synthetic fixture;
      // the normal reserve RPC correctly refuses an already committed object.
      await db.query('insert into private_media_upload_reservations(bucket_id,storage_path,owner_id) values($1,$2,$3)', [bucket, pending, owner])
      await service('update storage.objects set metadata=$1::jsonb where name=$2', [JSON.stringify({ size: 10, mimetype: 'image/png' }), pending])
      assert.equal((await object(pending)).metadata.size, 10); assert.equal(await reservation(pending), undefined)
    })

    await t.test('INSERT and UPDATE quota denials retain42501; normal reserve quota RPC remains P0001', async () => {
      const user = randomUUID(); await seedUser(user)
      const conv = first(await db.query('insert into conversations(user_one_id,user_two_id) values(least($1::uuid,$2::uuid),greatest($1::uuid,$2::uuid)) returning id', [user, recipient])).id
      const existing = path('quota-existing', user, conv); await upload(existing, bucket, user)
      const before = await object(existing)
      await db.query(`insert into private_media_upload_reservations(bucket_id,storage_path,owner_id)
        select $1,$2||'/'||$3||'/'||gen_random_uuid()||'/reserved.png',$3::uuid from generate_series(1,100)`, [bucket, conv, user])
      const name = path('quota-new', user, conv)
      await db.query('insert into private_media_upload_reservations(bucket_id,storage_path,owner_id) values($1,$2,$3)', [bucket, name, user])
      await rejected(insert(name, undefined, bucket, user), 'PRIVATE_MEDIA_QUOTA')
      assert.equal(await object(name), undefined); assert.ok(await reservation(name))
      await rejected(service('update storage.objects set metadata=$1::jsonb where name=$2',
        [JSON.stringify({ size: 11, mimetype: 'image/png' }), existing]), 'PRIVATE_MEDIA_QUOTA')
      assert.deepEqual(await object(existing), before)
      await rejected(reserve(path('quota-rpc', user, conv), bucket, user), 'PRIVATE_MEDIA_QUOTA', 'P0001')
      await rejected(asUser(owner, 'select xelay_send_direct_message($1,$2,$3,null,$4::jsonb)',
        [randomUUID(), conversation, '', '{}']), 'CHAT_INVALID_INPUT', 'P0001')
    })

    await t.test('attached direct media blocks INSERT and DELETE with permissions errors and keeps association', async () => {
      const name = path('attached'); const stored = await upload(name)
      const sent = first(await asUser(owner, 'select xelay_send_direct_message($1,$2,$3,null,$4::jsonb) as value',
        [name.split('/')[2], conversation, 'Synthetic message', JSON.stringify([{ storage_path: name, file_name: 'file.png', media_type: 'image', mime_type: 'image/png' }])])).value
      assert.ok(sent)
      await rejected(service('delete from storage.objects where name=$1', [name]), 'PRIVATE_MEDIA_IN_USE')
      await db.query('insert into private_media_upload_reservations(bucket_id,storage_path,owner_id) values($1,$2,$3)', [bucket, name, owner])
      await rejected(insert(name), 'PRIVATE_MEDIA_IN_USE')
      assert.equal((await object(name)).id, stored.id)
      assert.equal(first(await db.query('select count(*)::int as count from message_attachments where storage_path=$1', [name])).count, 1)
      assert.ok(await reservation(name))
    })

    await t.test('latest012 DELETE still enforces exact age, version, live-object and cleanup claims', async () => {
      await db.exec('alter table storage.objects add column version text; alter table storage.objects add column is_delete_marker boolean default false')
      const name = path('delete'); const stored = await upload(name)
      await rejected(service('delete from storage.objects where name=$1', [name]), 'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      await db.query("update storage.objects set created_at=now()-interval '3 days',updated_at=now()-interval '3 days',version='v1' where name=$1", [name])
      assert.equal(first(await service('select xelay_private_media_cleanup_claim($1,$2,$3) as allowed', [bucket, name, stored.id])).allowed, true)
      await db.query("update storage.objects set version='v2' where name=$1", [name])
      await rejected(service('delete from storage.objects where name=$1', [name]), 'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      assert.equal(first(await service('select xelay_private_media_cleanup_claim($1,$2,$3) as allowed', [bucket, name, stored.id])).allowed, true)
      await db.query('update storage.objects set is_delete_marker=true where name=$1', [name])
      await rejected(service('delete from storage.objects where name=$1', [name]), 'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED')
      await db.query('update storage.objects set is_delete_marker=false where name=$1', [name])
      assert.equal((await service('delete from storage.objects where name=$1 returning id', [name])).rows.length, 1)
      assert.equal(await object(name), undefined)
      assert.equal(first(await db.query('select count(*)::int as count from private_media_cleanup_claims where storage_path=$1', [name])).count, 0)
    })

    await t.test('legacy chat-avatar DELETE denial is remapped; legitimate detach and owner delete still work', async () => {
      const name = `${owner}/${randomUUID()}/avatar.png`; await upload(name, 'xelay-chat-media')
      const space = first(await asUser(owner, "select xelay_chat_create('group','private','Synthetic chat',null,'',$1) as id", [name])).id
      await rejected(service('delete from storage.objects where name=$1', [name]), 'CHAT_MEDIA_IN_USE')
      assert.equal(first(await db.query('select avatar_path from chat_spaces where id=$1', [space])).avatar_path, name)
      await asUser(owner, 'select xelay_chat_update($1,$2::jsonb)', [space, JSON.stringify({ avatar_path: null })])
      assert.equal((await asUser(owner, 'delete from storage.objects where name=$1 returning id', [name])).rows.length, 1)
    })

    await t.test('actual seminar-name invalidation trigger remaps denial without changing valid path behavior', async () => {
      const invalid = `invalid-${randomUUID()}.pdf`
      await rejected(insert(invalid, { size: 10, mimetype: 'application/pdf' }, 'xelay-seminar-files'), 'SEMINAR_RESOURCE_INVALID_INPUT')
      assert.equal(await object(invalid), undefined)
      const valid = `${randomUUID()}/${owner}/${randomUUID()}-resource.pdf`
      assert.equal(first(await insert(valid, { size: 10, mimetype: 'application/pdf' }, 'xelay-seminar-files')).name, valid)
    })
  } finally { await fx.close() }
})
