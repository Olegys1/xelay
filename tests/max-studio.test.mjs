import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxStudio.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date,Number,JSON,Set})
const m=module.exports
const capture=id=>({id,title:'Моя теза',sourceTitle:'Мій PDF',page:2,quote:'Точна цитата',note:'Власна думка',createdAt:'2026-11-16T07:00:00.000Z'})
test('capture inbox accepts only bounded plain data, deduplicates and retains last hundred sources',()=>{
 const c=capture('research-1'),copy=m.normalizeMaxCapture({...c,hiddenKey:'not copied'})
 assert.deepEqual(Object.keys(copy).sort(),Object.keys(c).sort())
 assert.equal(m.parseMaxInbox(JSON.stringify([c,c])).length,1)
 assert.equal(m.parseMaxInbox(JSON.stringify(Array.from({length:120},(_,i)=>capture('source-'+i)))).length,100)
 for(const bad of [{...c,page:151},{...c,page:0},{...c,id:'__proto__'},{...c,quote:'x'.repeat(12001)},{...c,note:'x'.repeat(4001)},{...c,createdAt:'invalid'}])assert.equal(m.normalizeMaxCapture(bad),null)
 assert.equal(m.parseMaxInbox('{broken').length,0)
 assert.equal(m.parseMaxInbox('x'.repeat(1500001)).length,0)
})
test('Max owns a distinct connected workspace while retaining readonly access and lazy loading',()=>{
 const shell=readFileSync(new URL('../src/components/student/MaxLearningStudio.tsx',import.meta.url),'utf8')
 const preview=readFileSync(new URL('../src/components/student/StudentWorkspacePreview.tsx',import.meta.url),'utf8')
 assert.match(shell,/const enabled=plan==='max'/)
 assert.match(shell,/<MaxResearchStudio enabled=\{enabled\} onCapture=\{capture\}/)
 assert.match(shell,/<MaxCourseworkStudio enabled=\{enabled\} capturedSources=\{inbox\}/)
 assert.match(shell,/lazy\(\(\)=>import\('\.\/MaxResearchStudio'\)\)/)
 assert.match(shell,/normalizeMaxCapture\(value\)/)
 assert.match(preview,/value === 'max' \? 'session' : value === 'plus' \? 'practice' : 'tools'/)
 assert.doesNotMatch(shell,/fetch\(|supabase\.|dangerouslySetInnerHTML|api\/|iframe/)
})
