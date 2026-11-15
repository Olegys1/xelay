import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {teachingTestsFixture,syntheticTest} from './teaching-tests-fixture.mjs'

const q=(kind,extra={})=>({id:kind,kind,text:'Навчальне запитання',points:5,time_limit_seconds:null,partial_credit:false,options:[],buckets:[],...extra})
const number=q('numerical',{answer:'12.5',tolerance:.1})
const text=q('short_text',{answer:['попит','demand']})
const multiple=q('multiple',{options:[{id:'a',text:'А'},{id:'b',text:'Б'},{id:'c',text:'В'},{id:'d',text:'Г'}],answer:['a','c'],partial_credit:true})
const cloze=q('cloze',{text:'Ціна {{price}}, обсяг {{volume}}.',gaps:[{id:'price',answers:['10']},{id:'volume',answers:['20']}],partial_credit:true})
const calculated=q('calculated',{text:'Знайдіть {{a}} + {{b}} * 2.',calculation:{formula:'a+b*2',variables:[{name:'a',min:1,max:10,step:1},{name:'b',min:1,max:10,step:1}]},tolerance:0})
const essay=q('essay')

test('assessment phase1: private banks, new scoring, frozen variants, individual conditions and manual publication gate',async t=>{
  const fx=await teachingTestsFixture();t.after(()=>fx.close())
  const {ids,groups,db,rpc,testMutate,testDetail}=fx
  const legacy=syntheticTest(ids.course,[groups[0]],{questions:[syntheticTest(ids.course,groups).questions[3]],bonus_percent:0})
  await testMutate(ids.owner,'save_test',legacy)
  const legacyStarted=await testMutate(ids.studentA,'start',{id:legacy.id,group_id:groups[0]})
  await db.exec(await readFile(new URL('../../supabase/migrations/202611040020_assessment_bank_variants.sql',import.meta.url),'utf8'))
  const bank=(who,action,payload)=>rpc(who,'xelay_teaching_question_bank_mutate',[action,JSON.stringify({course_id:ids.course,...payload})])
  const score=async(question,answer)=>(await db.query('select public.xelay_private_test_question_points($1::jsonb,$2::jsonb) n',[JSON.stringify(question),JSON.stringify(answer)])).rows[0].n
  const valid=async question=>(await db.query('select public.xelay_private_test_validate_question($1::jsonb) ok',[JSON.stringify(question)])).rows[0].ok
  await t.test('migration preserves existing in-progress attempts including their displayed sequence layout',async()=>{
    let detail=await testDetail(ids.studentA,legacy.id)
    assert.equal(detail.attempt.id,legacyStarted.attempt.id)
    assert.equal(detail.attempt.expires_at,legacyStarted.attempt.expires_at)
    assert.deepEqual(detail.attempt.current_question.options,legacyStarted.attempt.current_question.options)
    detail=await testMutate(ids.studentA,'save_answer',{id:legacy.id,version:detail.attempt.version,question_id:'sequence',answer:legacy.questions[0].answer})
    await testMutate(ids.studentA,'finish',{id:legacy.id,version:detail.attempt.version})
    assert.equal((await testDetail(ids.owner,legacy.id)).attempts[0].score,20)
  })
  await t.test('all supported author question shapes validate; malformed numeric, formula and cloze inputs reject',async()=>{
    for(const question of [number,text,multiple,cloze,calculated,essay]) assert.equal(await valid(question),true,question.kind)
    assert.equal(await valid({...number,answer:'NaN'}),false)
    assert.equal(await valid({...calculated,calculation:{...calculated.calculation,formula:'pg_sleep(1)'}}),false)
    assert.equal(await valid({...calculated,calculation:{...calculated.calculation,formula:'a; select 1'}}),false)
    assert.equal(await valid({...calculated,calculation:{...calculated.calculation,formula:'a/0'}}),false)
    assert.equal(await valid({...cloze,gaps:[{id:'missing',answers:['x']}]}),false)
    assert.equal(await valid({...multiple,answer:['a','a']}),false)
  })
  await t.test('new automated types use text normalization, tolerance and partial-credit penalties',async()=>{
    assert.equal(Number(await score(text,'  ПОПИТ  ')),5)
    assert.equal(Number(await score({...text,case_sensitive:true},'ПОПИТ')),0)
    assert.equal(Number(await score(number,'12,55')),5)
    assert.equal(Number(await score(number,'12.7')),0)
    assert.equal(Number(await score(multiple,['a','c'])),5)
    assert.equal(Number(await score(multiple,['a','b','c','d'])),0)
    assert.equal(Number(await score(multiple,['a'])),2.5)
    assert.equal(Number(await score(cloze,{price:'10',volume:'bad'})),2.5)
    assert.equal(Number(await score(essay,'Власне пояснення')),0)
  })
  await t.test('bank rejects student access, versions edits, imports atomically, and preserves archived entries',async()=>{
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_question_bank',[ids.course]),/FORBIDDEN/)
    await assert.rejects(bank(ids.studentA,'save_entry',{question:number}),/FORBIDDEN|UNVERIFIED/)
    const entryId=randomUUID()
    let response=await bank(ids.owner,'save_entry',{id:entryId,version:0,question:number,category:'Числа',tags:['мкр']})
    let entry=response.entries.find(x=>x.id===entryId);assert.equal(entry.version,1)
    await assert.rejects(bank(ids.owner,'save_entry',{id:entryId,version:0,question:number}),/CONFLICT/)
    response=await bank(ids.owner,'save_entry',{id:entryId,version:1,question:{...number,text:'Оновлено'},category:'Числа',tags:[]})
    assert.equal(response.entries.find(x=>x.id===entryId).version,2)
    const count=response.entries.length
    await assert.rejects(bank(ids.owner,'import_entries',{entries:[{question:text},{question:{...multiple,answer:['unknown']}}]}),/INVALID_INPUT/)
    assert.equal((await rpc(ids.owner,'xelay_teaching_question_bank',[ids.course])).entries.length,count)
    response=await bank(ids.owner,'import_entries',{entries:[{question:text},{question:multiple}]});assert.equal(response.entries.length,count+2)
    response=await bank(ids.owner,'archive_entry',{id:entryId,version:2});assert.ok(response.entries.find(x=>x.id===entryId).archived_at)
    await assert.rejects(fx.asUser(ids.studentA,'select * from teaching_question_bank'),/permission denied/)
  })
  await t.test('per-attempt pool selection/order persists through refresh and hides solutions from students',async()=>{
    const definition=syntheticTest(ids.course,[groups[0]],{questions:[number,text,multiple,cloze,calculated],draw_count:3,shuffle_questions:true,shuffle_answers:true})
    await testMutate(ids.owner,'save_test',definition)
    const started=await testMutate(ids.studentA,'start',{id:definition.id,group_id:groups[0]})
    assert.equal(started.attempt.question_count,3);assert.equal(started.test.question_count,3)
    assert.equal(started.attempt.questions,undefined);assert.equal(started.attempt.current_question.answer,undefined)
    const teacher=await testDetail(ids.owner,definition.id);const frozen=teacher.attempts[0].questions
    assert.equal(frozen.length,3);assert.equal(new Set(frozen.map(x=>x.id)).size,3)
    assert.deepEqual((await testDetail(ids.owner,definition.id)).attempts[0].questions,frozen)
    let own=await testDetail(ids.studentA,definition.id)
    assert.equal(own.attempt.current_question.id,frozen[0].id)
    assert.equal(own.attempt.current_question.calculation,undefined);assert.equal(own.attempt.current_question.generated_variables,undefined)
    if(own.attempt.current_question.gaps) assert.ok(own.attempt.current_question.gaps.every(g=>!('answers' in g)))
    assert.deepEqual(own.attempts,[])
    await assert.rejects(testMutate(ids.owner,'save_test',{...definition,version:1,title:'Change'}),/IMMUTABLE/)
    for(const[index,question]of frozen.entries()){
      const answer=question.kind==='short_text'?question.answer[0]:question.kind==='cloze'?Object.fromEntries(question.gaps.map(g=>[g.id,g.answers[0]])):question.answer
      own=await testMutate(ids.studentA,'save_answer',{id:definition.id,version:own.attempt.version,question_id:question.id,answer})
      if(index<frozen.length-1)own=await testMutate(ids.studentA,'navigate',{id:definition.id,version:own.attempt.version,index:index+1})
    }
    await testMutate(ids.studentA,'finish',{id:definition.id,version:own.attempt.version})
    assert.equal((await testDetail(ids.owner,definition.id)).attempts[0].score,20,'the denominator includes only the assigned variant')
    const second=await testMutate(ids.headA,'start',{id:definition.id,group_id:groups[0]})
    assert.notEqual(second.attempt.id,own.attempt.id)
    assert.equal((await testDetail(ids.owner,definition.id)).attempts.length,2)
  })
  await t.test('calculated values are generated once, scored privately, and reject malicious arithmetic',async()=>{
    const definition=syntheticTest(ids.course,[groups[0]],{questions:[calculated],bonus_percent:0})
    await testMutate(ids.owner,'save_test',definition)
    let detail=await testMutate(ids.studentA,'start',{id:definition.id,group_id:groups[0]})
    assert.equal(detail.attempt.current_question.calculation,undefined)
    assert.ok(!detail.attempt.current_question.text.includes('{{'))
    const teacher=await testDetail(ids.owner,definition.id);const generated=teacher.attempts[0].questions[0]
    assert.equal(Number(generated.answer),generated.generated_variables.a+generated.generated_variables.b*2)
    detail=await testMutate(ids.studentA,'save_answer',{id:definition.id,version:detail.attempt.version,question_id:calculated.id,answer:generated.answer})
    detail=await testMutate(ids.studentA,'finish',{id:definition.id,version:detail.attempt.version})
    assert.equal((await testDetail(ids.owner,definition.id)).attempts[0].score,20)
    for(const expression of ['a.constructor','1;select 1','2**8','a/0','(a+b','random()'])
      await assert.rejects(db.query('select public.xelay_private_assessment_arithmetic($1,$2::jsonb)',[expression,'{"a":2,"b":3}']),/INVALID_FORMULA/)
    const arithmetic=(await db.query('select public.xelay_private_assessment_arithmetic($1,$2::jsonb) n',['-(a+3)*2/5','{"a":2}'])).rows[0].n
    assert.equal(Number(arithmetic),-2)
  })
  await t.test('calculated domains retry undefined combinations deterministically and fall back to the validated minimum',async()=>{
    const domain={...calculated,id:'domain',text:'Обчисліть 1 / {{a}}.',calculation:{formula:'1/a',variables:[{name:'a',min:-1,max:1,step:1}]}}
    assert.equal(await valid(domain),true)
    const variant=async(question,id)=>(await db.query('select public.xelay_private_assessment_snapshot(jsonb_populate_record(null::public.teaching_tests,$1),$2) variant',
      [JSON.stringify({questions:[question],shuffle_questions:false,shuffle_answers:false,draw_count:null}),id])).rows[0].variant
    for(let index=0;index<24;index++){
      const id=randomUUID(),first=await variant(domain,id)
      assert.notEqual(first[0].generated_variables.a,0,'a valid authored domain must not randomly fail start at a=0')
      assert.equal(Number(first[0].answer),1/first[0].generated_variables.a)
      assert.deepEqual(await variant(domain,id),first,'resampling is deterministic and does not change the personal variant')
    }
    const bounded={...calculated,id:'bounded',text:'Обчисліть 10¹² × ({{a}} + 1).',calculation:{formula:'1000000000000*(a+1)',variables:[{name:'a',min:0,max:10000,step:1}]}}
    assert.equal(await valid(bounded),true)
    const fallbackId='00000000-0000-4000-8000-000000000001'
    const retries=(await db.query("select count(*)::integer n from generate_series(0,31)i where (('x'||substr(md5($1||':bounded:a'||case when i=0 then '' else ':'||i::text end),1,8))::bit(32)::bigint%10001)=0",[fallbackId])).rows[0].n
    assert.equal(retries,0,'this fixed attempt reaches the bounded fallback rather than a successful random sample')
    const fallback=await variant(bounded,fallbackId)
    assert.equal(fallback[0].generated_variables.a,0)
    assert.equal(Number(fallback[0].answer),1000000000000)
    await assert.rejects(variant({...bounded,calculation:{...bounded.calculation,formula:'1/0'}},fallbackId),/INVALID_FORMULA/,'an actually invalid formula is never swallowed by fallback')
  })
  await t.test('individual windows cannot grant membership or mutate started attempt time',async()=>{
    const opens=new Date(Date.now()+3600000).toISOString(),closes=new Date(Date.now()+7200000).toISOString()
    const override={user_id:ids.studentA,group_id:groups[0],opens_at:new Date(Date.now()-60000).toISOString(),closes_at:closes,duration_seconds:2400}
    const definition=syntheticTest(ids.course,[groups[0]],{questions:[number],opens_at:opens,closes_at:closes,overrides:[override]})
    await testMutate(ids.owner,'save_test',definition)
    const view=await testDetail(ids.studentA,definition.id);assert.equal(view.test.duration_seconds,2400);assert.deepEqual(view.test.overrides,[])
    const started=await testMutate(ids.studentA,'start',{id:definition.id,group_id:groups[0]})
    const duration=(new Date(started.attempt.expires_at)-new Date(started.attempt.started_at))/1000;assert.equal(duration,2400)
    await assert.rejects(testMutate(ids.owner,'save_override',{id:definition.id,version:1,override:{...override,duration_seconds:5000}}),/IMMUTABLE/)
    await assert.rejects(testMutate(ids.studentA,'save_override',{id:definition.id,version:1,override}),/FORBIDDEN|UNVERIFIED/)
    const bad=syntheticTest(ids.course,[groups[0]],{questions:[number],overrides:[{...override,user_id:ids.studentB}]})
    await assert.rejects(testMutate(ids.owner,'save_test',bad),/INVALID_INPUT/)
    await assert.rejects(testMutate(ids.owner,'save_test',{...bad,overrides:[{...override,group_id:undefined}]}),/INVALID_INPUT/)
    const other=syntheticTest(ids.course,[groups[0]],{questions:[number]});await testMutate(ids.owner,'save_test',other)
    const updated=await testMutate(ids.owner,'save_override',{id:other.id,version:1,override});assert.equal(updated.test.version,2)
    assert.equal((await testDetail(ids.studentA,other.id)).test.duration_seconds,2400)
  })
  await t.test('essay manual review is mandatory; approval and journal drafts preserve separate publication',async()=>{
    const definition=syntheticTest(ids.course,[groups[0]],{questions:[essay],bonus_percent:0})
    await testMutate(ids.owner,'save_test',definition)
    let detail=await testMutate(ids.studentA,'start',{id:definition.id,group_id:groups[0]})
    detail=await testMutate(ids.studentA,'save_answer',{id:definition.id,version:detail.attempt.version,question_id:essay.id,answer:'Пояснення своїми словами'})
    await testMutate(ids.studentA,'finish',{id:definition.id,version:detail.attempt.version})
    await db.query("update teaching_tests set closes_at=clock_timestamp()-interval '1 second',opens_at=clock_timestamp()-interval '1 day' where id=$1",[definition.id])
    await assert.rejects(testMutate(ids.owner,'finalize_results',{id:definition.id,version:1}),/MANUAL_REVIEW_REQUIRED/)
    let teacher=await testDetail(ids.owner,definition.id)
    const attempt=teacher.attempts[0];assert.equal(attempt.question_results[0].requires_review,true)
    teacher=await testMutate(ids.owner,'save_review',{id:definition.id,attempt_id:attempt.id,version:attempt.version,marks:[{question_id:essay.id,mode:'custom',points:4,reason:'Оцінено пояснення'}]})
    teacher=await testMutate(ids.owner,'finalize_results',{id:definition.id,version:teacher.test.version})
    teacher=await testMutate(ids.owner,'review_results',{id:definition.id,version:teacher.test.version})
    const grade=(await db.query('select * from teaching_grades where id=$1',[teacher.attempts[0].grade_id||((await db.query('select grade_id from teaching_test_attempts where id=$1',[attempt.id])).rows[0].grade_id)])).rows[0]
    assert.equal(Number(grade.draft_score),16);assert.equal(grade.published_score,null)
    assert.equal((await testDetail(ids.studentA,definition.id)).attempt.score,undefined)
  })
})
