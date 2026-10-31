import test from 'node:test'
import assert from 'node:assert/strict'
import {createCloudStudyServices} from '../../server/assistant-v2/cloudStudyServices.ts'
import {readExtendedStudyPage,assistantSearchTerms,assistantSourcePath} from '../../server/assistant-v2/cloudStudyRead.ts'
import {boundedMaterialText,extractCloudMaterialText,CLOUD_MATERIAL_LIMITS} from '../../server/assistant-v2/cloudMaterialText.ts'
import {deflateRawSync} from 'node:zlib'
import * as XLSX from 'xlsx'

const id=n=>`40000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const USER=id(1),PEER=id(2),GROUP=id(10),FOREIGN=id(11),SUBJECT=id(20),COURSE=id(30),MATERIAL=id(40),SEMINAR=id(50),QUESTION=id(51),TEAM=id(52),WORKSPACE=id(60)
const NOW=Date.parse('2026-11-02T10:00:00Z'),TOKEN='synthetic-caller-credential-no-network',BODY='Якщо є світло, оберіть один із двох варіантів.'
const base={groupId:GROUP,subjectId:SUBJECT,sourcePath:`/groups/${GROUP}`,archived:false}
function setup(){
 const state={session:{userId:USER,expiresAt:'2026-11-03T10:00:00Z',sessionId:'fixture-session',accountActive:true,emailConfirmed:true},rows:[{...base,id:MATERIAL,materialId:MATERIAL,materialSourceKind:'study',kind:'material',title:'Lecture',body:BODY,published:true,allowAi:true,allowDownload:false}],memberships:[{userId:USER,groupId:GROUP,membershipStatus:'accepted',representativeId:PEER,subjectIds:[SUBJECT]}],grants:[],rpcCalls:[],reads:[],downloads:0,extracts:0,
  rights:{id:MATERIAL,sourceKind:'study',allowAi:true,rightsVersion:'a'.repeat(32),title:'Lecture',body:BODY,attachments:[]},onDownload:null,onPage:null,rowsByTopic:null}
 const client={rpc:async(name,args)=>{state.rpcCalls.push({name,args});assert.equal(name,'xelay_assistant_material_ai');return{data:structuredClone(state.rights),error:null}}}
 const services=createCloudStudyServices({now:()=>NOW,verifySession:async()=>structuredClone(state.session),createCallerClient:()=>client,
  createCallerRepository:()=>({readAccess:async()=>({userId:USER,revision:'fixture-revision',memberships:structuredClone(state.memberships),teachingGrants:structuredClone(state.grants)}),readPage:async query=>{state.reads.push(query);await state.onPage?.();return{rows:structuredClone(state.rowsByTopic?.[query.topic]||state.rows)}}}),
  readStorageFile:async d=>{state.downloads++;await state.onDownload?.(d);return new Uint8Array(Buffer.from('file'))},extractFileText:async()=>{state.extracts++;return{text:'Exact extracted author text',truncated:false}}})
 return{state,services}
}
const deny=(operation,code)=>assert.rejects(operation,error=>error.code===code)
const input=()=>({scope:{groupId:GROUP,period:'current'},materialId:MATERIAL})

test('material explanation returns only bounded authorized text and local source, never file paths or signed URLs',async()=>{
 const h=setup();h.state.rights.attachments=[{path:`${GROUP}/${USER}/${id(90)}.txt`,file_name:'Lecture.txt',file_size:4,mime_type:'text/plain'}]
 const result=await h.services.materialContent(TOKEN,input())
 assert.equal(result.allowAi,true);assert.equal(result.userId,USER);assert.ok(result.text.includes(BODY));assert.ok(result.text.includes('Exact extracted author text'))
 assert.equal(h.state.downloads,1);assert.equal(h.state.extracts,1);assert.equal(JSON.stringify(result).includes(h.state.rights.attachments[0].path),false)
 assert.equal(result.sources[0].path,`/groups/${GROUP}`)
})
test('blocked author consent and foreign material stop before any file retrieval',async()=>{
 const h=setup();h.state.rights.allowAi=false
 await deny(h.services.materialContent(TOKEN,input()),'material_ai_not_allowed');assert.equal(h.state.downloads,0)
 await deny(h.services.materialContent(TOKEN,{...input(),materialId:id(99)}),'material_unavailable');assert.equal(h.state.rpcCalls.length,1)
})
test('date context does not block material access; a student can explain the published material of its exact teacher course',async()=>{
 const h=setup();h.state.rows[0].courseId=COURSE;h.state.rows[0].materialSourceKind='teaching';h.state.rights.sourceKind='teaching'
 const result=await h.services.materialContent(TOKEN,{scope:{groupId:GROUP,courseId:COURSE,date:'2026-11-02',period:'current'},materialId:MATERIAL})
 assert.equal(result.allowAi,true);assert.ok(h.state.reads.every(q=>!q.selections[0].courseId))
})
test('unassigned personal teacher material is available only to its real author and exact course',async()=>{
 const h=setup();h.state.memberships=[];Object.assign(h.state.rights,{sourceKind:'teaching',canChange:true,courseId:COURSE})
 const result=await h.services.materialContent(TOKEN,{scope:{courseId:COURSE,period:'all'},materialId:MATERIAL})
 assert.equal(result.sources[0].path,`/teaching?course=${COURSE}&home=materials`);assert.equal(h.state.reads.length,0)
 h.state.rights.canChange=false;await deny(h.services.materialContent(TOKEN,{scope:{courseId:COURSE},materialId:MATERIAL}),'material_unavailable')
 h.state.rights.canChange=true;await deny(h.services.materialContent(TOKEN,{scope:{courseId:id(99)},materialId:MATERIAL}),'material_unavailable')
})
test('rights revoked during file reading suppress all content, and old versions fail post-generation check',async()=>{
 const h=setup();h.state.rights.attachments=[{path:`${GROUP}/${USER}/${id(90)}.txt`,file_name:'Lecture.txt',file_size:4,mime_type:'text/plain'}]
 h.state.onDownload=async()=>{h.state.rights.allowAi=false}
 await deny(h.services.materialContent(TOKEN,input()),'material_ai_not_allowed')
 h.state.rights.allowAi=true;h.state.rights.rightsVersion='b'.repeat(32)
 await deny(h.services.assertMaterialRights(TOKEN,{...input(),rightsVersion:'a'.repeat(32)}),'material_changed')
})
test('arbitrary URLs, traversal and over-limit descriptors never enter storage or the extractor',async()=>{
 for(const path of ['https://169.254.169.254/latest','../private.pdf',`${GROUP}/${USER}/../file.txt`]){
  const h=setup();h.state.rights.attachments=[{path,file_name:'test.txt',file_size:4,mime_type:'text/plain'}]
  await deny(h.services.materialContent(TOKEN,input()),'material_file_invalid');assert.equal(h.state.downloads,0)
 }
 const h=setup();h.state.rights.attachments=[{path:`${GROUP}/${USER}/${id(90)}.txt`,file_name:'test.txt',file_size:CLOUD_MATERIAL_LIMITS.fileBytes+1,mime_type:'text/plain'}]
 const result=await h.services.materialContent(TOKEN,input());assert.equal(result.truncated,true);assert.equal(h.state.downloads,0)
})
test('session expiry and account switching after retrieval prevent material output',async()=>{
 const h=setup();h.state.onPage=()=>{h.state.session.userId=PEER}
 await assert.rejects(h.services.materialContent(TOKEN,input()),e=>['session_changed','repository_invalid_access'].includes(e.code))
 const expired=setup();expired.state.session.expiresAt='not-a-date';await deny(expired.services.materialContent(TOKEN,input()),'session_invalid')
})
test('public topics work without a learning group while private-message/dean topics stay unavailable',async()=>{
 const h=setup();h.state.memberships=[];h.state.rows=[{id:id(71),kind:'news',groupId:'',subjectId:'',title:'Публічна новина',body:'Published only',sourcePath:`/news/${id(71)}`}]
 const result=await h.services.read(TOKEN,{topic:'news',scope:{query:'публічна новина'}})
 assert.equal(result.records.length,1);assert.deepEqual(h.state.reads[0].selections,[])
 await deny(h.services.read(TOKEN,{topic:'messages',scope:{}}),'invalid_request')
 await deny(h.services.read(TOKEN,{topic:'dean',scope:{}}),'invalid_request')
})
test('an active teacher grant denies internal seminars even with accepted student membership',async()=>{
 const h=setup();h.state.grants=[{userId:USER,groupId:GROUP,courseId:COURSE,subjectId:SUBJECT,connectionStatus:'accepted',teacherVerified:true,teacherHasCurrentAccess:true,permissions:['assignments'],validFrom:null,validUntil:null}]
 await deny(h.services.read(TOKEN,{topic:'seminars',scope:{groupId:GROUP}}),'teacher_seminar_private');assert.equal(h.state.reads.length,0)
})
test('own grade totals use the real category caps, coefficients, final rounding and maximum',async()=>{
 const h=setup(),rules={categories:[{id:'seminar',name:'Семінар',max_points:10,coefficient:2}],total_max:12,rounding:'integer'}
 h.state.rows=[5,4].map((points,i)=>({...base,kind:'grade',id:id(80+i),courseId:COURSE,studentId:USER,activityId:id(90+i),title:`Робота${i}`,subjectName:'Вища математика',points,maxPoints:10,coefficient:2,published:true,category:'seminar',gradingRules:rules}))
 const result=await h.services.read(TOKEN,{topic:'results',scope:{groupId:GROUP}})
 assert.equal(result.gradeSummary[0].points,9);assert.equal(result.gradeSummary[0].weightedPoints,10);assert.notEqual(result.gradeSummary[0].weightedPoints,18)
 assert.equal(result.gradeSummary[0].weightedMaxPoints,12);assert.equal(result.gradeSummary[0].categories[0].capped,10)
})
test('teacher grade names are only in authorized UI rows and never the model reference summary',async()=>{
 const h=setup();h.state.grants=[{userId:USER,groupId:GROUP,courseId:COURSE,subjectId:SUBJECT,connectionStatus:'accepted',teacherVerified:true,teacherHasCurrentAccess:true,permissions:['grades'],validFrom:null,validUntil:null}]
 h.state.rows=[{...base,kind:'grade',id:id(80),courseId:COURSE,studentId:PEER,studentName:'AUTHORIZED_UI_PEER_NAME',activityId:id(90),title:'Робота',points:8,maxPoints:10,coefficient:1,published:true}]
 const result=await h.services.read(TOKEN,{topic:'gradebook',scope:{groupId:GROUP,courseId:COURSE}})
 assert.equal(result.records[0].studentName,'AUTHORIZED_UI_PEER_NAME');assert.equal(JSON.stringify(result.modelContext).includes('AUTHORIZED_UI_PEER_NAME'),false)
})
test('preparation plan preserves exact conditional tasks and deadlines and labels its advice without AI grading',async()=>{
 const h=setup();h.state.rowsByTopic={study:[{...base,kind:'homework',id:id(80),date:'2026-11-02',title:'Умова',body:BODY,dueAt:'2026-11-03T10:00:00Z',published:true},{...base,kind:'homework',id:id(81),date:'2026-11-02',title:'Прострочене',body:'Old',dueAt:'2026-11-01T10:00:00Z',published:true}],results:[]}
 const result=await h.services.preparationPlan(TOKEN,{scope:{groupId:GROUP,from:'2026-11-02',to:'2026-11-02',period:'current'}})
 assert.equal(result.items.length,1);assert.equal(result.items[0].condition,BODY);assert.equal(result.items[0].dueAt,'2026-11-03T10:00:00Z');assert.equal(result.advisoryOnly,true);assert.equal(result.gradeSummary.length,0)
})
test('personal/shared data changed during retrieval is rejected before display',async()=>{
 const h=setup();h.state.rows=[{id:id(70),kind:'task',groupId:'',subjectId:'',title:'Private task',body:'own only',sourcePath:'/organizer',space:'personal',completed:false,dueAt:null,canEdit:true}]
 let calls=0;h.state.onPage=()=>{if(++calls===2)h.state.rows=[]}
 await deny(h.services.read(TOKEN,{topic:'organizer',scope:{space:'personal'}}),'access_changed')
})

function publicClient(tables,rpcs={}){
 const calls=[]
 class Query{
  constructor(name){this.name=name;this.filters=[];this.max=1000}
  select(columns){this.columns=columns;return this}order(){return this}limit(n){this.max=n;return this}abortSignal(){return this}
  eq(k,v){this.filters.push(r=>r[k]===v);return this}in(k,v){this.filters.push(r=>v.includes(r[k]));return this}gte(k,v){this.filters.push(r=>r[k]>=v);return this}lte(k,v){this.filters.push(r=>r[k]<=v);return this}or(value){this.search=value;return this}
  then(resolve,reject){calls.push({table:this.name,columns:this.columns,search:this.search});return Promise.resolve({data:(tables[this.name]||[]).filter(r=>this.filters.every(f=>f(r))).slice(0,this.max),error:null}).then(resolve,reject)}
 }
 return{calls,client:{from:name=>new Query(name),rpc:async(name,args)=>{assert.ok(Object.hasOwn(rpcs,name),name);return{data:typeof rpcs[name]==='function'?rpcs[name](args):rpcs[name],error:null}}}}
}
const query=topic=>({topic,audience:'student',selections:[],period:'current',limit:30,userId:USER,accessRevision:'fixture'})
test('public search strips command words and PostgREST logic punctuation, excludes drafts/future publications',async()=>{
 const h=publicClient({news_posts:[{id:id(70),title:'Економіка',body:'Семінар',status:'published',published_at:'2026-11-01T00:00:00Z'},{id:id(71),title:'DRAFT_SECRET',body:'private',status:'draft',published_at:'2026-11-01T00:00:00Z'},{id:id(72),title:'FUTURE_SECRET',body:'private',status:'published',published_at:'2028-01-01T00:00:00Z'}]})
 const result=await readExtendedStudyPage({client:h.client,userId:USER,query:{...query('news'),query:'знайди новини про економіка,).or(password.neq.1)'},now:()=>NOW})
 assert.equal(JSON.stringify(result).includes('SECRET'),false)
 assert.equal(h.calls[0].search.includes(').or('),false)
 assert.deepEqual(assistantSearchTerms('знайди питання про економіку'),['економіку'])
 for(const path of ['//evil.example','/admin','https://evil.example','https://www.xelay.ink/organizer','/groups/../../admin','/organizer?next=https://evil.example'])assert.throws(()=>assistantSourcePath(path))
})
test('seminar projection exposes capacities and only own booking, never peer names or peer booking ids',async()=>{
 const h=publicClient({study_group_seminars:[{id:SEMINAR,group_id:GROUP,subject_id:SUBJECT,lesson_date:'2026-11-02',starts_at:'08:30',ends_at:'09:50',title:'Seminar',instructions:BODY,format:'questions',selection_version:2}],study_group_seminar_questions:[{id:QUESTION,seminar_id:SEMINAR,position:1,body:'Question',primary_capacity:1,supplement_capacity:2}],study_group_seminar_teams:[{id:TEAM,seminar_id:SEMINAR,name:'Team',capacity:3}],study_group_seminar_reservations:[{id:id(90),seminar_id:SEMINAR,user_id:USER,question_id:QUESTION,team_id:null,role:'primary'},{id:id(91),seminar_id:SEMINAR,user_id:PEER,question_id:QUESTION,team_id:null,role:'supplement',full_name:'PEER_NAME_SECRET'}]})
 const page=await readExtendedStudyPage({client:h.client,userId:USER,query:{...query('seminars'),from:'2026-11-02',to:'2026-11-02',selections:[{groupId:GROUP}],groupPermissions:['seminars']},now:()=>NOW})
 const record=page.rows[0];assert.equal(record.questions[0].occupiedSupplement,1);assert.equal(record.myReservation.id,id(90));assert.equal(record.canReopen,true)
 assert.equal(JSON.stringify(page).includes('PEER_NAME_SECRET'),false);assert.equal(JSON.stringify(page).includes(id(91)),false)
})
test('shared organizer requires actual membership and never projects invitation/member contacts',async()=>{
 const h=publicClient({}, {xelay_shared_organizer_overview:{workspaces:[{id:WORKSPACE}],invitations:[{email:'PRIVATE_EMAIL_SECRET'}]},xelay_shared_organizer_workspace:{workspace:{id:WORKSPACE},members:[{workspace_id:WORKSPACE,user_id:USER,role:'member',email:'PRIVATE_EMAIL_SECRET'}],invitations:[],tasks:[{id:id(70),workspace_id:WORKSPACE,title:'Shared task',notes:'Allowed content',completed:false,due_at:null}],total:1}})
 const result=await readExtendedStudyPage({client:h.client,userId:USER,query:{...query('organizer'),space:'shared',workspaceId:WORKSPACE},now:()=>NOW})
 assert.equal(result.rows.length,1);assert.equal(JSON.stringify(result).includes('PRIVATE_EMAIL_SECRET'),false)
 await assert.rejects(readExtendedStudyPage({client:h.client,userId:USER,query:{...query('organizer'),space:'shared',workspaceId:FOREIGN},now:()=>NOW}))
})
test('actual public guide JSON yields searchable real anchored instructions',async()=>{
 const h=publicClient({}),result=await readExtendedStudyPage({client:h.client,userId:USER,query:{...query('help'),query:'розклад'},now:()=>NOW})
 assert.ok(result.rows.length>0);for(const row of result.rows)assert.match(row.sourcePath,/^\/guides\/#(?:headman|teacher)\/[a-z\d-]+$/)
})
test('UTF-8 text extraction enforces content validation and byte limits without executing files',async()=>{
 const valid=await extractCloudMaterialText(new Uint8Array(Buffer.from('Звичайний матеріал\nБез активного вмісту')),{name:'lecture.txt',mimeType:'text/plain'})
 assert.ok(valid.text.includes('Звичайний'))
 await assert.rejects(extractCloudMaterialText(new Uint8Array(Buffer.from('<script>untrusted()</script>')),{name:'fake.pdf',mimeType:'application/pdf'}))
 const bounded=boundedMaterialText('🦆'.repeat(10000));assert.equal(Buffer.byteLength(bounded.text),24000);assert.equal(bounded.truncated,true)
})

function pdfTextFixture(){
 const stream='BT /F1 12 Tf 10 20 Td (Synthetic lecture example) Tj ET'
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`]
 let source='%PDF-1.7\n',offsets=[]
 for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(source));source+=`${i+1} 0 obj\n${o}\nendobj\n`}
 const start=Buffer.byteLength(source);source+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.map(o=>`${String(o).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
 return new Uint8Array(Buffer.from(source))
}
test('real PDF text extraction reads a validated text page without network or document execution',async()=>{
 const result=await extractCloudMaterialText(pdfTextFixture(),{name:'lecture.pdf',mimeType:'application/pdf'})
 assert.ok(result.text.includes('Synthetic lecture example'));assert.equal(result.truncated,false)
})
function zipFixture(files){
 const crc=input=>{let c=0xffffffff;for(const b of input){c^=b;for(let i=0;i<8;i++)c=c&1?0xedb88320^(c>>>1):c>>>1}return(c^0xffffffff)>>>0}
 const locals=[],central=[];let offset=0
 for(const [name,text]of files){const raw=Buffer.from(text),packed=deflateRawSync(raw),filename=Buffer.from(name),local=Buffer.alloc(30+filename.length),dir=Buffer.alloc(46+filename.length),sum=crc(raw)
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(sum,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(filename.length,26);filename.copy(local,30)
  dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt16LE(8,10);dir.writeUInt32LE(sum,16);dir.writeUInt32LE(packed.length,20);dir.writeUInt32LE(raw.length,24);dir.writeUInt16LE(filename.length,28);dir.writeUInt32LE(offset,42);filename.copy(dir,46)
  locals.push(local,packed);central.push(dir);offset+=local.length+packed.length
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16)
 return new Uint8Array(Buffer.concat([...locals,directory,end]))
}
function officeFixture(extension,body,extra=[]){
 const p=extension==='docx'?['word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']:['ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml']
 return zipFixture([['[Content_Types].xml',`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${p[0]}" ContentType="${p[1]}"/></Types>`],['_rels/.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${p[0]}"/></Relationships>`],[p[0],body],...extra])
}
test('real DOCX and PPTX extraction produces plain text after the existing active-content validator',async()=>{
 const doc=officeFixture('docx','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Exact author lecture</w:t></w:r></w:p></w:body></w:document>')
 const d=await extractCloudMaterialText(doc,{name:'lecture.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});assert.ok(d.text.includes('Exact author lecture'))
 const ppt=officeFixture('pptx','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>',[['ppt/slides/slide1.xml','<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Exact slide text</a:t></p:sld>']])
 const p=await extractCloudMaterialText(ppt,{name:'lecture.pptx',mimeType:'application/vnd.openxmlformats-officedocument.presentationml.presentation'});assert.ok(p.text.includes('Exact slide text'))
})
test('real XLSX extraction reads bounded cell text without running formulas',async()=>{
 const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Предмет','Матеріал'],['Математика','Розділ 3']]),'Лекція')
 const bytes=XLSX.write(book,{type:'buffer',bookType:'xlsx',compression:true})
 const result=await extractCloudMaterialText(new Uint8Array(bytes),{name:'lecture.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
 assert.ok(result.text.includes('Розділ 3'));assert.ok(result.text.includes('Математика'))
})
