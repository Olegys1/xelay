// Execute current React handlers, raw XHR uploader, verification helper and
// repository adapters against explicit synthetic Auth/Storage/RPC boundaries.
// A pass is client saving-flow evidence, not production or managed-service proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createSavingFlow, plain, nodes, text, ACTOR, COURSE, GROUP, ASSIGNMENT } from './upload-content-save-harness.mjs'

const kinds=['submission','publication','library']
const body='Текст, який не можна втратити'
function fixture(t,kind,options={}){
  const fx=createSavingFlow(kind,options)
  t.after(()=>{fx.unmount();fx.assertNoUnexpected()})
  fx.configure()
  return fx
}
const saveWrites=fx=>fx.writes.filter(event=>event.args.p_action!=='reserve_submission')
function retainedBody(fx,kind){
  const name=kind==='submission'?'submission-body':kind==='publication'?'publication-body':'library-material-body'
  assert.equal(fx.run.find(node=>node.props?.name===name).props.value,body)
}

for(const kind of kinds){
  test(`${kind}: actual saving waits for verification, persists the same file and reloads its real view shape`,async t=>{
    const fx=fixture(t,kind,{deferVerification:true})
    const pending=fx.startSave()
    await fx.waitForVerification()
    fx.run.render()
    assert.equal(saveWrites(fx).length,0)
    assert.equal(fx.loaded,null)
    const indicator=nodes(fx.run.tree).find(node=>node.type==='progress')
    assert.ok(indicator,'Upload progress is displayed while server verification is pending')
    assert.equal(indicator.props.value,99)
    assert.match(text(fx.run.tree),/Перевіряємо вміст файлу/)
    fx.finishVerification()
    await pending;await fx.run.flush()
    const writes=saveWrites(fx)
    assert.equal(writes.length,kind==='submission'?2:1)
    const saved=writes[0].args.p_payload
    assert.equal(saved.body,body)
    assert.equal(saved.attachments.length,1)
    const attachment=saved.attachments[0]
    assert.equal(attachment.name,'lecture.pdf')
    assert.equal(attachment.mime_type,'application/pdf')
    const bucket=kind==='submission'?'xelay-submission-files':'xelay-teaching-files'
    assert.ok(fx.receipts.has(bucket+'/'+attachment.storage_path))
    assert.ok(fx.objects.has(bucket+'/'+attachment.storage_path))
    const verificationIndex=fx.events.findIndex(event=>event.kind==='verification')
    const firstSaveIndex=fx.events.findIndex(event=>event.kind==='rpc'&&event.args.p_action===writes[0].args.p_action)
    assert.ok(firstSaveIndex>verificationIndex)
    if(kind==='submission'){
      assert.equal(writes[0].args.p_action,'save_submission')
      assert.equal(writes[1].args.p_action,'submit_submission')
      assert.equal(saved.item_id,ASSIGNMENT);assert.equal(saved.group_id,GROUP)
      assert.equal(fx.loaded.my_submission.status,'submitted')
      assert.equal(fx.loaded.my_submission.user_id,ACTOR)
      assert.deepEqual(plain(fx.loaded.my_submission.attachments),plain(saved.attachments))
    }else{
      assert.equal(saved.expected_user_id,ACTOR);assert.equal(saved.course_id,COURSE)
      assert.equal(saved.status,'published')
      if(kind==='library')assert.deepEqual(plain(saved.target_group_ids),[GROUP])
      else assert.equal(saved.targets[0].group_id,GROUP)
      assert.deepEqual(plain(fx.loaded.materials[0].attachments),plain(saved.attachments))
      assert.equal(fx.closes,1)
    }
    const view=await fx.renderSaved()
    assert.match(text(view),/Текст, який не можна втратити/)
    const resources=nodes(view).find(node=>node.props?.attachments||node.props?.publication?.attachments)
    assert.ok(resources,'Saved reading view receives file resources')
    assert.deepEqual(plain(resources.props.attachments||resources.props.publication.attachments),plain(saved.attachments))
  })

  for(const verdict of ['rejected','uncertain']){
    test(`${kind}: ${verdict} verification keeps selected file and text without any save mutation`,async t=>{
      const fx=fixture(t,kind,{verdict})
      await fx.startSave();await fx.run.flush()
      assert.equal(saveWrites(fx).length,0)
      assert.equal(fx.loaded,null)
      assert.equal(fx.closes,0)
      retainedBody(fx,kind)
      assert.match(text(fx.run.tree),/lecture\.pdf/)
      assert.match(text(fx.run.tree),/перевірку|перевірки/)
      assert.equal(fx.receipts.size,0)
      assert.equal(fx.events.filter(event=>event.kind==='storage').length,1)
    })
  }

  test(`${kind}: account replacement during verification prevents saving old work`,async t=>{
    const fx=fixture(t,kind,{deferVerification:true})
    const pending=fx.startSave();await fx.waitForVerification()
    fx.changeAccount();fx.finishVerification()
    await pending;await fx.run.flush()
    assert.equal(saveWrites(fx).length,0)
    assert.equal(fx.loaded,null)
    assert.equal(fx.closes,0)
    assert.equal(fx.receipts.size,0)
    retainedBody(fx,kind)
    assert.match(text(fx.run.tree),/lecture\.pdf/)
  })

  test(`${kind}: unmount cancels in-flight verification and prevents background publication`,async t=>{
    const fx=fixture(t,kind,{deferVerification:true})
    const pending=fx.startSave();await fx.waitForVerification()
    fx.unmount();fx.finishVerification()
    await pending
    assert.equal(saveWrites(fx).length,0)
    assert.equal(fx.loaded,null)
    assert.equal(fx.receipts.size,0)
    assert.equal(fx.events.find(event=>event.kind==='verification').signal.aborted,true)
  })

  test(`${kind}: a lost save response retains text and the verified attachment without repeating upload`,async t=>{
    const fx=fixture(t,kind,{saveError:true})
    await fx.startSave();await fx.run.flush()
    assert.equal(saveWrites(fx).length,1,'One attempted save is distinct from a rejected upload')
    assert.equal(fx.loaded,null)
    retainedBody(fx,kind)
    assert.match(text(fx.run.tree),/lecture\.pdf/)
    assert.equal(fx.objects.size,1)
    assert.equal(fx.receipts.size,1)
    assert.equal(fx.events.filter(event=>event.kind==='storage').length,1)
    assert.equal(fx.closes,0)
  })
}

test('a new student submission may reserve its own draft but never saves or submits after rejected verification',async t=>{
  const fx=fixture(t,'submission',{freshSubmission:true,verdict:'rejected'})
  await fx.startSave();await fx.run.flush()
  assert.deepEqual(fx.writes.map(event=>event.args.p_action),['reserve_submission'])
  assert.equal(fx.submission.status,'draft')
  assert.equal(fx.submission.body,'')
  assert.deepEqual(fx.submission.attachments,[])
  retainedBody(fx,'submission')
  assert.match(text(fx.run.tree),/lecture\.pdf/)
})
