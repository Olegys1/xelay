import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as textImport from '../../src/lib/teachingQuestionImportText.ts'
const source=readFileSync(new URL('../../src/components/teaching/TeachingQuestionImportPanel.tsx',import.meta.url),'utf8')
const nodes=value=>value==null||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...nodes(value.props?.children)]
const text=value=>value==null||typeof value==='boolean'?'':Array.isArray(value)?value.map(text).join(' '):typeof value==='object'?text(value.props?.children):String(value)
const jsx=(type,props,key)=>({type,props:props||{},key})
function harness({extract,props={},clipboard}={}){
 const cells=[],effects=[];let index=0,dirty=false,mounted=true,tree,component
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
 const hooks={useState(initial){const i=index++;if(!cells[i]){const cell={value:typeof initial==='function'?initial():initial};cell.set=next=>{if(!mounted)return;const v=typeof next==='function'?next(cell.value):next;if(!Object.is(v,cell.value)){cell.value=v;dirty=true}};cells[i]=cell}return[cells[i].value,cells[i].set]},useRef(initial){return cells[index++]??={current:initial}},useEffect(fn,deps){const i=index++;if(!cells[i]||!same(cells[i].deps,deps)){const prior=cells[i];cells[i]={deps,cleanup:prior?.cleanup};effects.push(()=>{prior?.cleanup?.();cells[i].cleanup=fn()})}}}
 const module={exports:{}}
 const imports={react:hooks,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'lucide-react':new Proxy({},{get:(_,key)=>String(key)}),'../../lib/teachingQuestionImportText':textImport,'../../lib/teachingQuestionImportFiles':{QUESTION_IMPORT_ACCEPT:'.txt,.docx',QUESTION_IMPORT_MAX_FILE_BYTES:10*1024*1024,QUESTION_IMPORT_MAX_BATCH_BYTES:20*1024*1024,QUESTION_IMPORT_MAX_FILES:10,extractTeachingQuestionFile:extract|| (async file=>({name:file.name,text:file.text,format:'auto',notes:[]}))},'./TeachingUI':{TeachingButton:'TeachingButton',TeachingField:'TeachingField',teachingInput:'input'},'./TeachingQuestionEditor':{TeachingQuestionEditor:'TeachingQuestionEditor',TEST_QUESTION_LABELS:{choice:'Одна',boolean:'Так/ні',essay:'Есе'}},'./teaching-question-import.css':{}}
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
 runInNewContext(code,{module,exports:module.exports,crypto,structuredClone,TextEncoder,Error,Promise,HTMLTextAreaElement:class{},HTMLInputElement:class{},navigator:{clipboard},require(name){assert.ok(Object.hasOwn(imports,name),name);return imports[name]}})
 component=module.exports.TeachingQuestionImportPanel
 const calls=[],busy=[];const properties={busy:false,onCancel(){},onBusyChange:value=>busy.push(value),onConfirm:(questions,category)=>calls.push({questions,category}),...props}
 function render(){if(!mounted)return tree;for(let pass=0;pass<30;pass++){index=0;dirty=false;tree=component(properties);effects.splice(0).forEach(fn=>fn());if(!dirty)return tree}throw Error('Hooks did not settle')}
 render();return{get tree(){return tree},calls,busy,render,async flush(){for(let i=0;i<20;i++){await Promise.resolve();render()}},unmount(){mounted=false;for(const cell of cells)cell?.cleanup?.()},props:properties}
}
const button=(run,label)=>{const node=nodes(run.tree).find(node=>node.type==='TeachingButton'&&text(node).includes(label));assert.ok(node,label);return node}
const confirm=run=>button(run,'Підтвердити й додати')
const reviewed=run=>{const input=nodes(run.tree).find(node=>node.type==='input'&&node.props.type==='checkbox');assert.ok(input);input.props.onChange({target:{checked:true}});run.render()}
const addExample=run=>{button(run,'Спробувати приклад').props.onClick();run.render()}

test('no import writes on loading, parsing or preview; explicit review unlocks confirmation',()=>{
 const run=harness();assert.equal(run.calls.length,0);addExample(run);assert.equal(run.calls.length,0)
 assert.equal(confirm(run).props.disabled,true);reviewed(run);assert.equal(confirm(run).props.disabled,false)
 confirm(run).props.onClick();assert.equal(run.calls.length,1);assert.equal(run.calls[0].questions.length,3);assert.equal(run.calls[0].questions[0].answer,'a1')
 run.unmount()
})
test('editing a parsed key invalidates approval and blocks invalid answer IDs',()=>{
 const run=harness();addExample(run);reviewed(run)
 const editor=nodes(run.tree).find(node=>node.type==='TeachingQuestionEditor')
 editor.props.onChange({answer:'unknown'});run.render()
 assert.equal(confirm(run).props.disabled,true);assert.equal(run.calls.length,0)
 assert.match(text(run.tree),/Оберіть правильну відповідь/)
 run.unmount()
})
test('source edits require a new preview instead of committing stale questions',()=>{
 const run=harness();addExample(run);reviewed(run)
 const area=nodes(run.tree).find(node=>node.type==='textarea')
 area.props.onChange({target:{value:'Different prompt'}});run.render()
 assert.match(text(run.tree),/Оновіть попередній перегляд/)
 assert.equal(nodes(run.tree).some(node=>node.type==='TeachingButton'&&text(node).includes('Підтвердити й додати')&&!node.props.disabled),false)
 assert.equal(run.calls.length,0);run.unmount()
})
test('multiple files are additive and any failed source blocks the whole batch until explicitly removed',async()=>{
 const run=harness({extract:async file=>{if(file.name==='bad.docx')throw Error('Bad content');return{name:file.name,text:textImport.QUESTION_IMPORT_TEXT_TEMPLATE,format:'auto',notes:[]}}})
 const input=nodes(run.tree).find(node=>node.type==='input'&&node.props.type==='file')
 input.props.onChange({target:{files:[{name:'one.txt',size:100},{name:'bad.docx',size:100}]}});await run.flush()
 assert.equal(run.calls.length,0);assert.equal(confirm(run).props.disabled,true);assert.match(text(run.tree),/Bad content/)
 const remove=nodes(run.tree).find(node=>node.type==='button'&&node.props['aria-label']==='Прибрати джерело bad.docx')
 remove.props.onClick();run.render();reviewed(run);assert.equal(confirm(run).props.disabled,false)
 confirm(run).props.onClick();assert.equal(run.calls[0].questions.length,3);run.unmount()
})
test('overlapping selections are locked and unmount prevents async results attaching to a new scope',async()=>{
 let resolve;const pending=new Promise(accept=>{resolve=accept});let reads=0
 const run=harness({extract:()=>{reads++;return pending}}),input=nodes(run.tree).find(node=>node.type==='input'&&node.props.type==='file')
 input.props.onChange({target:{files:[{name:'one.txt',size:10}]}});input.props.onChange({target:{files:[{name:'two.txt',size:10}]}});run.render()
 assert.equal(reads,1);assert.equal(run.calls.length,0);run.unmount();resolve({name:'one.txt',text:textImport.QUESTION_IMPORT_TEXT_TEMPLATE,format:'auto',notes:[]});await run.flush();assert.equal(run.calls.length,0)
})
test('drop and paste use the same local reader; clipboard is never read automatically',async()=>{
 let clipboardReads=0;const run=harness({clipboard:{readText:async()=>{clipboardReads++;return textImport.QUESTION_IMPORT_TEXT_TEMPLATE}}})
 assert.equal(clipboardReads,0)
 let prevented=0;run.tree.props.onPaste({target:{},clipboardData:{files:[],getData:()=>textImport.QUESTION_IMPORT_TEXT_TEMPLATE},preventDefault:()=>prevented++});run.render()
 assert.equal(prevented,1);assert.equal(clipboardReads,0);assert.equal(run.calls.length,0)
 const drop=nodes(run.tree).find(node=>node.props['aria-label']==='Додати файли тесту')
 drop.props.onDrop({preventDefault(){},dataTransfer:{files:[{name:'dropped.txt',size:10,text:textImport.QUESTION_IMPORT_TEXT_TEMPLATE}]}});await run.flush()
 assert.match(text(run.tree),/Додано джерел:\s+2/);assert.equal(run.calls.length,0);run.unmount()
})
test('direct-to-test mode adds only to the draft editor and does not claim a bank save',()=>{
 const run=harness({props:{destination:'test'}});addExample(run)
 assert.match(text(run.tree),/Імпорт не публікує його автоматично/)
 assert.match(text(confirm(run)),/у тест/)
 assert.equal(text(run.tree).includes('До банку буде додано'),false)
 reviewed(run);confirm(run).props.onClick();assert.equal(run.calls[0].category,'');run.unmount()
})
