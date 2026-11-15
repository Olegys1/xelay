import test from 'node:test'
import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { createClient } from '@supabase/supabase-js'
import { conversationMemberFilter, isPostgrestUuid, olderRowsFilter, organizerTextFilter } from '../../src/lib/postgrestFilters.ts'

const userId = '00000000-0000-4000-8000-000000000001'

test('raw membership and pagination filters reject injected operators', () => {
  assert.equal(conversationMemberFilter(userId), `user_one_id.eq.${userId},user_two_id.eq.${userId}`)
  const timestamp = '2026-11-06T08:00:00.123456+00:00'
  assert.equal(olderRowsFilter(timestamp, userId), `created_at.lt."${timestamp}",and(created_at.eq."${timestamp}",id.lt.${userId})`)
  for (const payload of [`${userId},id.not.is.null`, `"${userId}"`, `${userId}\n`, `x') OR true --`]) {
    assert.equal(isPostgrestUuid(payload), false)
    assert.throws(() => conversationMemberFilter(payload), /Invalid conversation member ID/)
    assert.throws(() => olderRowsFilter(timestamp, payload), /Invalid pagination cursor/)
  }
  assert.throws(() => olderRowsFilter(`${timestamp},id.not.is.null`, userId), /Invalid pagination cursor/)
})

test('organizer search sends only three literal terms and PostgreSQL does not interpret input as syntax', async () => {
  const requests = []
  const client = createClient('https://fixture.invalid', 'fixture-public-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async input => {
      requests.push(new URL(input))
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
    } },
  })
  const cases = ['*', '.*', 'Alpha|Beta', '_%', 'Шлях\\файл', '"),id.not.is.null,("', "' OR true; SELECT 1 --"]
  const db = new PGlite()
  try {
    await db.exec('create table search_fixture (id int primary key, title text, notes text, subject text)')
    await db.query('insert into search_fixture values ($1,$2,null,null)', [0, 'Alpha Beta'])
    for (const [index, value] of cases.entries()) {
      await db.query('insert into search_fixture values ($1,$2,null,null)', [index + 1, `Перед ${value} після`])
    }
    for (const value of cases) {
      const response = await client.from('organizer_tasks').select('id').eq('user_id', userId).or(organizerTextFilter(value))
      assert.ifError(response.error)
      const params = requests.at(-1).searchParams
      assert.equal(params.get('user_id'), `eq.${userId}`)
      const expression = params.get('or')
      const predicates = [...expression.matchAll(/(title|notes|subject)\.imatch\.("(?:[^"\\]|\\["\\])*")/gu)]
      assert.deepEqual(predicates.map(match => match[1]), ['title', 'notes', 'subject'])
      assert.equal(expression, `(${predicates.map(match => match[0]).join(',')})`)
      const patterns = predicates.map(match => JSON.parse(match[2]))
      const { rows } = await db.query('select id from search_fixture where title ~* $1 or notes ~* $2 or subject ~* $3 order by id', patterns)
      const expected = cases.flatMap((item, index) => item.includes(value) ? [{ id: index + 1 }] : [])
      assert.deepEqual(rows, expected, value)
    }
  } finally {
    await db.close()
  }
})
