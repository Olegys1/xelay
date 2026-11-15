import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
const source=readFileSync(new URL('../../src/lib/teachingQuestionImportPdf.ts',import.meta.url),'utf8')
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
function pdfHarness({pages=1,content=[{str:'1. Capital of Ukraine?',transform:[1,0,0,1,50,700],hasEOL:true},{str:'A) Kyiv',transform:[1,0,0,1,50,680],hasEOL:true},{str:'B) Lviv',transform:[1,0,0,1,50,660],hasEOL:true},{str:'ANSWER: A',transform:[1,0,0,1,50,640],hasEOL:true}],error,pending=false}={}){
 const module={exports:{}},calls=[],state={destroyed:0,cleaned:0,cleared:false,timer:null}
 const pdf={GlobalWorkerOptions:{},getDocument(options){calls.push(options);return{promise:pending?new Promise(()=>{}):error?Promise.reject(error):Promise.resolve({numPages:pages,getPage:async()=>({getTextContent:async()=>({items:content}),cleanup:()=>state.cleaned++})}),destroy:async()=>{state.destroyed++}}}}
 runInNewContext(code,{module,exports:module.exports,Uint8Array,TextDecoder,TextEncoder,Error,Promise,setTimeout:fn=>{state.timer=fn;return 1},clearTimeout:()=>{state.cleared=true},require(name){if(name==='pdfjs-dist/build/pdf.worker.min.mjs?url')return '/assets/pdf.worker-static.mjs';if(name==='pdfjs-dist')return pdf;if(name==='./teachingQuestionImportText.ts')return{QUESTION_IMPORT_MAX_TEXT:2*1024*1024};throw Error('Unexpected import '+name)}})
 return{read:module.exports.extractQuestionPdfText,pdf,calls,state}
}
const bytes=()=>new TextEncoder().encode('%PDF-1.4\nfixture').buffer

test('PDF worker receives a static URL string, and extraction uses only local data/text APIs',async()=>{
 const run=pdfHarness(),text=await run.read(bytes())
 assert.equal(run.pdf.GlobalWorkerOptions.workerSrc,'/assets/pdf.worker-static.mjs')
 assert.equal(typeof run.pdf.GlobalWorkerOptions.workerSrc,'string')
 assert.equal(run.calls.length,1)
 assert.equal(run.calls[0].useWorkerFetch,false)
 assert.equal(run.calls[0].disableFontFace,true)
 assert.equal(run.calls[0].enableXfa,false)
 assert.equal(run.calls[0].useWasm,false)
 assert.ok(run.calls[0].data instanceof Uint8Array)
 assert.equal(Object.hasOwn(run.calls[0],'url'),false)
 assert.match(text,/Capital of Ukraine\?/);assert.match(text,/ANSWER: A/)
 assert.equal(run.state.cleaned,1);assert.equal(run.state.destroyed,1);assert.equal(run.state.cleared,true)
})
test('PDF scans, excessive pages, passwords and stalled parsing report actionable errors and destroy the task',async()=>{
 for(const [config,pattern]of [[{content:[]},/не знайдено тексту/],[{pages:101},/100 сторінок/],[{error:Object.assign(new Error('Password'),{name:'PasswordException'})},/паролем/]]){
  const run=pdfHarness(config);await assert.rejects(run.read(bytes()),pattern);assert.equal(run.state.destroyed,1);assert.equal(run.state.cleared,true)
 }
 const pending=pdfHarness({pending:true}),result=pending.read(bytes());await Promise.resolve();await Promise.resolve();await Promise.resolve();assert.equal(typeof pending.state.timer,'function');pending.state.timer();await assert.rejects(result,/надто довго/);assert.ok(pending.state.destroyed>=1)
})
