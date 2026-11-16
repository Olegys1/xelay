import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import ts from 'typescript'

const module={exports:{}}
const script=ts.transpileModule(readFileSync(new URL('../src/lib/maxCourseworkStudio.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
vm.runInNewContext(script,{module,exports:module.exports,Date,Number,Math,JSON,URL,Set,Map})
const m=module.exports
const today='2026-11-16',now='2026-11-16T12:00:00.000Z'
const project=()=>m.createCourseworkProject('own-project','Моя курсова','coursework',today,now)
const source=(id,title='Джерело')=>({id,title,author:'Автор',year:'2026',url:'https://example.org/article',quote:'Корисна теза',page:null,captureId:null})
const plain=v=>JSON.parse(JSON.stringify(v))
const capture=(id='capture-a')=>({id,title:'Теза',sourceTitle:'Навчальний документ',page:7,quote:'Пошук інформації потребує часу.',note:'Використати у вступі.',createdAt:now})

test('project templates produce real editable outlines and reject invalid IDs/dates',()=>{
 for(const kind of ['coursework','report','presentation']){
  const p=m.createCourseworkProject('project-'+kind,' Назва ',kind,today,now)
  assert.equal(p.title,'Назва');assert.ok(p.sections.length>=4);assert.equal(new Set(p.sections.map(s=>s.id)).size,p.sections.length)
 }
 assert.throws(()=>m.createCourseworkProject('__proto__','Назва','coursework',today,now))
 assert.throws(()=>m.createCourseworkProject('p','Назва','coursework','2026-02-30',now))
 assert.throws(()=>m.createCourseworkProject('p',' ','coursework',today,now))
 assert.equal(m.courseworkWordCount(' Перша теза\nдруга теза. '),4)
})

test('strict storage roundtrip preserves text, sources and empty collections',()=>{
 const state=m.initialCourseworkState(today);state.projects[0].sections[0].body+='\nМій власний рядок.'
 const saved=m.prepareCourseworkStorage(state)
 assert.deepEqual(plain(m.parseCourseworkState(saved.json,today)),plain(state))
 assert.deepEqual(plain(m.parseCourseworkState(JSON.stringify({version:1,projects:[],selectedId:''}),today)),{version:1,projects:[],selectedId:''})
 for(const bad of ['{broken',JSON.stringify({...state,version:2}),JSON.stringify({...state,projects:[state.projects[0],state.projects[0]]})])assert.equal(m.parseCourseworkState(bad,today).projects[0].id,'example-coursework')
})

test('source numbers remain stable across removal and addition',()=>{
 let p=m.addCourseworkSource(project(),source('s1'));p=m.addCourseworkSource(p,source('s2'));p=m.addCourseworkSource(p,source('s3'))
 p=m.removeCourseworkSource(p,'s2');p=m.addCourseworkSource(p,source('s4'))
 assert.deepEqual(plain(p.sources.map(s=>s.number)),[1,3,4])
 p=m.insertCourseworkCitation(p,p.sections[0].id,'s3')
 assert.match(p.sections[0].body,/\[3\]$/)
 assert.throws(()=>m.removeCourseworkSource(p,'s3'),/приберіть посилання/)
 assert.throws(()=>m.addCourseworkSource(p,source('s4','Інша назва')),/ідентифікатором/)
})

test('research fragments keep quote/page, attach once and use explicit citation anchors',()=>{
 const c=capture();let p=m.attachCourseworkCapture(project(),c)
 assert.equal(p.sources.length,1);assert.equal(p.sources[0].captureId,c.id);assert.equal(p.sources[0].page,7)
 assert.ok(p.sources[0].quote.includes(c.quote));assert.ok(p.sources[0].quote.includes(c.note))
 assert.strictEqual(m.attachCourseworkCapture(p,{...c,note:'Змінена нотатка'}),p)
 p=m.insertCourseworkCitation(p,p.sections[0].id,p.sources[0].id)
 assert.equal(p.sections[0].body,'[1, с. 7]')
 const long1='a'.repeat(79)+'1',long2='a'.repeat(79)+'2'
 p=m.attachCourseworkCapture(p,capture(long1));p=m.attachCourseworkCapture(p,capture(long2))
 assert.equal(new Set(p.sources.map(s=>s.id)).size,3)
 assert.equal(m.attachCourseworkCapture(project(),{...c,quote:'а'.repeat(6000),note:'б'.repeat(4000)}).sources[0].quote.length,10015)
 assert.throws(()=>m.attachCourseworkCapture(project(),{...c,page:0}))
})

test('version snapshots and restore are independent; current work is backed up first',()=>{
 let p=project();p.sections[0].body='Перша версія'
 p=m.saveCourseworkVersion(p,'v1','До змін',now)
 p.sections[0].body='Новий важливий текст';p=m.addCourseworkSource(p,source('s1'))
 assert.equal(p.versions[0].sections[0].body,'Перша версія')
 const restored=m.restoreCourseworkVersion(p,'v1','backup','2026-11-16T13:00:00.000Z')
 assert.equal(restored.sections[0].body,'Перша версія');assert.equal(restored.sources.length,0)
 assert.equal(restored.versions[0].sections[0].body,'Новий важливий текст');assert.equal(restored.versions[0].sources.length,1)
 restored.sections[0].body='Ще зміна';assert.equal(restored.versions[1].sections[0].body,'Перша версія')
 assert.throws(()=>m.restoreCourseworkVersion(p,'missing','backup',now))
 assert.equal(p.sections[0].body,'Новий важливий текст')
})

test('version retention is bounded without discarding current work',()=>{
 let p=project();for(let i=0;i<12;i++)p=m.saveCourseworkVersion(p,'version-'+i,'Версія '+i,now)
 assert.equal(p.versions.length,8);assert.equal(p.versions[0].id,'version-11');assert.equal(p.versions[7].id,'version-4')
 assert.throws(()=>m.saveCourseworkVersion(p,'version-11','Повтор',now))
})

test('storage quota trims oldest snapshots explicitly and keeps project content unchanged',()=>{
 const projects=[]
 for(let index=0;index<4;index++){
  let p=m.createCourseworkProject('p'+index,'Робота '+index,'coursework',today,now)
  p.sections=Array.from({length:8},(_,i)=>({id:'s'+i,title:'Розділ '+i,body:'а'.repeat(12000)}))
  for(let v=0;v<8;v++)p=m.saveCourseworkVersion(p,'v'+v,'Чернетка '+v,`2026-11-${String(10+v).padStart(2,'0')}T12:00:00.000Z`)
  projects.push(p)
 }
 const state={version:1,projects,selectedId:'p0'},before=JSON.stringify(state),saved=m.prepareCourseworkStorage(state),parsed=m.parseCourseworkState(saved.json,today)
 assert.ok(saved.dropped>0);assert.ok(saved.json.length<=m.COURSEWORK_LIMITS.storageCharacters)
 assert.equal(JSON.stringify(state),before);assert.equal(parsed.projects.length,4);assert.equal(parsed.projects[0].sections[0].body.length,12000)
 assert.ok(parsed.projects.reduce((n,p)=>n+p.versions.length,0)<32)
})

test('unsafe source URLs and invalid nested data are rejected before rendering or storage',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,evil','https://user:pass@example.org/','https://example.org/\nother'])assert.equal(m.courseworkUrl(url),null)
 assert.equal(m.courseworkUrl('https://example.org/a?b=2'),'https://example.org/a?b=2')
 assert.throws(()=>m.addCourseworkSource(project(),{...source('s1'),url:'javascript:alert(1)'}))
 const p=project();p.sections[0].body='а'.repeat(12001);assert.throws(()=>m.normalizeCourseworkProject(p))
 const p2=project();p2.milestones=[{id:'m',title:'Крок',due:'2026-02-30',done:false}];assert.throws(()=>m.normalizeCourseworkProject(p2))
 const p3=project();p3.sources=[{...source('s1'),number:1},{...source('s2'),number:1}];assert.throws(()=>m.normalizeCourseworkProject(p3))
})

test('exports preserve citations and stable numbering while neutralizing executable HTML',()=>{
 let p=project();p.title='<img src=x onerror=alert(1)>';p.sections[0].body='<script>alert("x")</script> & текст [3]'
 p=m.addCourseworkSource(p,source('s1'));p=m.addCourseworkSource(p,source('s2'));p=m.addCourseworkSource(p,source('s3','Джерело <em>3</em>'));p=m.removeCourseworkSource(p,'s2')
 const html=m.exportCoursework(p,'html'),md=m.exportCoursework(p,'markdown'),json=JSON.parse(m.exportCoursework(p,'json'))
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img src=x'));assert.ok(html.includes('&lt;script&gt;'))
 assert.match(html,/default-src 'none'/);assert.match(html,/<li value="3">/);assert.ok(html.includes('&lt;em&gt;3&lt;/em&gt;'))
 assert.ok(md.includes('[3]'));assert.ok(md.includes('3. Автор. Джерело <em>3</em>. 2026'));assert.equal(json.format,'xelay-coursework-v1');assert.equal(json.project.sections[0].body,p.sections[0].body)
})

test('UI preserves export and reading with disabled access and flushes local changes on pagehide',()=>{
 const ui=readFileSync(new URL('../src/components/student/MaxCourseworkStudio.tsx',import.meta.url),'utf8')
 assert.match(ui,/if\(!enabled\|\|!project\)return false/)
 assert.match(ui,/window\.addEventListener\('pagehide',flush\)/)
 assert.match(ui,/disabled=\{!project\} onClick=\{\(\)=>project&&downloadProject/)
 assert.ok(!/dangerouslySetInnerHTML|fetch\(|supabase|OpenAI|apiKey/.test(ui))
})
