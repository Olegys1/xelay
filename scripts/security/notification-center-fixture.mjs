import { readFile } from 'node:fs/promises'
import { courseModulesFixture } from './teaching-course-modules-fixture.mjs'
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
export async function notificationCenterFixture({applyCenter=true,productionQueueVariant=false}={}) {
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
    if(productionQueueVariant) {
      // Exact separately deployed platform-news suppression, taken from its
      // real release source. Preserve all queue ACLs and every other guard.
      const release=await read('202610220007_platform_news.sql')
      const stanza=release.slice(release.indexOf("select pg_temp.xelay_platform_news_patch('public.xelay_queue_notification_email()',"))
        .match(/\$old\$([\s\S]*?)\$old\$,\s*\$new\$([\s\S]*?)\$new\$\);/)
      if(!stanza) throw new Error('Production queue fixture source drift')
      const source=(await fx.db.query("select pg_get_functiondef('xelay_queue_notification_email()'::regprocedure) body")).rows[0].body
      if(!source.includes(stanza[1])) throw new Error('Production queue fixture anchor drift')
      await fx.db.exec(source.replace(stanza[1],stanza[2]).replace(/^[ \t]+/gm,' '))
    }
    if(applyCenter) await fx.db.exec(await read('202611050080_notification_center.sql'))
    const center=(who,filters={},cursor=null,limit=40)=>fx.rpc(who,'xelay_notification_center',[JSON.stringify(filters),cursor&&JSON.stringify(cursor),limit,who])
    const preferences=(who,values={})=>fx.rpc(who,'xelay_notification_preferences_save',[JSON.stringify({notifications_enabled:true,email_notifications_enabled:true,category_settings:{},...values}),who])
    const service=(name,args=[])=>fx.rpc(null,name,args,{role:'service_role'})
    return {...fx,center,preferences,service,readCenterMigration:()=>read('202611050080_notification_center.sql')}
  } catch(error) {await fx.close();throw error}
}
