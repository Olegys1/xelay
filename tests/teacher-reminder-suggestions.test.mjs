import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'
const api={},source=readFileSync(new URL('../src/lib/teacherAssistantTools.ts',import.meta.url),'utf8')
runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:api,Date})
test('teacher reminders use authorized live report, reject past deadlines and only prepare suggestions',()=>{
 const now=Date.parse('2026-11-26T12:00:00Z'),report={groups:[{id:'a',name:'Група А',pendingReviews:2,upcoming:[{title:'Тест',dueAt:'2026-11-26T14:00:00Z'},{title:'Тест',dueAt:'2026-11-26T14:00:00Z'},{title:'Минулий',dueAt:'2026-11-25T14:00:00Z'},{title:'Invalid',dueAt:'bad'}]},{id:'b',name:'Група Б',pendingReviews:0,upcoming:[]}]}
 const before=JSON.stringify(report),suggestions=api.teacherReminderSuggestions(report,now)
 assert.equal(suggestions.length,2);assert.equal(suggestions[0].dueAt,'2026-11-26T13:00:00.000Z');assert.match(suggestions[0].reason,/2/)
 assert.equal(suggestions[1].dueAt,'2026-11-26T13:00:00.000Z');assert.equal(JSON.stringify(report),before)
 assert.ok(suggestions.every(s=>!s.title.includes('Група Б')&&s.title.length<=180))
 const many=api.teacherReminderSuggestions({groups:Array.from({length:30},(_,id)=>({id:String(id),name:'x'.repeat(300),pendingReviews:1,upcoming:[]}))},now)
 assert.equal(many.length,20);assert.ok(many.every(x=>x.title.length<=180))
})
