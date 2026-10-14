// Offline PostgreSQL only. Synthetic accounts; no network, credentials or email.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/202610140002_all_notification_email.sql', root), 'utf8')
const unreadMigration = await readFile(new URL('supabase/migrations/202610070008_notification_email_unread.sql', root), 'utf8')
const first = result => result.rows[0]
const denied = work => assert.rejects(work, error => error.code === '42501')

async function emailFixture() {
  // Real email/DM migrations with their grants and RLS; unrelated academic,
  // billing and storage schemas are not prerequisites for this migration.
  const fx = await createFixture({ migrations: [
    '202609260001_profile_connections_messages.sql',
    '202610010004_email_notifications.sql',
  ] })
  await fx.db.exec('alter table public.messages add column deleted_at timestamptz')
  await fx.db.exec(unreadMigration)
  return fx
}

test('all-notification migration changes private mail delivery without replay or access expansion', async t => {
  const fx = await emailFixture()
  const { db, asUser, seedUser } = fx
  const actor = randomUUID(), owner = randomUUID()
  const recipient = async () => { const id = randomUUID(); await seedUser(id); return id }
  const notify = async (id, type = 'question_comment', { isRead = false, actorId = actor } = {}) => first(await asUser(null,
    `insert into notifications(recipient_id,actor_id,actor_name,type,message,is_read)
     values($1,$2,'Synthetic actor',$3,'Private synthetic event text',$4) returning id`,
    [id, actorId, type, isRead], { role: 'service_role' }
  )).id
  const jobs = async id => (await db.query(
    'select * from notification_email_outbox where recipient_id=$1 order by created_at,id', [id]
  )).rows
  const claim = async jobId => first(await asUser(null,
    'select * from xelay_claim_notification_email($1)', [jobId], { role: 'service_role' }
  ))
  const finish = async (job, status = 'sent', error = null) => first(await asUser(null,
    'select xelay_finish_notification_email($1,$2,$3,$4,$5) as finished',
    [job.id, job.lock_token, status, error, status === 'sent' ? 'synthetic-provider-id' : null],
    { role: 'service_role' }
  )).finished
  try {
    await seedUser(actor); await seedUser(owner)
    const oldNotification = await notify(owner, 'chat_invite')
    assert.equal((await jobs(owner)).length, 0)
    const oldQueued = await notify(owner, 'answer')
    assert.equal((await jobs(owner)).length, 1)

    await t.test('applies transactionally, removes only thread coalescing, and never backfills history', async () => {
      // Mirror the existing teaching trigger with the same stable unique event.
      await db.exec(`create function public.xelay_test_teaching_queue() returns trigger
        language plpgsql security definer set search_path='' as $$ begin
          if new.type='teaching_update' then
            insert into public.notification_email_outbox(notification_id,recipient_id,actor_id,notification_type,event_key)
            values(new.id::text,new.recipient_id::uuid,new.actor_id::uuid,new.type,'notification:'||new.id::text)
            on conflict do nothing;
          end if;
          return new;
        end $$;
        revoke all on function public.xelay_test_teaching_queue() from public,anon,authenticated,service_role;
        create trigger xelay_teaching_email_queue after insert on public.notifications
          for each row execute function public.xelay_test_teaching_queue();`)
      await db.exec(migration)
      assert.equal((await jobs(owner)).length, 1)
      assert.equal((await jobs(owner))[0].notification_id, oldQueued)
      assert.equal(first(await db.query('select count(*)::int as count from notification_email_outbox where notification_id=$1', [oldNotification])).count, 0)
      assert.equal(first(await db.query("select to_regclass('public.notification_email_active_thread_unique') as index")).index, null)
      assert.equal(first(await db.query("select count(*)::int as count from pg_trigger where tgrelid='notifications'::regclass and tgname='xelay_teaching_email_queue'")).count, 0)
      const teaching = await notify(owner, 'teaching_update')
      assert.equal(first(await db.query('select count(*)::int as count from notification_email_outbox where notification_id=$1', [teaching])).count, 1)
      await db.exec(migration)
      assert.equal((await jobs(owner)).length, 2)
      assert.equal(first(await db.query("select count(*)::int as count from pg_trigger where tgrelid='notifications'::regclass and tgname='notification_email_queue'")).count, 1)
    })

    await t.test('all trusted types, already-read events and self-reminders get one immediate job each', async () => {
      const id = await recipient()
      const types = ['answer','question_comment','comment','discussion','answer_comment',
        'connection_request','connection_accepted','news_comment','news_published',
        'news_submission_published','news_submission_rejected','editor_request_approved','editor_request_rejected',
        'class_rep_approved','class_rep_rejected','group_invite','group_invite_accepted','group_homework',
        'chat_invite','chat_join_request','chat_join_approved','chat_message','chat_comment',
        'group_deputy_assigned','group_deputy_permissions','group_deputy_revoked','teaching_update',
        'study_group_update','shared_organizer_invite','shared_organizer_update','future_server_event']
      const notificationIds = []
      for (const type of types) notificationIds.push(await notify(id, type, { isRead: true }))
      notificationIds.push(await notify(id, 'organizer_reminder', { actorId: id, isRead: true }))
      notificationIds.push(await notify(id, 'news_published', { actorId: id }))
      const rows = await jobs(id)
      assert.equal(rows.length, notificationIds.length)
      for (const job of rows) {
        assert.ok(notificationIds.includes(job.notification_id))
        assert.equal(job.event_key, `notification:${job.notification_id}`)
        assert.equal(job.status, 'pending'); assert.equal(job.attempts, 0)
        assert.ok(new Date(job.available_at).getTime() <= Date.now() + 2000)
      }
    })

    await t.test('bursts over the former thirty-per-hour cap retain every distinct event', async () => {
      const id = await recipient()
      for (let index = 0; index < 65; index++) await notify(id, 'group_homework')
      assert.equal((await jobs(id)).length, 65)
      assert.equal(first(await db.query('select count(*)::int as count from notifications where recipient_id=$1', [id])).count, 65)
    })

    await t.test('explicit opt-outs, verified canonical Auth address and deleted accounts remain guarded', async () => {
      for (const column of ['notifications_enabled','email_notifications_enabled']) {
        const id = await recipient()
        await asUser(id, `insert into notification_preferences(user_id,${column}) values($1,false)`, [id])
        await notify(id, 'chat_invite', { isRead: true })
        assert.equal((await jobs(id)).length, 0, column)
      }
      for (const change of ['email_confirmed_at=null', 'deleted_at=now()', "email='' "]) {
        const id = await recipient()
        await db.query(`update auth.users set ${change} where id=$1`, [id])
        await notify(id)
        assert.equal((await jobs(id)).length, 0, change)
      }
      const id = await recipient()
      await notify(id)
      assert.equal((await jobs(id)).length, 1, 'Absent preferences still default enabled')
    })

    await t.test('clients cannot forge events, inspect outbox or execute internal/worker helpers', async () => {
      for (const role of ['anon','authenticated']) {
        const id = role === 'authenticated' ? owner : null
        await denied(asUser(id, 'select * from notification_email_outbox', [], { role }))
        await denied(asUser(id,
          "insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$2,'Forged','future_server_event','Forged')",
          [owner, actor], { role }))
        await denied(asUser(id, 'select * from xelay_claim_notification_email(null)', [], { role }))
        await denied(asUser(id, 'select xelay_notification_email_message_context($1,$2)', [randomUUID(),randomUUID()], { role }))
        await denied(asUser(id, "select xelay_finish_notification_email($1,$2,'sent',null,null)", [randomUUID(),randomUUID()], { role }))
      }
      for (const role of ['anon','authenticated','service_role']) {
        for (const name of ['xelay_queue_notification_email()', 'xelay_private_notification_email_message_state(uuid)']) {
          assert.equal(first(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role,`public.${name}`])).allowed, false)
        }
      }
      for (const name of ['xelay_claim_notification_email(uuid)', 'xelay_notification_email_message_context(uuid,uuid)',
        'xelay_finish_notification_email(uuid,uuid,text,text,text)']) {
        assert.equal(first(await db.query('select has_function_privilege(\'service_role\',$1,\'EXECUTE\') as allowed', [`public.${name}`])).allowed, true)
      }
    })

    await t.test('service leases, stable job IDs, retry backoff, stale locks and twenty-three-hour expiry remain', async () => {
      const id = await recipient(); await notify(id, 'chat_invite', { isRead: true })
      const queued = (await jobs(id))[0]
      assert.equal(await claim(queued.id), undefined, 'Disabled worker cannot claim')
      await asUser(null, 'select xelay_notification_email_worker_heartbeat()', [], { role: 'service_role' })
      let claimed = await claim(queued.id)
      assert.equal(claimed.id, queued.id); assert.equal(claimed.attempts, 1)
      assert.equal(await claim(queued.id), undefined, 'A live lease cannot be claimed again')
      assert.equal(await finish({ ...claimed, lock_token: randomUUID() }), false, 'Foreign token cannot finish')
      assert.equal(await finish(claimed, 'pending', 'provider_429'), true)
      let stored = (await jobs(id))[0]
      assert.equal(stored.id, queued.id); assert.equal(stored.status, 'pending')
      assert.ok(new Date(stored.available_at).getTime() > Date.now() + 45000)
      await db.query("update notification_email_outbox set available_at=now()-interval '1 second' where id=$1", [queued.id])
      claimed = await claim(queued.id)
      assert.equal(claimed.id, queued.id); assert.equal(claimed.attempts, 2)
      await db.query("update notification_email_outbox set locked_until=now()-interval '1 second' where id=$1", [queued.id])
      assert.equal(await finish(claimed), false, 'Expired lease cannot finish')
      const replacement = await claim(queued.id)
      assert.equal(replacement.id, queued.id); assert.notEqual(replacement.lock_token, claimed.lock_token)
      assert.equal(await finish(replacement), true)
      assert.equal(await claim(queued.id), undefined, 'Completed job cannot replay')

      const expired = await recipient(); await notify(expired)
      const old = (await jobs(expired))[0]
      await db.query("update notification_email_outbox set first_delivery_attempt_at=now()-interval '23 hours 1 minute' where id=$1", [old.id])
      assert.equal(await claim(old.id), undefined)
      stored = (await jobs(expired))[0]
      assert.equal(stored.status, 'skipped'); assert.equal(stored.last_error_code, 'expired')
    })

    await t.test('provider quota/configuration deferrals retain unattempted events and pause the whole worker', async () => {
      const id = await recipient(); await notify(id, 'chat_invite')
      const queued = (await jobs(id))[0]
      let leased = await claim(queued.id)
      assert.ok(leased)
      const before = Date.now()
      assert.equal(await finish(leased, 'pending', 'provider_daily_quota'), true)
      let stored = (await jobs(id))[0]
      assert.equal(stored.status, 'pending'); assert.equal(stored.attempts, 0)
      assert.equal(stored.first_delivery_attempt_at, null)
      const expectedDay = new Date(before)
      expectedDay.setUTCHours(0, 5, 0, 0); expectedDay.setUTCDate(expectedDay.getUTCDate() + 1)
      assert.ok(Math.abs(new Date(stored.available_at).getTime() - expectedDay.getTime()) < 2000)
      let status = first(await asUser(null,
        'select xelay_notification_email_delivery_status() as state', [], { role: 'service_role' }
      )).state
      assert.equal(status.pause_reason, 'provider_daily_quota')
      assert.ok(new Date(status.paused_until).getTime() > Date.now())
      const waiting = await recipient(); await notify(waiting)
      const waitingJob = (await jobs(waiting))[0]
      assert.equal(await claim(waitingJob.id), undefined)
      await asUser(null, 'select xelay_notification_email_worker_heartbeat()', [], { role: 'service_role' })
      assert.equal(await claim(waitingJob.id), undefined, 'Heartbeat never clears the provider pause')
      assert.equal((await jobs(waiting))[0].first_delivery_attempt_at, null)

      // Old age alone must not discard an event that has never been attempted.
      await db.query("update notification_email_outbox set created_at=now()-interval '30 days',available_at=now()-interval '1 second' where id=$1", [queued.id])
      await db.exec("update notification_email_runtime set paused_until=now()-interval '1 second',pause_reason=null")
      leased = await claim(queued.id)
      assert.ok(leased); assert.equal(leased.attempts, 1)
      assert.ok(new Date(leased.created_at).getTime() > Date.now() - 5000,
        'RPC created_at compatibility field is the attempt window, not the original event time')
      assert.equal(await finish(leased, 'pending', 'provider_monthly_quota'), true)
      stored = (await jobs(id))[0]
      assert.equal(stored.attempts, 0); assert.equal(stored.first_delivery_attempt_at, null)
      assert.ok(new Date(stored.available_at).getTime() >= Date.now() + 23.9 * 60 * 60 * 1000)

      for (const [code, minimumDelay, maximumDelay] of [
        ['provider_rate_limit', 50000, 70000],
        ['provider_configuration', 590000, 610000],
      ]) {
        await db.exec("update notification_email_runtime set paused_until=now()-interval '1 second',pause_reason=null")
        await db.query("update notification_email_outbox set available_at=now()-interval '1 second' where id=$1", [queued.id])
        leased = await claim(queued.id)
        assert.ok(leased)
        assert.equal(await finish(leased, 'pending', code), true)
        stored = (await jobs(id))[0]
        const delay = new Date(stored.available_at).getTime() - Date.now()
        assert.ok(delay >= minimumDelay && delay <= maximumDelay)
        assert.equal(stored.attempts, 0); assert.equal(stored.first_delivery_attempt_at, null)
        status = first(await asUser(null,
          'select xelay_notification_email_delivery_status() as state', [], { role: 'service_role' }
        )).state
        assert.equal(status.pause_reason, code)
      }

      // Earlier uncertain acceptance keeps its first idempotency window even
      // if a later attempt receives an explicit quota rejection.
      await db.exec("update notification_email_runtime set paused_until=now()-interval '1 second',pause_reason=null")
      const ambiguous = await recipient(); await notify(ambiguous)
      const ambiguousJob = (await jobs(ambiguous))[0]
      leased = await claim(ambiguousJob.id)
      assert.equal(await finish(leased, 'pending', 'delivery_temporarily_unavailable'), true)
      const firstAttempt = (await jobs(ambiguous))[0].first_delivery_attempt_at
      await db.query("update notification_email_outbox set available_at=now()-interval '1 second' where id=$1", [ambiguousJob.id])
      leased = await claim(ambiguousJob.id)
      assert.equal(leased.attempts, 2)
      assert.equal(await finish(leased, 'pending', 'provider_daily_quota'), true)
      stored = (await jobs(ambiguous))[0]
      assert.equal(stored.attempts, 1)
      assert.equal(new Date(stored.first_delivery_attempt_at).getTime(), new Date(firstAttempt).getTime())
      await db.query("update notification_email_outbox set first_delivery_attempt_at=now()-interval '23 hours 1 minute',available_at=now()-interval '1 second' where id=$1", [ambiguousJob.id])
      await db.exec("update notification_email_runtime set paused_until=now()-interval '1 second',pause_reason=null")
      assert.equal(await claim(ambiguousJob.id), undefined)
      assert.equal((await jobs(ambiguous))[0].last_error_code, 'expired')
    })

    await t.test('each direct message mails immediately, even after read, without thread cooldown', async () => {
      const sender = await recipient(), receiver = await recipient()
      // Accepted synthetic contact through the actual request workflow.
      const request = first(await asUser(sender,
        'insert into connection_requests(requester_id,recipient_id) values($1,$2) returning id', [sender,receiver]
      ))
      await asUser(receiver, 'select accept_connection_request($1)', [request.id])
      const conversation = first(await db.query(
        'select id from conversations where user_one_id=least($1::uuid,$2::uuid) and user_two_id=greatest($1::uuid,$2::uuid)',
        [sender,receiver]
      ))
      assert.ok(conversation)
      const messages = []
      for (let index = 0; index < 3; index++) messages.push(first(await asUser(sender,
        'insert into messages(conversation_id,sender_id,recipient_id,body) values($1,$2,$3,$4) returning id',
        [conversation.id,sender,receiver,`Private body ${index}`]
      )).id)
      await asUser(receiver, 'update messages set read_at=now() where conversation_id=$1', [conversation.id])
      const messageJobs = (await jobs(receiver)).filter(job => job.notification_type === 'message')
      assert.equal(messageJobs.length, 3)
      assert.equal(new Set(messageJobs.map(job => job.event_key)).size, 3)
      for (const job of messageJobs) {
        const leased = await claim(job.id)
        assert.ok(leased, 'Read event has an immediate independent lease')
        const context = first(await asUser(null,
          'select xelay_notification_email_message_context($1,$2) as context', [leased.id,leased.lock_token],
          { role: 'service_role' }
        )).context
        assert.equal(context.eligible, true); assert.equal(context.conversation_id, conversation.id)
        assert.deepEqual(Object.keys(context).sort(), ['conversation_id','eligible','reason'])
        assert.equal(await finish(leased), true)
      }
      assert.equal(messages.length, 3)

      // A new message is not suppressed by the three just-completed deliveries.
      await asUser(sender, 'insert into messages(conversation_id,sender_id,recipient_id,body) values($1,$2,$3,$4)',
        [conversation.id,sender,receiver,'Fourth message'])
      const fourth = (await jobs(receiver)).filter(job => job.notification_type === 'message').find(job => job.status === 'pending')
      const leased = await claim(fourth.id)
      assert.ok(leased)
      assert.equal(first(await asUser(null,
        'select xelay_notification_email_message_context($1,$2) as context', [leased.id,randomUUID()],
        { role: 'service_role' }
      )).context.reason, 'lease_lost')
      await asUser(receiver, 'insert into notification_preferences(user_id,email_notifications_enabled) values($1,false)', [receiver])
      assert.equal(first(await asUser(null,
        'select xelay_notification_email_message_context($1,$2) as context', [leased.id,leased.lock_token],
        { role: 'service_role' }
      )).context.reason, 'notifications_disabled')
    })

    await t.test('migration aborts rather than allowing an existing client insert grant', async () => {
      await db.exec('grant insert(type) on public.notifications to authenticated')
      await assert.rejects(db.exec(migration), /Notification inserts must be server-only/)
      await db.exec('rollback')
      await db.exec('revoke insert(type) on public.notifications from authenticated')
      await db.exec(migration)
    })
  } finally { await fx.close() }
})
