import { readFile } from 'node:fs/promises'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
export async function notificationCenterFixture({applyCenter=true}={}) {
  const fx=await courseModulesFixture({additionalMigrations:[
    '202611040060_teaching_test_admission.sql','202611050061_teaching_test_explicit_close.sql','202611050070_teaching_personal_journal_view.sql',
  ]})
  try {
    // 104 and 106 are installed by lessonRoleFixture; these are the real remaining
    // deadline/follow-up/urgent producers, without weakening any source guard.
    for(const name of ['202610310006_assistant_expanded_writes.sql','202611030101_academic_deadline_candidates.sql','202611030102_academic_deadline_reminders.sql',
      '202611030103_teaching_notification_followups.sql','202611030105_urgent_group_notification_events.sql']) {
      try {await fx.db.exec(await read(name))}catch(error){throw new Error(name+': '+error.message,{cause:error})}
    }
    if(applyCenter) await fx.db.exec(await read('202611050080_notification_center.sql'))
    const center=(who,filters={},cursor=null,limit=40)=>fx.rpc(who,'xelay_notification_center',[JSON.stringify(filters),cursor&&JSON.stringify(cursor),limit,who])
    const preferences=(who,values={})=>fx.rpc(who,'xelay_notification_preferences_save',[JSON.stringify({notifications_enabled:true,email_notifications_enabled:true,category_settings:{},...values}),who])
    const service=(name,args=[])=>fx.rpc(null,name,args,{role:'service_role'})
    return {...fx,center,preferences,service,readCenterMigration:()=>read('202611050080_notification_center.sql')}
  } catch(error) {await fx.close();throw error}
}
