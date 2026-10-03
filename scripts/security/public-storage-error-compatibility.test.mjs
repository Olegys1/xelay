// Offline trigger compatibility: no Storage HTTP, files, project or credentials.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const original = await readFile(new URL('supabase/migrations/202610030004_legacy_content_storage_security.sql', root), 'utf8')
const migration = await readFile(new URL('supabase/migrations/202610030014_public_storage_error_compatibility.sql', root), 'utf8')
const definition = (source) => source.replaceAll('\r\n', '\n').match(
  /create or replace function public\.xelay_guard_legacy_public_storage\(\)[\s\S]*?\nend \$\$;/
)[0]
const first = (result) => result.rows[0]
const rejected = (work, message, code = '42501') => assert.rejects(work,
  (error) => error.code === code && (!message || error.message.includes(message)))

test('014 only remaps four guard rejection codes and does not modify Storage DDL or ACL exposure', () => {
  const oldDefinition = definition(original)
  assert.equal((oldDefinition.match(/errcode='22023'/g) || []).length, 4)
  assert.equal(definition(migration), oldDefinition.replaceAll("errcode='22023'", "errcode='42501'"))
  assert.match(migration, /revoke all on function public\.xelay_guard_legacy_public_storage\(\) from public,anon,authenticated,service_role/)
  assert.doesNotMatch(migration, /\b(?:drop|grant)\b|create\s+(?:table|trigger|policy|index)|alter\s+(?:table|policy)/i)
})

test('014 preserves public upload validation, rollback and final service-write rules', async (t) => {
  const fx = await createFixture({ useStagingParity: true, through: '202610030013' })
  const { db, asUser, seedUser } = fx
  const owner = randomUUID(), other = randomUUID()
  const path = (label) => `${owner}/questions/${label}-${randomUUID()}.png`
  const reserve = (name, size = 68, bucket = 'answer-media') => asUser(owner,
    'select xelay_reserve_public_media_upload($1,$2,$3,$4)', [bucket, name, size, 'image/png'])
  const finalInsert = (name, metadata, bucket = 'answer-media', uploader = owner) => asUser(null,
    'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb) returning *',
    [bucket, name, uploader, JSON.stringify(metadata)], { role: 'service_role' })
  const reservation = async (name) => first(await db.query('select * from public_media_upload_reservations where storage_path=$1', [name]))
  const object = async (name) => first(await db.query('select * from storage.objects where name=$1', [name]))
  try {
    await seedUser(owner); await seedUser(other)
    await t.test('reproduces old size-mismatch code and replacement remains safe to rerun', async () => {
      const name = path('before014'); await reserve(name)
      await rejected(finalInsert(name, { size: 69, mimetype: 'image/png' }), 'File differs from upload reservation', '22023')
      assert.equal(await object(name), undefined); assert.equal((await reservation(name)).byte_size, 68)
      await db.exec(migration); await db.exec(migration)
      await rejected(finalInsert(name, { size: 69, mimetype: 'image/png' }), 'File differs from upload reservation')
      assert.equal(await object(name), undefined); assert.equal((await reservation(name)).byte_size, 68)
      assert.equal(first(await db.query("select count(*)::int as count from pg_trigger where tgrelid='storage.objects'::regclass and tgname='xelay_legacy_public_storage_guard'")).count, 1)
    })

    await t.test('valid owner preview rolls back; privileged final writes preserve all three public buckets', async () => {
      for (const bucket of ['avatars', 'answer-media', 'question-images']) {
        const name = path(`valid-${bucket}`); await reserve(name, 68, bucket)
        await db.exec('begin')
        try {
          const preview = first(await asUser(owner,
            'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb) returning metadata',
            [bucket, name, owner, JSON.stringify({ mimetype: 'image/png', contentLength: 4096 })]))
          assert.equal(preview.metadata.size, 68, 'Multipart preview length is not treated as file size')
        } finally { await db.exec('rollback') }
        assert.equal(await object(name), undefined); assert.equal((await reservation(name)).byte_size, 68)
        const written = first(await finalInsert(name, { size: 68, mimetype: 'image/png' }, bucket))
        assert.equal(written.owner_id, owner); assert.equal(written.metadata.size, 68)
        assert.equal(await reservation(name), undefined)
      }
    })

    await t.test('all four guard violations produce permission errors without inserting or consuming reservations', async () => {
      const cases = [
        ['invalid-size', { size: 'invalid', mimetype: 'image/png' }, 'Valid file size required', 68],
        ['unsupported-type', { size: 68, mimetype: 'image/svg+xml' }, 'Unsupported public media type', 68],
        ['reservation-mismatch', { size: 69, mimetype: 'image/png' }, 'File differs from upload reservation', 68],
        ['too-large', { size: 26214401, mimetype: 'image/png' }, 'Public media file is too large', 26214401],
      ]
      for (const [label, metadata, message, size] of cases) {
        const name = path(label)
        if (label === 'too-large') {
          // Synthetic malformed reservation tests defense in depth. The public
          // reserve RPC cannot create this oversized reservation.
          await db.query(`insert into public_media_upload_reservations(bucket_id,storage_path,user_id,byte_size,mimetype,expires_at)
            values('answer-media',$1,$2,$3,'image/png',clock_timestamp()+interval '15 minutes')`, [name, owner, size])
        } else await reserve(name, size)
        await rejected(finalInsert(name, metadata), message)
        assert.equal(await object(name), undefined, label)
        assert.equal((await reservation(name)).byte_size, size, label)
      }
      const missingSize = path('service-missing-size'); await reserve(missingSize)
      await rejected(finalInsert(missingSize, { mimetype: 'image/png', contentLength: 68 }), 'Valid file size required')
      assert.equal(await object(missingSize), undefined); assert.ok(await reservation(missingSize))
    })

    await t.test('mismatching update preserves existing metadata and pending reservation', async () => {
      const name = path('update'); await reserve(name)
      await finalInsert(name, { size: 68, mimetype: 'image/png' })
      const before = await object(name); await reserve(name)
      await rejected(asUser(null, 'update storage.objects set metadata=$1::jsonb where name=$2',
        [JSON.stringify({ size: 69, mimetype: 'image/png' }), name], { role: 'service_role' }), 'File differs from upload reservation')
      assert.deepEqual(await object(name), before); assert.equal((await reservation(name)).byte_size, 68)
      await asUser(owner, 'update storage.objects set metadata=$1::jsonb where name=$2',
        [JSON.stringify({ size: 68, mimetype: 'image/png', cacheControl: '3600' }), name])
      assert.equal((await object(name)).metadata.cacheControl, '3600'); assert.equal(await reservation(name), undefined)
    })

    await t.test('reserve RPC invalid parameters keep22023; owner and reservation guards remain closed', async () => {
      for (const [bucket, size] of [['avatars', 5242881], ['answer-media', 26214401]]) {
        const name = path('oversize-rpc')
        await rejected(reserve(name, size, bucket), 'Invalid public media file', '22023')
        assert.equal(await reservation(name), undefined)
      }
      const name = path('identity'); await reserve(name)
      await rejected(asUser(other, 'insert into storage.objects(bucket_id,name,owner_id,metadata) values($1,$2,$3,$4::jsonb)',
        ['answer-media', name, owner, JSON.stringify({ size: 68, mimetype: 'image/png' })]), 'Upload owner permission required')
      await rejected(finalInsert(name, { size: 68, mimetype: 'image/png' }, 'answer-media', other), 'Reserve upload before sending file')
      assert.equal(await object(name), undefined); assert.ok(await reservation(name))
      for (const role of ['anon', 'authenticated', 'service_role']) {
        assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_guard_legacy_public_storage()','EXECUTE') as allowed", [role])).allowed, false)
      }
    })
  } finally { await fx.close() }
})
