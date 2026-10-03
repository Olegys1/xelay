import test from 'node:test'
import assert from 'node:assert/strict'
import {createFixture} from './fixture.mjs'

test('cleanup cursor is service-only and alternates persistently',async()=>{
  const fixture=await createFixture()
  try {
    for(const role of ['anon','authenticated']) await assert.rejects(fixture.asUser(null,'select xelay_media_cleanup_next_scope()',[],{role}),/permission denied/)
    const options={role:'service_role'}
    for(const scope of ['private','public','private']) {
      const result=await fixture.asUser(null,'select xelay_media_cleanup_next_scope() as scope',[],options)
      assert.equal(result.rows[0].scope,scope)
    }
  } finally {await fixture.close()}
})
