import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './teaching-scoped-fixture.mjs'
import { verifyStoredBytes } from './upload-content-workflow-bridge.mjs'
const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
export async function audienceFixture({ formatVariant = false, materialSaveFix = true } = {}) {
  const fx = await createTeachingScopedFixture()
  try {
    for (const name of ['202610270001_teaching_group_scopes.sql','202610270002_teaching_multi_group_assignments.sql',
      '202610270003_teaching_material_library.sql','202610270004_teaching_material_library_access.sql',
      '202610270010_student_group_presentations.sql','202610270020_teaching_semesters_group_requests.sql','202610300003_upload_content_quarantine.sql',
      '202611020001_teaching_audiences_announcements.sql','202611020002_teaching_team_submissions.sql',
      '202611030001_fix_group_material_save.sql']) {
      if (!materialSaveFix && name === '202611030001_fix_group_material_save.sql') continue
      if (formatVariant && name === '202611020001_teaching_audiences_announcements.sql') {
        // The read-only production preflight observed these exact statements
        // with one-space indentation. Exercise that known formatting variant,
        // retaining the installed function bodies, permissions and expiry rule.
        for (const signature of ['public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)', 'public.xelay_publish_due_teaching_items()']) {
          const row=(await fx.db.query('select pg_get_functiondef(to_regprocedure($1)) body',[signature])).rows[0]
          const body=row.body.replace(/^[ \t]+(perform public\.xelay_teaching_lock_course\(v_course_id,v_permission\);)$/m,' $1')
            .replace(/^[ \t]+(v_prior:='\[\]'::jsonb;)$/m,' $1')
            .replace(/^[ \t]+(on public\.xelay_teaching_is_member\(t\.group_id,p\.id\) where t\.item_id=v_item\.id)$/m,' $1')
            .replace(/^[ \t]+(and\(v_item\.kind<>'material' or v_item\.access_until is null or v_item\.access_until>clock_timestamp\(\)\))$/m,' $1')
          await fx.db.exec(body)
        }
      }
      const sql=await read(name)
      await fx.db.exec(formatVariant && name.startsWith('20261102') ? sql.replace(/\r?\n/g,'\r\n') : sql)
    }
    return fx
  } catch(error) { await fx.close();throw error }
}

for (const formatting of ['repository-four-space','production-one-space-crlf']) test(`group material creation, publication and updates keep verified files after the assignment-only mode fix (${formatting})`, async t => {
  const fx = await audienceFixture({ materialSaveFix: false });t.after(() => fx.close())
  const { db,ids,groups,dates,rpc,classroom }=fx
  const canonicalSignature='xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)'
  const wrapperBefore=(await db.query("select pg_get_functiondef('xelay_teaching_mutate(text,jsonb)'::regprocedure) body")).rows[0].body
  if (formatting==='production-one-space-crlf') {
    const source=(await db.query('select pg_get_functiondef(to_regprocedure($1)) body',[canonicalSignature])).rows[0].body
    const old="    update public.teaching_items set submission_mode=coalesce(p_payload->>'submission_mode',submission_mode) where id=v_record.id;\n    if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;"
    const observed=old.replace(/^    update/,' update').replace('\n    if','\n if')
    assert.equal(source.split(old).length-1,1)
    const oneSpace=source.replace(old,observed).replace(/\r?\n/g,'\r\n')
    assert.ok(oneSpace.includes("\r\n if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;"))
    await db.exec(oneSpace)
  }
  const metadataBefore=(await db.query('select proowner,proacl,prosecdef,proconfig,provolatile from pg_proc where oid=to_regprocedure($1)',[canonicalSignature])).rows
  const groupBefore=(await db.query('select to_jsonb(g) data from study_groups g order by id')).rows
  const membersBefore=(await db.query('select to_jsonb(m) data from study_group_members m order by group_id,user_id')).rows
  const attachments=[]
  for (let index=0;index<4;index++) {
    const bytes=Buffer.from(`Synthetic lecture material ${index+1}. No real student information.\n`)
    const path=`${ids.course}/${ids.owner}/${randomUUID()}.txt`
    await fx.asUser(ids.owner,'insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values($1,$2,$3::uuid,$3::text,$4::jsonb)',[
      'xelay-teaching-files',path,ids.owner,JSON.stringify({size:bytes.length,mimetype:'text/plain'})])
    const result=await verifyStoredBytes({db,asUser:fx.asUser,actor:ids.owner,bucket:'xelay-teaching-files',path,bytes})
    assert.equal(result.statusCode,200,JSON.stringify(result.body))
    attachments.push({storage_path:path,name:`lecture-${index+1}.txt`,mime_type:'text/plain',size:bytes.length})
  }
  const storedBefore=(await db.query("select to_jsonb(o) data from storage.objects o where bucket_id='xelay-teaching-files' order by name")).rows
  const receiptsBefore=(await db.query('select to_jsonb(r) data from xelay_upload_content_receipts r order by object_id')).rows
  const target={group_id:groups[0],due_at:null,audience_mode:'all',subgroup_ids:[],team_ids:[]}
  const material={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic group presentation',body:'Keep the material and all four verified files',
    links:[],attachments,status:'draft',publish_at:null,material_date:null,allow_download:true,targets:[target]}
  await assert.rejects(fx.mutate(ids.owner,'save_material',material),/TEACHING_CONFLICT/,'reproduces the pre-fix no-op UPDATE against the real material version guard')
  assert.equal(await fx.item(material.id),undefined)
  assert.equal((await db.query('select count(*)n from teaching_item_targets where item_id=$1',[material.id])).rows[0].n,0)
  assert.equal((await db.query('select count(*)n from teaching_create_receipts where request_id=$1',[material.id])).rows[0].n,0)
  assert.deepEqual((await db.query("select to_jsonb(o) data from storage.objects o where bucket_id='xelay-teaching-files' order by name")).rows,storedBefore)

  const migration=await read('202611030001_fix_group_material_save.sql')
  const guardBefore=(await db.query("select pg_get_functiondef('xelay_guard_teacher_material_author()'::regprocedure) body")).rows[0].body
  await db.exec(formatting==='production-one-space-crlf'?migration.replace(/\r?\n/g,'\r\n'):migration)
  assert.deepEqual((await db.query('select proowner,proacl,prosecdef,proconfig,provolatile from pg_proc where oid=to_regprocedure($1)',[canonicalSignature])).rows,metadataBefore)
  assert.equal((await db.query("select pg_get_functiondef('xelay_teaching_mutate(text,jsonb)'::regprocedure) body")).rows[0].body,wrapperBefore)
  const draft=await fx.mutate(ids.owner,'save_material',material)
  assert.equal(draft.id,material.id);assert.equal(draft.version,1)
  assert.deepEqual((await fx.item(material.id)).attachments,attachments)
  assert.equal((await fx.item(material.id)).submission_mode,'individual')
  assert.equal((await db.query('select audience_mode from teaching_item_targets where item_id=$1',[material.id])).rows[0].audience_mode,'all')
  assert.ok(!(await rpc(ids.studentA,'xelay_group_teacher_materials',[groups[0]])).materials.some(item=>item.id===material.id),'a saved draft is still private')
  assert.deepEqual(await fx.mutate(ids.owner,'save_material',material),draft,'exact create replay remains idempotent')
  await assert.rejects(fx.mutate(ids.owner,'save_material',{...material,body:'Different create payload'}),/TEACHING_CONFLICT/)

  const published=await fx.mutate(ids.owner,'save_material',{...material,version:draft.version,status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1'})
  assert.equal(published.version,2)
  const visible=(await rpc(ids.studentA,'xelay_group_teacher_materials',[groups[0]])).materials.find(item=>item.id===material.id)
  assert.ok(visible);assert.deepEqual(visible.attachments,attachments)
  assert.ok(!(await rpc(ids.studentB,'xelay_group_teacher_materials',[groups[1]])).materials.some(item=>item.id===material.id),'other groups do not receive the material')
  const updated=await fx.mutate(ids.owner,'save_material',{...material,version:published.version,status:'published',body:'Updated explanation; same verified files',rights_accepted:true,rights_terms_version:'2026-10-27.1'})
  assert.equal(updated.version,3)
  const after=await fx.item(material.id)
  assert.equal(after.body,'Updated explanation; same verified files');assert.deepEqual(after.attachments,attachments)
  await assert.rejects(fx.mutate(ids.owner,'save_material',{...material,version:published.version,status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1'}),/TEACHING_CONFLICT/,'stale edits are still rejected')
  assert.deepEqual(await fx.item(material.id),after)

  const assignment={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic team assignment',body:'Team mode still works',links:[],attachments:[],status:'published',submission_mode:'team',max_points:10,category:'',
    targets:[{...target,lesson_date:dates.lesson_a,placement_mode:'unplaced',closes_at:null}]}
  const assigned=await classroom(ids.owner,'save_group_assignment',assignment)
  assert.equal((await fx.item(assignment.id)).submission_mode,'team')
  await classroom(ids.owner,'save_group_assignment',{...assignment,version:assigned.version,body:'Updated team assignment'})
  assert.equal((await fx.item(assignment.id)).submission_mode,'team')
  assert.deepEqual((await db.query('select to_jsonb(g) data from study_groups g order by id')).rows,groupBefore)
  assert.deepEqual((await db.query('select to_jsonb(m) data from study_group_members m order by group_id,user_id')).rows,membersBefore)
  assert.deepEqual((await db.query("select to_jsonb(o) data from storage.objects o where bucket_id='xelay-teaching-files' order by name")).rows,storedBefore)
  assert.deepEqual((await db.query('select to_jsonb(r) data from xelay_upload_content_receipts r order by object_id')).rows,receiptsBefore)
  assert.equal((await db.query("select pg_get_functiondef('xelay_guard_teacher_material_author()'::regprocedure) body")).rows[0].body,guardBefore)
  const canonical=(await db.query("select pg_get_functiondef('xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)'::regprocedure) body")).rows[0].body
  await assert.rejects(db.exec(migration),/GROUP_MATERIAL_SAVE_SOURCE_DRIFT/,'an unexpected/already-patched function fails the exact-source preflight')
  await db.exec('rollback')
  assert.equal((await db.query("select pg_get_functiondef('xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)'::regprocedure) body")).rows[0].body,canonical)
})

test('group material migration rejects uninspected or ambiguous source and version-guard drift without writes',async t=>{
  const fx=await audienceFixture({materialSaveFix:false});t.after(()=>fx.close())
  const {db}=fx
  const signature='xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)'
  const source=(await db.query('select pg_get_functiondef(to_regprocedure($1)) body',[signature])).rows[0].body
  const guard=(await db.query("select pg_get_functiondef('xelay_guard_teacher_material_author()'::regprocedure) body")).rows[0].body
  const wrapper=(await db.query("select pg_get_functiondef('xelay_teaching_mutate(text,jsonb)'::regprocedure) body")).rows[0].body
  const old="update public.teaching_items set submission_mode=coalesce(p_payload->>'submission_mode',submission_mode) where id=v_record.id;\n    if v_kind='assignment' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;"
  const oneSpace=old.replace('\n    if','\n if')
  assert.equal(source.split(old).length-1,1)
  const migration=await read('202611030001_fix_group_material_save.sql')
  for(const [name,changed,changedGuard] of [
    ['unknown two-space indentation',source.replace(old,old.replace('\n    if','\n  if')),guard],
    ['duplicate inspected block',source.replace(old,old+'\n    '+oneSpace),guard],
    ['missing block',source.replace(old,'-- No submission-mode writer.'),guard],
    ['missing scope guard',source.replace('perform public.xelay_private_teaching_mutation_scope(p_action,p_payload);','null;'),guard],
    ['changed version guard',source,guard.replace('new.version<>old.version+1','new.version<>old.version+2')],
  ]) await t.test(name,async()=>{
    await db.exec('begin')
    await db.exec(changed)
    await db.exec(changedGuard)
    await assert.rejects(db.exec(migration),/GROUP_MATERIAL_SAVE_SOURCE_DRIFT/)
    await db.exec('rollback')
    assert.equal((await db.query('select pg_get_functiondef(to_regprocedure($1)) body',[signature])).rows[0].body,source)
    assert.equal((await db.query("select pg_get_functiondef('xelay_guard_teacher_material_author()'::regprocedure) body")).rows[0].body,guard)
    assert.equal((await db.query("select pg_get_functiondef('xelay_teaching_mutate(text,jsonb)'::regprocedure) body")).rows[0].body,wrapper)
  })
})
test('teaching audiences and announcements enforce real PostgreSQL recipient boundaries', async t => {
  const fx = await audienceFixture();t.after(() => fx.close())
  const { db,ids,groups,rpc,classroom,dates }=fx
  const audience = (user,action,payload) => rpc(user,'xelay_teaching_audience_mutate',[action,JSON.stringify(payload)])
  const subgroup = { id:randomUUID(),course_id:ids.course,group_id:groups[0],name:'Language A',user_ids:[ids.studentA],version:0 }
  await t.test('anonymous and students cannot manage roster or read staff audience tools',async()=>{
    await assert.rejects(audience(null,'save_subgroup',subgroup),/AUTH|FORBIDDEN/)
    await assert.rejects(audience(ids.studentA,'save_subgroup',subgroup),/FORBIDDEN|EXPIRED/)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_audience',[ids.course]),/FORBIDDEN/)
    for(const table of ['teaching_subgroups','teaching_lab_teams','teaching_announcements'])
      await assert.rejects(fx.asUser(ids.studentA,'select * from '+table),e=>e.code==='42501')
  })
  await t.test('only accepted members of same connected academic group can be assigned',async()=>{
    await assert.rejects(audience(ids.owner,'save_subgroup',{...subgroup,user_ids:[ids.studentB]}),/AUDIENCE_INVALID/)
    await audience(ids.owner,'save_subgroup',subgroup)
    await assert.rejects(audience(ids.owner,'save_subgroup',subgroup),/CONFLICT/)
    const context=await rpc(ids.owner,'xelay_teaching_audience',[ids.course]);assert.equal(context.subgroups.length,1)
    assert.ok(context.members.some(m=>m.user_id===ids.studentA&&m.group_id===groups[0]))
  })
  let announcement
  await t.test('selected subgroup alone receives publication and notification, edit and removal are versioned',async()=>{
    announcement={id:randomUUID(),course_id:ids.course,title:'Class today',body:'Synthetic notice',targets:[{group_id:groups[0],audience_mode:'subgroups',subgroup_ids:[subgroup.id],team_ids:[]}],version:0}
    const receipt=await audience(ids.owner,'save_announcement',announcement);assert.equal(receipt.version,1)
    assert.equal((await rpc(ids.studentA,'xelay_teaching_group_announcements',[groups[0]])).announcements.length,1)
    assert.equal((await rpc(ids.headA,'xelay_teaching_group_announcements',[groups[0]])).announcements.length,0)
    await assert.rejects(rpc(ids.studentB,'xelay_teaching_group_announcements',[groups[0]]),/FORBIDDEN/)
    const notices=(await db.query("select recipient_id,study_group_id from notifications where teaching_event_key like $1",['teaching-announcement:'+announcement.id+':%'])).rows
    assert.deepEqual(notices.map(n=>n.recipient_id),[ids.studentA])
    assert.equal(notices[0].study_group_id,groups[0],'student notification opens its authorized academic group')
    await audience(ids.owner,'save_announcement',{...announcement,version:1,body:'Changed'})
    await assert.rejects(audience(ids.owner,'delete_announcement',{id:announcement.id,version:1}),/CONFLICT/)
    await audience(ids.owner,'delete_announcement',{id:announcement.id,version:2})
    assert.equal((await rpc(ids.studentA,'xelay_teaching_group_announcements',[groups[0]])).announcements.length,0)
  })
  let assignment
  await t.test('canonical homework, source projection and classroom share audience enforcement',async()=>{
    assignment={id:randomUUID(),course_id:ids.course,version:0,title:'Synthetic lab',body:'Only subgroup A',links:[],attachments:[],status:'published',submission_mode:'team',max_points:10,category:'',targets:[{group_id:groups[0],audience_mode:'subgroups',subgroup_ids:[subgroup.id],team_ids:[],lesson_date:dates.lesson_a,placement_mode:'unplaced',due_at:null,closes_at:null}]}
    await classroom(ids.owner,'save_group_assignment',assignment)
    assert.equal((await rpc(ids.studentA,'xelay_classroom_assignment',[assignment.id,groups[0]])).item.submission_mode,'team')
    await assert.rejects(rpc(ids.headA,'xelay_classroom_assignment',[assignment.id,groups[0]]),/FORBIDDEN/)
    assert.equal((await rpc(ids.headA,'xelay_teaching_group',[groups[0]])).assignments.length,0)
    assert.equal((await rpc(ids.headA,'xelay_group_teacher_assignments',[groups[0],dates.lesson_a])).assignments.length,0)
    assert.equal((await rpc(ids.studentA,'xelay_group_teacher_assignments',[groups[0],dates.lesson_a])).assignments.length,1)
    await assert.rejects(classroom(ids.headA,'reserve_submission',{id:randomUUID(),item_id:assignment.id,group_id:groups[0],version:0}),/FORBIDDEN/)
  })
  await t.test('foreign subgroup and mismatched mode rollback the complete write',async()=>{
    const invalid={...assignment,id:randomUUID(),targets:[{...assignment.targets[0],group_id:groups[1]}]}
    await assert.rejects(classroom(ids.owner,'save_group_assignment',invalid),/AUDIENCE_INVALID/)
    assert.equal((await db.query('select count(*)n from teaching_items where id=$1',[invalid.id])).rows[0].n,0)
    await assert.rejects(audience(ids.owner,'save_announcement',{...announcement,id:randomUUID(),targets:[{group_id:groups[0],audience_mode:'all',subgroup_ids:[subgroup.id]}]}),/AUDIENCE_INVALID/)
    await assert.rejects(audience(ids.owner,'delete_subgroup',{id:subgroup.id,version:1}),/AUDIENCE_IN_USE/)
  })
  await t.test('material library metadata edits preserve selected audience and private source access',async()=>{
    const material={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Subgroup material',body:'Restricted material',links:[],attachments:[],status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:[groups[0],groups[1]],
      target_audiences:[{group_id:groups[0],audience_mode:'subgroups',subgroup_ids:[subgroup.id],team_ids:[]},{group_id:groups[1],audience_mode:'all',subgroup_ids:[],team_ids:[]}]}
    await fx.mutate(ids.owner,'save_library_material',material)
    let library=await rpc(ids.owner,'xelay_teaching_material_library',[])
    const current=library.materials.find(m=>m.id===material.id)
    assert.equal(current.targets.find(t=>t.group_id===groups[0]).audience_mode,'subgroups')
    assert.deepEqual(current.targets.find(t=>t.group_id===groups[0]).subgroup_ids,[subgroup.id])
    assert.equal((await rpc(ids.headA,'xelay_group_teacher_materials',[groups[0]])).materials.length,0)
    await fx.mutate(ids.owner,'save_library_material',{id:material.id,version:current.version,expected_user_id:ids.owner,title:'Updated title',rights_accepted:true,rights_terms_version:'2026-10-27.1'})
    library=await rpc(ids.owner,'xelay_teaching_material_library',[])
    assert.equal(library.materials.find(m=>m.id===material.id).targets.find(t=>t.group_id===groups[0]).audience_mode,'subgroups')
    assert.equal((await rpc(ids.headA,'xelay_teaching_group',[groups[0]])).materials.length,0)
    assert.equal((await rpc(ids.studentA,'xelay_group_teacher_materials',[groups[0]])).materials.length,1)
    assert.equal((await rpc(ids.studentB,'xelay_group_teacher_materials',[groups[1]])).materials.length,1)
  })
  await t.test('a colleague for one group cannot bypass a different subgroup by also being its student',async()=>{
    const invitation=await fx.mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['assignments','materials','grades'],group_scope:'selected',group_ids:[groups[0]]})
    await fx.mutate(ids.colleague,'respond_teacher',{teacher_link_id:invitation.id,accept:true})
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())",[groups[1],ids.colleague,ids.headB])
    const groupB={...subgroup,id:randomUUID(),group_id:groups[1],user_ids:[ids.studentB]}
    await audience(ids.owner,'save_subgroup',groupB)
    const itemB={...assignment,id:randomUUID(),targets:[{...assignment.targets[0],group_id:groups[1],subgroup_ids:[groupB.id]}]}
    await classroom(ids.owner,'save_group_assignment',itemB)
    const canRead=(await db.query('select xelay_teaching_can_read_item($1,$2) allowed',[itemB.id,ids.colleague])).rows[0].allowed
    assert.equal(canRead,false)
    await assert.rejects(rpc(ids.colleague,'xelay_classroom_assignment',[itemB.id,groups[1]]),/FORBIDDEN/)
    assert.ok(!(await rpc(ids.colleague,'xelay_teaching_course',[ids.course])).assignments.some(i=>i.id===itemB.id))
    assert.ok(!(await rpc(ids.colleague,'xelay_teaching_audience',[ids.course])).subgroups.some(s=>s.id===groupB.id))
  })
  const team={id:randomUUID(),item_id:null,course_id:ids.course,group_id:groups[0],name:'Lab one',user_ids:[ids.studentA,ids.headA],version:0}
  const teamTwo={...team,id:randomUUID(),name:'Lab two',user_ids:[ids.outsider]}
  await t.test('lab teams are independent assignment rosters, reject overlap and expose only own team',async()=>{
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())",[groups[0],ids.outsider,ids.headA])
    await audience(ids.owner,'save_subgroup',{...subgroup,version:1,user_ids:[ids.studentA,ids.headA,ids.outsider]})
    team.item_id=assignment.id;teamTwo.item_id=assignment.id
    await audience(ids.owner,'save_lab_team',team)
    await audience(ids.owner,'save_lab_team',teamTwo)
    await assert.rejects(audience(ids.owner,'save_lab_team',{...team,id:randomUUID()}),/DUPLICATE_STUDENT/)
    await assert.rejects(audience(ids.owner,'save_lab_team',{...team,id:randomUUID(),group_id:groups[1]}),/AUDIENCE_INVALID/)
    const data=await rpc(ids.studentA,'xelay_classroom_assignment',[assignment.id,groups[0]])
    assert.equal(data.my_team.id,team.id);assert.equal(data.my_team.members.length,2)
    assert.ok(data.my_team.members.every(m=>!('published_score'in m)&&!('grade_version'in m)))
  })
  let submission
  await t.test('members reserve one canonical team work, version conflicts cannot overwrite teammate draft',async()=>{
    const first=await classroom(ids.studentA,'reserve_submission',{id:randomUUID(),version:0,item_id:assignment.id,group_id:groups[0]})
    const second=await classroom(ids.headA,'reserve_submission',{id:randomUUID(),version:0,item_id:assignment.id,group_id:groups[0]})
    assert.equal(first.id,second.id)
    assert.equal((await db.query('select count(*)n from teaching_submissions where team_id=$1',[team.id])).rows[0].n,1)
    const saved=await classroom(ids.headA,'save_submission',{id:second.id,version:second.version,item_id:assignment.id,group_id:groups[0],body:'Joint synthetic report',links:[],attachments:[]})
    await assert.rejects(classroom(ids.studentA,'save_submission',{id:first.id,version:first.version,item_id:assignment.id,group_id:groups[0],body:'Stale overwrite',links:[],attachments:[]}),/CONFLICT/)
    const current=await rpc(ids.studentA,'xelay_classroom_assignment',[assignment.id,groups[0]])
    assert.equal(current.my_submission.body,'Joint synthetic report')
    submission=await classroom(ids.studentA,'submit_submission',{id:saved.id,version:saved.version})
    assert.equal((await rpc(ids.headA,'xelay_classroom_assignment',[assignment.id,groups[0]])).my_submission.id,submission.id)
    const other=await rpc(ids.outsider,'xelay_classroom_assignment',[assignment.id,groups[0]])
    assert.equal(other.my_submission,null);assert.equal(other.history.length,0)
    await assert.rejects(classroom(ids.outsider,'withdraw_submission',{id:submission.id,version:submission.version}),/FORBIDDEN/)
    await assert.rejects(audience(ids.owner,'save_lab_team',{...team,version:1,user_ids:[ids.studentA]}),/HAS_SUBMISSIONS/)
    const before=await fx.item(assignment.id)
    await assert.rejects(classroom(ids.owner,'save_group_assignment',{...assignment,version:before.version,submission_mode:'individual'}),/HAS_SUBMISSIONS/)
    assert.deepEqual(await fx.item(assignment.id),before,'failed mode change leaves work and item untouched')
  })
  let gradePayload
  await t.test('grading team is explicit and atomic; one stale member prevents any grade changes',async()=>{
    const data=await rpc(ids.owner,'xelay_classroom_assignment',[assignment.id,groups[0]])
    const work=data.submissions.find(s=>s.id===submission.id)
    assert.equal(work.team_members.length,2)
    assert.ok(work.team_members.every(m=>m.entry_id&&m.grade_version===0))
    await assert.rejects(classroom(ids.owner,'review_submission',{id:submission.id,version:submission.version,status:'reviewed',feedback:'Review',score:8,grade_version:0}),/EXPLICIT_GRADES_REQUIRED/)
    gradePayload={id:submission.id,version:submission.version,score:8,feedback:'Joint feedback',publish:true,confirm_team:true,expected_user_id:ids.owner,grade_versions:Object.fromEntries(work.team_members.map(m=>[m.entry_id,m.grade_version]))}
    await assert.rejects(classroom(ids.owner,'grade_team_submission',{...gradePayload,confirm_team:false}),/INVALID_INPUT/)
    await assert.rejects(classroom(ids.studentA,'grade_team_submission',{...gradePayload,expected_user_id:ids.studentA}),/FORBIDDEN|EXPIRED/)
    await assert.rejects(classroom(ids.owner,'grade_team_submission',{...gradePayload,expected_user_id:ids.colleague}),/ACTOR_CHANGED/)
    const stale={...gradePayload,grade_versions:{...gradePayload.grade_versions,[work.team_members[1].entry_id]:55}}
    await assert.rejects(classroom(ids.owner,'grade_team_submission',stale),/CONFLICT/)
    assert.equal((await db.query('select count(*)n from teaching_grades')).rows[0].n,0)
    const result=await classroom(ids.owner,'grade_team_submission',gradePayload)
    assert.equal(result.version,submission.version+1)
    assert.deepEqual(await classroom(ids.owner,'grade_team_submission',gradePayload),result,'idempotent retry')
    assert.equal((await db.query('select count(*)n from teaching_grades where published_score=8')).rows[0].n,2)
    assert.equal((await rpc(ids.outsider,'xelay_teaching_group',[groups[0]])).grades.length,0)
  })
  await t.test('different individual grades never leak across shared team or feedback history',async()=>{
    const activity=(await db.query('select id from teaching_activities where item_id=$1',[assignment.id])).rows[0].id
    const entry=(await db.query('select id from teaching_entries where course_id=$1 and user_id=$2',[ids.course,ids.studentA])).rows[0].id
    const version=(await db.query('select version from teaching_grades where activity_id=$1 and entry_id=$2',[activity,entry])).rows[0].version
    const saved=await fx.mutate(ids.owner,'save_grade',{activity_id:activity,entry_id:entry,version,score:9,comment:'Personal grade',reason:'Individual contribution'})
    await fx.mutate(ids.owner,'publish_grades',{activity_id:activity,expected_versions:[{entry_id:entry,version:saved.version}]})
    const first=await rpc(ids.studentA,'xelay_classroom_assignment',[assignment.id,groups[0]])
    const second=await rpc(ids.headA,'xelay_classroom_assignment',[assignment.id,groups[0]])
    assert.equal(first.my_submission.published_score,9);assert.equal(second.my_submission.published_score,8)
    assert.ok(second.my_submission.team_members.every(m=>!('published_score'in m)&&!('entry_id'in m)))
    assert.ok(second.history.every(h=>h.score==null&&h.published_score==null))
  })
  await t.test('verified team files support teammate reuse, current membership and private bytes',async()=>{
    let data=await rpc(ids.owner,'xelay_classroom_assignment',[assignment.id,groups[0]])
    const work=data.submissions.find(s=>s.id===submission.id)
    const returned=await classroom(ids.owner,'review_submission',{id:work.id,version:work.version,status:'returned',feedback:'Attach team report'})
    const bytes=Buffer.from('Synthetic shared report. No scripts or executable content.\n')
    const path=`${work.id}/${ids.headA}/${randomUUID()}.txt`
    await fx.asUser(ids.headA,'insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values($1,$2,$3::uuid,$3::text,$4::jsonb)',[
      'xelay-submission-files',path,ids.headA,JSON.stringify({size:bytes.length,mimetype:'text/plain'})])
    const descriptor={storage_path:path,name:'Synthetic.txt',mime_type:'text/plain',size:bytes.length}
    const payload={id:work.id,version:returned.version,body:'Shared text and file',links:[],attachments:[descriptor]}
    await assert.rejects(classroom(ids.headA,'save_submission',payload),/NOT_VERIFIED|NOT_READY|UPLOAD/)
    const verified=await verifyStoredBytes({db,asUser:fx.asUser,actor:ids.headA,bucket:'xelay-submission-files',path,bytes})
    assert.equal(verified.statusCode,200,JSON.stringify(verified.body))
    const saved=await classroom(ids.headA,'save_submission',payload)
    const reused=await classroom(ids.studentA,'save_submission',{...payload,version:saved.version,body:'Updated by teammate'})
    assert.equal(reused.version,saved.version+1)
    const canRead=who=>fx.asUser(who,'select xelay_classroom_can_read_file($1) allowed',[path]).then(r=>r.rows[0].allowed)
    assert.equal(await canRead(ids.studentA),true);assert.equal(await canRead(ids.outsider),false)
    assert.equal(await canRead(ids.owner),false,'teacher cannot read a newly uploaded returned-work draft')
    data=await rpc(ids.owner,'xelay_classroom_assignment',[assignment.id,groups[0]])
    assert.equal(data.submissions.find(s=>s.id===work.id).body,'Joint synthetic report')
    assert.equal(data.submissions.find(s=>s.id===work.id).attachments.length,0)
    assert.equal((await fx.asUser(ids.outsider,'select id from storage.objects where bucket_id=$1 and name=$2',['xelay-submission-files',path])).rows.length,0)
    await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groups[0],ids.studentA])
    assert.equal(await canRead(ids.studentA),false)
    assert.equal((await fx.asUser(ids.studentA,'select id from storage.objects where bucket_id=$1 and name=$2',['xelay-submission-files',path])).rows.length,0)
    await assert.rejects(classroom(ids.studentA,'save_submission',{...payload,version:reused.version}),/FORBIDDEN/)
    await db.query("update study_group_members set status='accepted' where group_id=$1 and user_id=$2",[groups[0],ids.studentA])
    await assert.rejects(classroom(ids.studentA,'save_submission',{...payload,version:reused.version,attachments:[{...descriptor,name:'Changed descriptor'}]}),/IMMUTABLE|INVALID|MISMATCH/)
  })
  await t.test('material recipients can use a specific laboratory team without exposing it to the other team',async()=>{
    const material={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Team reference',body:'Team one only',links:[],attachments:[],status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:[groups[0]],
      target_audiences:[{group_id:groups[0],audience_mode:'teams',subgroup_ids:[],team_ids:[team.id]}]}
    await fx.mutate(ids.owner,'save_library_material',material)
    assert.ok((await rpc(ids.studentA,'xelay_group_teacher_materials',[groups[0]])).materials.some(m=>m.id===material.id))
    assert.ok(!(await rpc(ids.outsider,'xelay_group_teacher_materials',[groups[0]])).materials.some(m=>m.id===material.id))
  })
  await t.test('editing one target of a shared assignment keeps team work, history and the other group intact',async()=>{
    const shared={...assignment,id:randomUUID(),targets:groups.map((group,index)=>({group_id:group,audience_mode:'all',subgroup_ids:[],team_ids:[],lesson_date:index?dates.lesson_b:dates.lesson_a,placement_mode:'unplaced',due_at:null,closes_at:null})),expected_user_id:ids.owner}
    await rpc(ids.owner,'xelay_teaching_save_multi_assignment',[JSON.stringify(shared)])
    const sharedTeam={...team,id:randomUUID(),item_id:shared.id}
    await audience(ids.owner,'save_lab_team',sharedTeam)
    const reserved=await classroom(ids.studentA,'reserve_submission',{id:randomUUID(),version:0,item_id:shared.id,group_id:groups[0]})
    const saved=await classroom(ids.studentA,'save_submission',{id:reserved.id,version:reserved.version,body:'Keep this team work',links:[],attachments:[]})
    const submitted=await classroom(ids.studentA,'submit_submission',{id:saved.id,version:saved.version})
    const copy={...shared,id:randomUUID(),source_item_id:shared.id,source_version:1,targets:[{...shared.targets[0],audience_mode:'teams',team_ids:[sharedTeam.id]}],body:'Changed for group one'}
    await classroom(ids.owner,'save_group_assignment',copy)
    const changed=await rpc(ids.headA,'xelay_classroom_assignment',[copy.id,groups[0]])
    assert.equal(changed.my_submission.id,submitted.id);assert.equal(changed.my_submission.body,'Keep this team work')
    assert.equal(changed.my_team.id,sharedTeam.id);assert.equal(changed.history.length,1)
    const other=await rpc(ids.studentB,'xelay_classroom_assignment',[shared.id,groups[1]])
    assert.equal(other.item.body,shared.body)
    assert.equal((await fx.item(copy.id)).submission_mode,'team')
  })
  await t.test('assignment-only scoped colleague may manage subgroups but cannot grade or inspect another group',async()=>{
    const link=(await db.query('select id from teaching_course_teachers where course_id=$1 and user_id=$2',[ids.course,ids.colleague])).rows[0].id
    await fx.mutate(ids.owner,'update_teacher',{teacher_link_id:link,permissions:['assignments'],group_scope:'selected',group_ids:[groups[0]]})
    await audience(ids.colleague,'save_subgroup',{...subgroup,id:randomUUID(),name:'Colleague subgroup'})
    await assert.rejects(audience(ids.colleague,'save_subgroup',{...subgroup,id:randomUUID(),group_id:groups[1],user_ids:[ids.studentB]}),/FORBIDDEN/)
    const context=await rpc(ids.colleague,'xelay_teaching_audience',[ids.course]);assert.ok(context.members.some(m=>m.user_id===ids.studentA))
    await assert.rejects(classroom(ids.colleague,'grade_team_submission',{...gradePayload,expected_user_id:ids.colleague}),/FORBIDDEN/)
    await assert.rejects(audience(ids.colleague,'delete_announcement',{id:announcement.id,version:3}),/FORBIDDEN|CONFLICT/)
  })
  await t.test('legacy whole-group individual submissions still save, submit and receive an individual grade',async()=>{
    const ordinary={...assignment,id:randomUUID(),submission_mode:'individual',targets:[{group_id:groups[1],lesson_date:dates.lesson_b,placement_mode:'unplaced',due_at:null,closes_at:null}]}
    await classroom(ids.owner,'save_group_assignment',ordinary)
    const reserved=await classroom(ids.studentB,'reserve_submission',{id:randomUUID(),version:0,item_id:ordinary.id,group_id:groups[1]})
    const saved=await classroom(ids.studentB,'save_submission',{id:reserved.id,version:reserved.version,body:'Ordinary individual work',links:[],attachments:[]})
    const submitted=await classroom(ids.studentB,'submit_submission',{id:saved.id,version:saved.version})
    await classroom(ids.owner,'review_submission',{id:submitted.id,version:submitted.version,status:'reviewed',feedback:'Individual feedback',score:7,grade_version:0})
    const data=await rpc(ids.studentB,'xelay_classroom_assignment',[ordinary.id,groups[1]])
    assert.equal(data.my_submission.team_id,null);assert.equal(data.my_submission.body,'Ordinary individual work')
    assert.equal(data.my_submission.published_score,7);assert.equal(data.my_team,null)
  })
  await t.test('narrowing recipients closes team access and removes nonrecipients from grade preview',async()=>{
    const before=(await db.query('select version,user_ids from teaching_subgroups where id=$1',[subgroup.id])).rows[0]
    await audience(ids.owner,'save_subgroup',{...subgroup,version:before.version,user_ids:[ids.studentA,ids.outsider]})
    const data=await rpc(ids.owner,'xelay_classroom_assignment',[assignment.id,groups[0]])
    const work=data.submissions.find(s=>s.id===submission.id)
    assert.deepEqual(work.team_members.map(m=>m.user_id),[ids.studentA])
    await assert.rejects(rpc(ids.headA,'xelay_classroom_assignment',[assignment.id,groups[0]]),/FORBIDDEN/)
    await audience(ids.owner,'save_subgroup',{...subgroup,version:before.version+1,user_ids:before.user_ids})
  })
  await t.test('materials-only colleague may select lab-team recipients with delegated material rights but cannot manage teams or grade',async()=>{
    const link=(await db.query('select id from teaching_course_teachers where course_id=$1 and user_id=$2',[ids.course,ids.colleague])).rows[0].id
    await fx.mutate(ids.owner,'update_teacher',{teacher_link_id:link,permissions:['materials'],group_scope:'selected',group_ids:[groups[0]]})
    const context=await rpc(ids.colleague,'xelay_teaching_audience',[ids.course])
    assert.ok(context.teams.some(t=>t.id===team.id))
    assert.ok(context.teams.every(t=>t.group_id===groups[0]&&!('published_score'in t)&&!('grade_version'in t)))
    const material={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Delegated team resource',body:'Synthetic resource',links:[],attachments:[],status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:[groups[0]]}
    await fx.mutate(ids.owner,'save_library_material',material)
    const delegated=await fx.mutate(ids.owner,'set_material_collaborators',{id:material.id,version:1,expected_user_id:ids.owner,
      grants:[{user_id:ids.colleague,can_edit:false,can_delete:false,can_manage_groups:true}]})
    await fx.mutate(ids.colleague,'save_library_material',{id:material.id,version:delegated.version,expected_user_id:ids.colleague,
      target_group_ids:[groups[0]],target_audiences:[{group_id:groups[0],audience_mode:'teams',subgroup_ids:[],team_ids:[team.id]}]})
    assert.ok((await rpc(ids.studentA,'xelay_group_teacher_materials',[groups[0]])).materials.some(m=>m.id===material.id))
    assert.ok(!(await rpc(ids.outsider,'xelay_group_teacher_materials',[groups[0]])).materials.some(m=>m.id===material.id))
    const version=(await db.query('select version from teaching_lab_teams where id=$1',[team.id])).rows[0].version
    await assert.rejects(audience(ids.colleague,'save_lab_team',{...team,version,name:'Unauthorized rename'}),/FORBIDDEN/)
    await assert.rejects(classroom(ids.colleague,'grade_team_submission',{...gradePayload,expected_user_id:ids.colleague}),/FORBIDDEN/)
  })
  const restrictedSubgroup={...subgroup,id:randomUUID(),name:'Release compatibility subgroup',user_ids:[ids.studentA]}
  const legacyTarget={group_id:groups[0],lesson_date:dates.lesson_a,placement_mode:'unplaced',due_at:null,closes_at:null}
  const restrictedTarget={...legacyTarget,audience_mode:'subgroups',subgroup_ids:[restrictedSubgroup.id],team_ids:[]}
  const legacyAssignment={...assignment,id:randomUUID(),submission_mode:'individual',targets:[restrictedTarget]}
  await t.test('an old editor with a fresh version cannot widen scoped homework; explicit whole-group consent and old whole-group editors still work',async()=>{
    await audience(ids.owner,'save_subgroup',restrictedSubgroup)
    await classroom(ids.owner,'save_group_assignment',legacyAssignment)
    const before=await fx.item(legacyAssignment.id)
    const oldPayload={...legacyAssignment,version:before.version,title:'Legacy metadata edit',targets:[legacyTarget]}
    await assert.rejects(classroom(ids.owner,'save_group_assignment',oldPayload),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
    await assert.rejects(fx.mutate(ids.owner,'save_assignment',oldPayload),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
    assert.deepEqual(await fx.item(legacyAssignment.id),before)
    assert.equal((await db.query('select audience_mode from teaching_item_targets where item_id=$1',[legacyAssignment.id])).rows[0].audience_mode,'subgroups')
    await assert.rejects(rpc(ids.headA,'xelay_classroom_assignment',[legacyAssignment.id,groups[0]]),/FORBIDDEN/)
    await classroom(ids.owner,'save_group_assignment',{...oldPayload,targets:[{...legacyTarget,audience_mode:'all',subgroup_ids:[],team_ids:[]}]})
    assert.ok((await rpc(ids.headA,'xelay_classroom_assignment',[legacyAssignment.id,groups[0]])).item)
    const current=await fx.item(legacyAssignment.id)
    await classroom(ids.owner,'save_group_assignment',{...oldPayload,version:current.version,title:'Legacy whole-group metadata edit'})
    assert.equal((await fx.item(legacyAssignment.id)).title,'Legacy whole-group metadata edit')
  })
  await t.test('old shared-item forks fail before moving work or replacing targets; new multi-group creation remains compatible',async()=>{
    const shared={...legacyAssignment,id:randomUUID(),targets:[restrictedTarget,{...legacyTarget,group_id:groups[1],lesson_date:dates.lesson_b,audience_mode:'all',subgroup_ids:[],team_ids:[]}],expected_user_id:ids.owner}
    await rpc(ids.owner,'xelay_teaching_save_multi_assignment',[JSON.stringify(shared)])
    const before=await fx.item(shared.id)
    const fork={...shared,id:randomUUID(),source_item_id:shared.id,source_version:before.version,targets:[legacyTarget]}
    await assert.rejects(classroom(ids.owner,'save_group_assignment',fork),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
    assert.equal(await fx.item(fork.id),undefined)
    assert.deepEqual(await fx.item(shared.id),before)
    assert.equal((await db.query('select count(*)n from teaching_item_targets where item_id=$1',[shared.id])).rows[0].n,2)
    await classroom(ids.owner,'save_group_assignment',{...fork,targets:[restrictedTarget]})
    await assert.rejects(rpc(ids.headA,'xelay_classroom_assignment',[fork.id,groups[0]]),/FORBIDDEN/)
    const ordinary={...shared,id:randomUUID(),targets:[legacyTarget,{...legacyTarget,group_id:groups[1],lesson_date:dates.lesson_b}]}
    await rpc(ids.owner,'xelay_teaching_save_multi_assignment',[JSON.stringify(ordinary)])
    assert.ok((await db.query('select audience_mode from teaching_item_targets where item_id=$1',[ordinary.id])).rows.every(t=>t.audience_mode==='all'))
  })
  await t.test('old canonical material saves cannot widen scope and library group-only updates preserve existing restrictions',async()=>{
    const material={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Compatibility material',body:'Subgroup only',links:[],attachments:[],status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:[groups[0]],target_audiences:[restrictedTarget]}
    await fx.mutate(ids.owner,'save_library_material',material)
    const before=await fx.item(material.id)
    await assert.rejects(fx.mutate(ids.owner,'save_material',{...material,version:before.version,targets:[legacyTarget]}),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
    assert.deepEqual(await fx.item(material.id),before)
    const preserved=await fx.mutate(ids.owner,'save_library_material',{id:material.id,version:before.version,expected_user_id:ids.owner,target_group_ids:[groups[0]]})
    assert.equal((await db.query('select audience_mode from teaching_item_targets where item_id=$1',[material.id])).rows[0].audience_mode,'subgroups')
    const after=await fx.item(material.id)
    await assert.rejects(fx.mutate(ids.owner,'save_library_material',{id:material.id,version:preserved.version,expected_user_id:ids.owner,target_group_ids:[groups[0]],target_audiences:[{group_id:groups[0]}]}),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
    assert.deepEqual(await fx.item(material.id),after,'failed library audience omission rolls back metadata and version too')
    assert.ok(!(await rpc(ids.headA,'xelay_group_teacher_materials',[groups[0]])).materials.some(m=>m.id===material.id))
    await fx.mutate(ids.owner,'save_library_material',{id:material.id,version:preserved.version,expected_user_id:ids.owner,target_group_ids:[groups[0]],target_audiences:[{group_id:groups[0],audience_mode:'all',subgroup_ids:[],team_ids:[]}]})
    assert.ok((await rpc(ids.headA,'xelay_group_teacher_materials',[groups[0]])).materials.some(m=>m.id===material.id))
  })
  await t.test('scheduled publication retains stored scope and excludes other students even after a rejected legacy edit',async()=>{
    const scheduled=randomUUID()
    await db.query(`insert into teaching_items(id,course_id,kind,title,body,status,publish_at,scheduled_by,created_by)
      values($1,$2,'assignment','Scheduled subgroup work','Synthetic scheduled body','scheduled',now()+interval '10 minutes',$3,$3)`,[scheduled,ids.course,ids.owner])
    await db.query(`insert into teaching_item_targets(item_id,group_id,lesson_date,placement_mode,audience_mode,subgroup_ids)
      values($1,$2,$3,'unplaced','subgroups',$4::uuid[])`,[scheduled,groups[0],dates.lesson_a,[restrictedSubgroup.id]])
    const before=await fx.item(scheduled)
    await assert.rejects(classroom(ids.owner,'save_group_assignment',{...legacyAssignment,id:scheduled,version:before.version,status:'scheduled',publish_at:before.publish_at,targets:[legacyTarget]}),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
    assert.deepEqual(await fx.item(scheduled),before)
    await db.query("update teaching_items set publish_at=now()-interval '1 second' where id=$1",[scheduled])
    assert.equal((await db.query('select xelay_publish_due_teaching_items() n')).rows[0].n,1)
    assert.equal((await fx.item(scheduled)).status,'published')
    const recipients=(await db.query("select recipient_id from notifications where teaching_event_key like $1",['teaching-item:'+scheduled+':%'])).rows.map(n=>n.recipient_id)
    assert.deepEqual(recipients,[ids.studentA])
    assert.ok((await rpc(ids.studentA,'xelay_group_teacher_assignments',[groups[0],dates.lesson_a])).assignments.some(i=>i.id===scheduled))
    assert.ok(!(await rpc(ids.headA,'xelay_group_teacher_assignments',[groups[0],dates.lesson_a])).assignments.some(i=>i.id===scheduled))
  })
})

test('audience migration preserves exact guards with known one-space source formatting and CRLF SQL input',async t=>{
  const fx=await audienceFixture({formatVariant:true});t.after(()=>fx.close())
  const { ids,groups,dates,rpc,classroom,db }=fx
  const subgroup={id:randomUUID(),course_id:ids.course,group_id:groups[0],name:'Formatting fixture subgroup',user_ids:[ids.studentA],version:0}
  await rpc(ids.owner,'xelay_teaching_audience_mutate',['save_subgroup',JSON.stringify(subgroup)])
  const target={group_id:groups[0],lesson_date:dates.lesson_a,placement_mode:'unplaced',due_at:null,closes_at:null}
  const assignment={id:randomUUID(),course_id:ids.course,title:'Formatting fixture assignment',body:'Synthetic fixture body',links:[],attachments:[],status:'published',version:0,targets:[{...target,audience_mode:'subgroups',subgroup_ids:[subgroup.id],team_ids:[]}]}
  await classroom(ids.owner,'save_group_assignment',assignment)
  await assert.rejects(classroom(ids.owner,'save_group_assignment',{...assignment,version:1,targets:[target]}),/TEACHING_AUDIENCE_REFRESH_REQUIRED/)
  const body=(await db.query("select pg_get_functiondef('xelay_publish_due_teaching_items()'::regprocedure) body")).rows[0].body
  assert.ok(body.includes('public.xelay_private_teaching_target_allows(v_item.id,t.group_id,p.id)'))
  assert.ok(body.includes("and(v_item.kind<>'material' or v_item.access_until is null or v_item.access_until>clock_timestamp())"),'existing live material-expiry check is retained')
  assert.equal((await db.query('select audience_mode from teaching_item_targets where item_id=$1',[assignment.id])).rows[0].audience_mode,'subgroups')
})

test('editing a common deadline sends one urgent notice to the current changed target audience',async t=>{
  const fx=await audienceFixture({formatVariant:true});t.after(()=>fx.close())
  const {db,ids,groups,dates,rpc,mutate,classroom,asUser}=fx
  await db.exec(await read('202611030104_academic_notification_priority.sql'))
  await db.exec((await read('202611030106_teaching_common_deadline_notifications.sql')).replace(/\r?\n/g,'\r\n'))

  const subgroup={id:randomUUID(),course_id:ids.course,group_id:groups[0],name:'Deadline subgroup',user_ids:[ids.studentA],version:0}
  await rpc(ids.owner,'xelay_teaching_audience_mutate',['save_subgroup',JSON.stringify(subgroup)])
  const targetA={group_id:groups[0],due_at:dates.lesson_a+'T12:00:00Z',lesson_date:dates.lesson_a,placement_mode:'unplaced',
    audience_mode:'subgroups',subgroup_ids:[subgroup.id],team_ids:[]}
  const targetB={...targetA,group_id:groups[1],due_at:dates.lesson_b+'T12:00:00Z',lesson_date:dates.lesson_b,
    audience_mode:'all',subgroup_ids:[]}
  const assignment={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic deadline assignment',
    body:'Synthetic assignment body',links:[],attachments:[],status:'published',targets:[targetA,targetB]}
  const notices=async (itemId,version)=>(await db.query(`
    select n.recipient_id,n.study_group_id,n.delivery_priority,n.id,n.teaching_event_key,q.id as job_id,q.delivery_priority as email_priority
    from public.notifications n left join public.notification_email_outbox q on q.notification_id=n.id::text
    where n.teaching_event_key in ($1,$2) order by n.recipient_id`,[
    'teaching-item:'+itemId+':'+version,'teaching-deadline:'+itemId+':'+version,
  ])).rows
  const save=(payload)=>mutate(ids.owner,'save_assignment',payload)
  const created=await rpc(ids.owner,'xelay_teaching_save_multi_assignment',[JSON.stringify(assignment)])
  const published=await notices(created.id,created.version)
  assert.deepEqual(new Set(published.map(n=>n.recipient_id)),new Set([ids.studentA,ids.studentB,ids.headB]))
  assert.ok(published.every(n=>n.delivery_priority==='normal'))

  const changedA={...targetA,due_at:dates.lesson_a+'T13:00:00Z'}
  const edit={...assignment,version:created.version,targets:[changedA,targetB]}
  const changed=await save(edit)
  const urgent=await notices(changed.id,changed.version)
  assert.equal(urgent.length,1,'one event, with no generic duplicate or notification for the unaffected group')
  assert.equal(urgent[0].recipient_id,ids.studentA)
  assert.equal(urgent[0].study_group_id,groups[0])
  assert.equal(urgent[0].delivery_priority,'urgent')
  assert.equal(urgent[0].email_priority,'urgent')
  await assert.rejects(save(edit),/CONFLICT/)
  assert.deepEqual(await notices(changed.id,changed.version),urgent)

  const service=(sql,params)=>asUser(null,sql,params,{role:'service_role'})
  await db.exec("update public.notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp()")
  const claim=async job=>(await service('select * from public.xelay_claim_notification_email($1)',[job])).rows[0]
  const contextSql='select public.xelay_teaching_deadline_change_email_context($1,$2) as context'
  const context=async lease=>(await service(contextSql,[lease.id,lease.lock_token])).rows[0].context
  const lease=await claim(urgent[0].job_id)
  assert.equal((await context(lease)).due_at,dates.lesson_a+'T13:00:00+00:00')
  assert.equal((await context(lease)).source_id,assignment.id)
  assert.equal((await context(lease)).lesson_date,dates.lesson_a)
  assert.equal((await context({...lease,lock_token:randomUUID()})).eligible,false)
  await assert.rejects(asUser(ids.studentA,contextSql,[lease.id,lease.lock_token]),{code:'42501'})

  const removed=await save({...edit,version:changed.version,targets:[{...changedA,due_at:null},targetB]})
  assert.equal((await context(lease)).reason,'teaching_deadline_change_unavailable')
  const removal=await notices(removed.id,removed.version)
  assert.equal(removal.length,1)
  const removalLease=await claim(removal[0].job_id)
  assert.equal((await context(removalLease)).due_at,null)

  const fork={...assignment,id:randomUUID(),source_item_id:assignment.id,source_version:removed.version,
    targets:[{...changedA,due_at:dates.lesson_a+'T14:00:00Z'}]}
  const forked=await classroom(ids.owner,'save_group_assignment',fork)
  const forkNotices=await notices(forked.id,forked.version)
  assert.deepEqual(forkNotices.map(n=>[n.recipient_id,n.study_group_id,n.delivery_priority]),
    [[ids.studentA,groups[0],'urgent']])
  const forkLease=await claim(forkNotices[0].job_id)
  assert.equal((await context(forkLease)).eligible,true)
  await rpc(ids.owner,'xelay_teaching_audience_mutate',['save_subgroup',JSON.stringify({...subgroup,version:1,user_ids:[ids.headA]})])
  assert.equal((await context(forkLease)).eligible,false,'audience changes also suppress undelivered mail')

  const draft=await save({...assignment,id:randomUUID(),status:'draft',targets:[targetB]})
  const firstPublication=await save({...assignment,id:draft.id,version:draft.version,
    targets:[{...targetB,due_at:dates.lesson_b+'T15:00:00Z'}]})
  const initial=await notices(firstPublication.id,firstPublication.version)
  assert.equal(initial.length,2)
  assert.ok(initial.every(n=>n.delivery_priority==='normal'))
})
