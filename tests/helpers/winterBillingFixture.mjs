import { randomUUID } from 'node:crypto'
import { createTeacherBackendFixture } from './teacherBackendFixture.mjs'
const migration = '20261127111754_winter_billing_offers.sql'
export async function createWinterBillingFixture() {
  const fx = await createTeacherBackendFixture()
  try {
    await fx.db.exec(await fx.readMigration('20261117105257_student_max_ai_credits.sql'))
    // The benefits service contract is isolated here; every payment/grant function below is real SQL.
    await fx.db.exec(`create schema xelay_winter_private;
      create table xelay_winter_private.test_clock(at timestamptz);insert into xelay_winter_private.test_clock values('2026-12-31 12:00 Europe/Kyiv');
      create function xelay_winter_private.clock()returns timestamptz language sql as $$select at from xelay_winter_private.test_clock$$;
      create function xelay_winter_private.student_entitlement_before(u uuid)returns jsonb language sql as $$select xelay_student_private.entitlement(u)$$;
      create table xelay_winter_private.test_claims(user_id uuid,day integer,primary key(user_id,day));
      create function xelay_winter_private.earned(u uuid,d integer)returns boolean language sql as $$select exists(select1 from xelay_winter_private.test_claims where user_id=u and day=d)$$;
      create table xelay_winter_private.test_pauses(user_id uuid,audience text,until_at timestamptz,primary key(user_id,audience));
      create function xelay_winter_private.is_paused(u uuid,a text,t timestamptz)returns boolean language sql as $$select exists(select1 from xelay_winter_private.test_pauses where user_id=u and audience=a and until_at>t)$$;
      create function xelay_winter_private.pause_until(u uuid,a text)returns timestamptz language sql as $$select until_at from xelay_winter_private.test_pauses where user_id=u and audience=a and until_at>xelay_winter_private.clock()$$;
      create table xelay_winter_private.test_bonus(user_id uuid,source text,micros bigint,revoked boolean default false,primary key(user_id,source));
      create function xelay_winter_private.award_purchase_bonus(u uuid,s text,m bigint)returns void language sql as $$insert into xelay_winter_private.test_bonus values(u,s,m,false)on conflict do nothing$$;
      create function xelay_winter_private.revoke_purchase_bonus(u uuid,s text)returns void language sql as $$update xelay_winter_private.test_bonus set revoked=true where user_id=u and source=s$$;`.replaceAll('select1', 'select 1'))
    await fx.db.exec(await fx.readMigration(migration))
    const claim = (user, days) => fx.db.query('insert into xelay_winter_private.test_claims select $1,unnest($2::integer[])on conflict do nothing', [user, days])
    const order = (user, audience, plan, months = 1, source = 'own', mode = 'live') => fx.serviceCall('xelay_winter_subscription_order', [user, audience, plan, months, source, mode, 'xelay_' + randomUUID(), '2026-11-27.1'])
    const quote = (user, audience, plan, months = 1, source = 'own') => fx.serviceCall('xelay_winter_subscription_quote', [user, audience, plan, months, source])
    return { ...fx, claim, order, quote }
  } catch (error) { await fx.close(); throw error }
}
