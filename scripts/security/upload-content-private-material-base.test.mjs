// Real current teaching fixture and material-library ACLs, synthetic accounts.
// Parent runs this serially; no cloud or byte download is performed here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../../',import.meta.url))
// All SQL is executed only by the isolated in-memory fixture below.
const {createTeachingScopedFixture}=await import(pathToFileURL(path.join(root,'scripts/security/teaching-scoped-fixture.mjs')))
const migration=name=>readFile(path.join(root,'supabase/migrations',name),'utf8')

test('real restricted-material broker preserves author/audience rights and refuses bytes after receipt invalidation',async t=>{
  const fx=await createTeachingScopedFixture();t.after(()=>fx.close())
  const {db,ids,groups,rpc,mutate,asUser}=fx
  for(const name of ['202610270001_teaching_group_scopes.sql','202610270002_teaching_multi_group_assignments.sql','202610270003_teaching_material_library.sql','202610270004_teaching_material_library_access.sql','202610270010_student_group_presentations.sql'])await db.exec(await migration(name))
  const item=randomUUID(),file={storage_path:ids.course+'/'+ids.owner+'/'+randomUUID()+'.pdf',name:'Synthetic.pdf',mime_type:'application/pdf',size:20}
  await db.query("insert into storage.objects(bucket_id,name,owner,owner_id,metadata)values('xelay-teaching-files',$1,$2,$3,$4::jsonb)",[file.storage_path,ids.owner,ids.owner,JSON.stringify({size:20,mimetype:'application/pdf'})])
  await mutate(ids.owner,'save_library_material',{expected_user_id:ids.owner,course_id:ids.course,id:item,version:0,title:'Synthetic protected lecture',body:'Fictional local fixture',links:[],link_labels:{},attachments:[file],target_group_ids:[groups[0]],status:'published',publish_at:null,access_until:null,allow_download:false,rights_accepted:true,rights_terms_version:'2026-10-27.1'})
  await db.exec(await migration('202610300003_upload_content_quarantine.sql'))
  const info=who=>rpc(who,'xelay_teaching_material_file_access',[item,file.storage_path])
  assert.equal((await info(ids.owner)).download_allowed,true)
  assert.equal((await info(ids.studentA)).download_allowed,false)
  await assert.rejects(info(ids.studentB),/FORBIDDEN/)
  await assert.rejects(info(ids.outsider),/FORBIDDEN/)
  await assert.rejects(rpc(ids.owner,'xelay_teaching_material_file_access_before_content_20261030',[item,file.storage_path]),/permission denied/)
  const acl=(await db.query("select has_function_privilege('authenticated','public.xelay_teaching_material_file_access_before_content_20261030(uuid,text)','EXECUTE') ordinary,has_function_privilege('service_role','public.xelay_teaching_material_file_access_before_content_20261030(uuid,text)','EXECUTE') service")).rows[0]
  assert.deepEqual(acl,{ordinary:false,service:false})
  await db.query('update storage.objects set updated_at=clock_timestamp() where bucket_id=$1 and name=$2',['xelay-teaching-files',file.storage_path])
  await assert.rejects(info(ids.studentA),/UPLOAD_VERIFICATION_REQUIRED/)
  await assert.rejects(info(ids.owner),/UPLOAD_VERIFICATION_REQUIRED/)
  const candidate=await rpc(ids.owner,'xelay_upload_scan_candidate',['xelay-teaching-files',file.storage_path])
  assert.equal(candidate.already_verified,false)
  const receipt=(await asUser(null,'select public.xelay_record_upload_content_verification($1::jsonb,$2,$3,$4,1) value',[JSON.stringify(candidate),'a'.repeat(64),'b'.repeat(64),'application/pdf'],{role:'service_role'})).rows[0].value
  assert.equal(receipt,true)
  assert.equal((await info(ids.studentA)).download_allowed,false)
  assert.equal((await info(ids.owner)).download_allowed,true)
  await assert.rejects(info(ids.studentB),/FORBIDDEN/)
})
