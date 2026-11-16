import test from 'node:test'
import assert from 'node:assert/strict'
import ts from 'typescript'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'

const source=readFileSync(new URL('../src/lib/maxResearchStudio.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
function library(extra={}){const module={exports:{}};vm.runInNewContext(compiled,{module,exports:module.exports,Set,Map,Math,Number,JSON,Date,ArrayBuffer,Uint8Array,TextDecoder,...extra});return module.exports}
const r=library(),clone=value=>JSON.parse(JSON.stringify(value)),date='2026-11-16T10:00:00.000Z'
const pdfBytes=(text='%PDF-1.7\n')=>new TextEncoder().encode(text).buffer
const document={id:'own-book',title:'My research.pdf',pages:12,lastPage:7,bookmarks:[2,7],createdAt:date}
const excerpt={id:'excerpt-one',title:'A useful idea',sourceTitle:document.title,sourceId:document.id,page:7,quote:'A choice has a cost.',note:'Compare the alternatives.',createdAt:date}
const state={version:1,sources:[document],excerpts:[excerpt],activeId:document.id}

test('only bounded actual PDF bytes are accepted and page limits cannot be bypassed',()=>{
 assert.equal(r.validateResearchPdf(pdfBytes(),'Own.PDF'),true)
 assert.throws(()=>r.validateResearchPdf(pdfBytes('<html>not PDF</html>'),'fake.pdf'))
 assert.throws(()=>r.validateResearchPdf(pdfBytes(),'archive.zip'))
 assert.throws(()=>r.validateResearchPdf(new ArrayBuffer(0),'empty.pdf'))
 assert.throws(()=>r.validateResearchPdf(pdfBytes(),'own.pdf',1))
 assert.throws(()=>r.validateResearchPdf(new ArrayBuffer(15*1024*1024+1),'large.pdf'))
 assert.throws(()=>r.validateResearchPdf(new Uint8Array([1,2,3]),'false.pdf'))
 for(const pages of [0,-1,151,NaN,Infinity,2.5])assert.throws(()=>r.validateResearchPages(pages))
 assert.equal(r.validateResearchPages(150),150)
})

test('read position, source page, bookmarks and private notes survive a metadata reload',()=>{
 assert.deepEqual(clone(r.parseResearchState(JSON.stringify(state))),state)
 assert.equal(r.initialResearchState().activeId,r.RESEARCH_DEMO_ID)
 assert.equal(r.RESEARCH_DEMO_PAGES.length,2)
 assert.ok(r.RESEARCH_DEMO_PAGES.every(page=>page.includes('приклад')))
 const changed={...state,sources:[{...document,lastPage:900,bookmarks:[0,2,2,-3,13,'4',12]}]}
 const result=r.parseResearchState(JSON.stringify(changed))
 assert.equal(result.sources[0].lastPage,12)
 assert.deepEqual(clone(result.sources[0].bookmarks),[2,12])
})

test('corrupt storage, foreign source IDs and impossible excerpt pages do not enter the studio',()=>{
 for(const raw of [null,'{','[]',JSON.stringify({version:2,sources:[],excerpts:[]}), ' '.repeat(1_500_001)])assert.equal(r.parseResearchState(raw).sources.length,0)
 const forged={...state,sources:[document,document,{...document,id:'constructor'}],excerpts:[excerpt,excerpt,{...excerpt,id:'foreign',sourceId:'someone-elses-book'},{...excerpt,id:'wrong-page',page:13}],activeId:'someone-elses-book'}
 const result=r.parseResearchState(JSON.stringify(forged))
 assert.equal(result.sources.length,1);assert.equal(result.excerpts.length,1);assert.equal(result.activeId,r.RESEARCH_DEMO_ID)
 assert.equal(r.cleanResearchExcerpt({...excerpt,id:'__proto__'}),null)
 assert.equal(r.cleanResearchExcerpt({...excerpt,quote:'\u0000bad'}),null)
 assert.equal(r.cleanResearchExcerpt({...excerpt,quote:' '.repeat(50)}),null)
 assert.equal(r.cleanResearchExcerpt({...excerpt,note:'x'.repeat(3001)}),null)
 assert.equal(r.cleanResearchExcerpt({...excerpt,createdAt:'not a date'}),null)
 assert.equal(r.cleanResearchExcerpt({...excerpt,page:0}),null)
})

test('source and excerpt limits bound restored data without mixing page references',()=>{
 const sources=Array.from({length:50},(_,i)=>({...document,id:`source-${i}`}))
 const excerpts=Array.from({length:300},(_,i)=>({...excerpt,id:`quote-${i}`,sourceId:'source-0'}))
 const result=r.parseResearchState(JSON.stringify({...state,sources,excerpts}))
 assert.equal(result.sources.length,5);assert.equal(result.excerpts.length,200)
 const demoQuote={...excerpt,sourceId:r.RESEARCH_DEMO_ID,page:3}
 assert.equal(r.parseResearchState(JSON.stringify({...state,excerpts:[demoQuote]})).excerpts.length,0)
})

test('search finds Ukrainian text across pages with literal queries and bounded output',()=>{
 const result=r.searchResearchPages(['Тут немає збігу.','Альтернативна вартість. ВАРТІСТЬ вибору.'],'вартість')
 assert.equal(result.length,2);assert.equal(result[0].page,2);assert.ok(result[0].snippet.includes('Альтернативна'))
 assert.equal(r.searchResearchPages(['[a-z]+ is a literal.'],'[a-z]+').length,1)
 assert.equal(r.searchResearchPages(['short'],'s').length,0)
 assert.equal(r.searchResearchPages(['aa '.repeat(200)],'aa').length,80)
 assert.equal(r.searchResearchPages([...Array(150).fill('none'),'secret beyond page 150'],'secret').length,0)
 assert.equal(r.searchResearchPages(['x'.repeat(80000)+'hidden'],'hidden').length,0)
})

test('highlight segmentation preserves original text and never interprets HTML as markup',()=>{
 const body='<img src=x onerror=alert(1)> ВАРТІСТЬ та вартість.'
 const segments=r.researchTextSegments(body,'вартість')
 assert.equal(segments.map(s=>s.text).join(''),body);assert.equal(segments.filter(s=>s.hit).length,2)
 assert.equal(segments[0].text,'<img src=x onerror=alert(1)> ')
 assert.equal(r.cleanResearchExcerpt({...excerpt,quote:body}).quote,body)
 const all=r.researchTextSegments('aA '.repeat(200),'aa')
 assert.equal(all.filter(s=>s.hit).length,100);assert.equal(all.map(s=>s.text).join(''),'aA '.repeat(200))
})

test('plain text export retains attribution, page and own thought without changing stored notes',()=>{
 const before=JSON.stringify(excerpt),exported=r.exportResearchExcerpts([excerpt])
 assert.ok(exported.includes('My research.pdf · с. 7'));assert.ok(exported.includes(excerpt.quote));assert.ok(exported.includes(`Моя нотатка: ${excerpt.note}`));assert.equal(JSON.stringify(excerpt),before)
 assert.equal(r.exportResearchExcerpts([]),'')
})

function memoryDatabase(){const records=new Map();let writes=0;return {records,get writes(){return writes},open(){const request={result:{objectStoreNames:{contains:()=>true},close(){},transaction(_name,mode){const tx={objectStore(){return {put(record){assert.equal(mode,'readwrite');writes++;records.set(record.id,{...record,bytes:record.bytes.slice(0)});queueMicrotask(()=>tx.oncomplete?.())},get(id){const read={};queueMicrotask(()=>{read.result=records.get(id);read.onsuccess?.()});return read},delete(id){assert.equal(mode,'readwrite');writes++;records.delete(id);queueMicrotask(()=>tx.oncomplete?.())}}}};return tx}}};queueMicrotask(()=>request.onsuccess?.());return request}}}

test('binary persistence waits for the transaction and can restore and remove only its source',async()=>{
 const storage=memoryDatabase(),local=library({indexedDB:storage}),bytes=pdfBytes()
 await local.storeResearchPdf('own-pdf',bytes);assert.equal(storage.writes,1)
 const restored=await local.readResearchPdf('own-pdf');assert.equal(new TextDecoder().decode(restored),'%PDF-1.7\n')
 assert.equal(await local.readResearchPdf('missing'),null);assert.equal(await local.readResearchPdf('__proto__'),null)
 await assert.rejects(local.storeResearchPdf('constructor',bytes))
 await local.deleteResearchPdf('own-pdf');assert.equal(await local.readResearchPdf('own-pdf'),null)
 await assert.rejects(r.storeResearchPdf('own-pdf',bytes),/сховище/)
})

test('reader exposes only local bytes, non-active canvas/text and explicit retained-data export',()=>{
 const ui=readFileSync(new URL('../src/components/student/MaxResearchStudio.tsx',import.meta.url),'utf8')
 assert.match(ui,/data:new Uint8Array\(buffer\.slice\(0\)\)/)
 for(const setting of ['isEvalSupported:false','enableXfa:false','useWorkerFetch:false','useWasm:false','disableAutoFetch:true','disableStream:true','disableRange:true'])assert.ok(ui.includes(setting),setting)
 assert.doesNotMatch(ui,/dangerouslySetInnerHTML|\beval\s*\(|\bfetch\s*\(|iframe|AnnotationLayer|ScriptingManager|\.getJSActions\s*\(|\.getAttachments\s*\(/)
 assert.match(ui,/contains\(selected\.anchorNode\)/);assert.match(ui,/contains\(selected\.focusNode\)/)
 assert.match(ui,/onCapture\(e\)/);assert.match(ui,/disabled=\{!state\.excerpts\.length\}/)
 assert.match(ui,/Збережені матеріали можна читати й експортувати на будь-якому тарифі/)
})

test('real synthetic PDF metadata and text can be read with active content never executed',async()=>{
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs')
 const bytes=new Uint8Array(readFileSync(new URL('./fixtures/max-research-study.pdf',import.meta.url)))
 globalThis.__xelayResearchFixtureActive=false
 const task=pdfjs.getDocument({data:bytes,isEvalSupported:false,enableXfa:false,useWorkerFetch:false,useWasm:false,useSystemFonts:true,stopAtErrors:true,disableAutoFetch:true,disableStream:true,disableRange:true})
 try{const pdf=await task.promise;assert.equal(pdf.numPages,2);r.validateResearchPages(pdf.numPages)
 const pages=[];for(let i=1;i<=pdf.numPages;i++){const page=await pdf.getPage(i);const content=await page.getTextContent();pages.push(content.items.filter(item=>'str'in item).map(item=>item.str).join(' '))}
 assert.ok(pages[0].includes('Opportunity cost'));assert.ok(pages[1].includes('Demand changes'))
 assert.equal(r.searchResearchPages(pages,'Demand')[0].page,2);assert.equal(globalThis.__xelayResearchFixtureActive,false)
 }finally{await task.destroy();delete globalThis.__xelayResearchFixtureActive}
})
