import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync,existsSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import React from 'react'
import {renderToPipeableStream} from 'react-dom/server'
import {PassThrough} from 'node:stream'
import postcss from 'postcss'

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url),modules=new Map()
function load(relative){
 const file=path.isAbsolute(relative)?relative:path.join(root,relative)
 if(modules.has(file))return modules.get(file)
 const exports={};modules.set(file,exports)
 const source=readFileSync(file,'utf8')
 const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
 vm.runInNewContext(code,{exports,Date,Math,Number,JSON,Set,Map,TextEncoder,TextDecoder,URL,Blob,ArrayBuffer,Uint8Array,Promise,crypto,require(id){
  if(id.endsWith('.css'))return{}
  if(!id.startsWith('.'))return require(id)
  if(id.endsWith('.js'))id=id.slice(0,-3)
  const base=path.resolve(path.dirname(file),id),candidate=['.tsx','.ts','.mjs'].map(ext=>base+ext).find(existsSync)
  if(!candidate)throw Error('Unknown local module '+id)
  return load(candidate)
 }},{filename:file})
 return exports
}
const {default:Studio}=load('src/components/student/MaxLearningStudio.tsx')
const {MaxTutorAssistant}=load('src/components/student/MaxTutorAssistant.tsx')
const scope={userId:'layout-test-owner',sessionId:'layout-test-session'}
function studio(initialTab){return new Promise((resolve,reject)=>{const element=React.createElement(Studio,{initialTab,plan:'max',production:{scope,canEdit:true,renderTutor:props=>React.createElement(MaxTutorAssistant,{scope,productionMode:true,enabled:false,startView:props.startView,onOpenPreparation:props.onOpenPreparation,profileDisplayName:'Олег',initialState:{version:1,runs:[],activeRunId:''}})}});const stream=renderToPipeableStream(element,{onAllReady(){const output=new PassThrough();let html='';output.on('data',chunk=>{html+=chunk});output.on('end',()=>resolve(html));output.on('error',reject);stream.pipe(output)},onError:reject})})}

test('the active learning studio mounts the real composer beside a named, collapsible navigation and keeps help in its toolbar',async()=>{
 const html=await studio('assistant')
 const control=html.match(/class="mls-sidebar-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="([^"]+)"/)
 assert.ok(control,'the visible menu toggle identifies the expanded navigation')
 assert.ok(html.includes(`id="${control[1]}"`))
 for(const name of ['Чат','Матеріали','Підготовка','Великі роботи','Сценарії балів'])assert.ok(html.includes(`aria-label="${name}"`))
 assert.match(html,/class="mls-body-toolbar"/)
 assert.match(html,/class="slg-launcher"/)
 assert.ok(html.indexOf('mls-coach-inline')<html.indexOf('mls-assistant-pane'),'coach controls precede the chat in document flow')
 assert.match(html,/Налаштувати помічника поруч/)
 assert.match(html,/class="mls-assistant-pane"(?![^>]*hidden)/)
 assert.match(html,/<textarea/,'the real assistant input survives the workspace layout')
 assert.doesNotMatch(html,/type="password"/,'layout never exposes a model credential form')
})

test('switching the studio section keeps the assistant mounted but hidden and inert rather than discarding its pending work',async()=>{
 const html=await studio('projects')
 assert.match(html,/class="mls-assistant-pane"[^>]*hidden=""[^>]*inert=""[^>]*display:none/)
 assert.match(html,/<textarea/)
 assert.match(html,/Збережені інструменти/)
})

test('production opens a personal Start canvas with its real composer, and keeps promotional cards outside the workspace',async()=>{
 const html=await studio('overview')
 assert.match(html,/class="mls-production|mls mls-production/)
 assert.doesNotMatch(html,/Місце для роботи|mls-hero-art/)
 assert.match(html,/<details class="mls-archive">/)
 assert.match(html,/aria-label="Старт"[^>]*aria-current="page"/)
 assert.match(html,/Почати навчання з Максом/)
 assert.match(html,/Олег/)
 assert.match(html,/<textarea[^>]*aria-label="Повідомлення навчальному помічнику"/)
})

test('the tools catalogue opens only supported activities and personal activity has no fabricated grade, streak or other-user data',async()=>{
 const apps=await studio('apps'),activity=await studio('activity')
 for(const label of ['Інтерактивний урок','Тест','Картки','Пропуски','Навчальний діалог'])assert.ok(apps.includes(label))
 assert.doesNotMatch(apps,/107 застосунків|Усний іспит|Камера|MP3/)
 assert.match(activity,/Моя активність у Максі/)
 assert.match(activity,/без змін оцінок у журналі/)
 assert.match(activity,/Після першого заняття/)
 assert.doesNotMatch(activity,/Рейтинг групи|Твій streak|99%/)
})

test('personal activity derives checked answers and weak topics from real saved runs and excludes prepared examples',async()=>{
 const {MaxTutorActivity}=load('src/components/student/MaxTutorActivity.tsx'),{createTutorDemo,emptyTutorProgress}=load('src/lib/maxTutor.ts')
 const make=(id,demo,title)=>{const sample=createTutorDemo(id,'quiz');return{id,createdAt:'2026-11-16T10:00:00Z',demo,request:sample.request,bundle:{...sample.bundle,title},progress:emptyTutorProgress()}}
 const own=make('own-activity',false,'Власний збережений тест'),example=make('prepared-activity',true,'Підготовлений приклад, який не рахуємо')
 for(const [index,question]of own.bundle.questions.slice(0,2).entries()){own.progress.answers[question.id]=index===0?question.correctIndex:(question.correctIndex+1)%question.options.length;own.progress.submitted.push(question.id)}
 for(const question of example.bundle.questions){example.progress.answers[question.id]=question.correctIndex;example.progress.submitted.push(question.id)}
 const html=await new Promise((resolve,reject)=>{const stream=renderToPipeableStream(React.createElement(MaxTutorActivity,{owner:'activity-owner',enabled:true,state:{version:1,runs:[own,example],activeRunId:own.id},onOpen(){}}),{onAllReady(){const output=new PassThrough();let text='';output.on('data',chunk=>{text+=chunk});output.on('end',()=>resolve(text));stream.pipe(output)},onError:reject})})
 assert.match(html,/<strong>2<\/strong><span>перевірених відповідей<\/span><small>1<!-- --> правильних/)
 assert.match(html,/Варто повернутися/)
 assert.match(html,/Власний збережений тест/)
 assert.doesNotMatch(html,/Підготовлений приклад, який не рахуємо/)
 assert.match(html,/Додати в обране Власний збережений тест/)
})

function lastBase(css,selector,property){let value;postcss.parse(css).walkRules(rule=>{if(rule.parent.type!=='root'||!rule.selectors.includes(selector))return;rule.walkDecls(property,decl=>{value=decl.value})});return value}
test('workspace containers can use the desktop canvas without clipping their contents, and navigation has a mobile layout',()=>{
 const page=readFileSync(path.join(root,'src/pages/studentLearningPage.css'),'utf8'),studioCss=readFileSync(path.join(root,'src/components/student/maxLearningStudio.css'),'utf8')
 assert.ok(parseInt(lastBase(page,'.slp','max-width'),10)>=1600)
 assert.match(lastBase(page,'.slp','width'),/^calc\(100% - \d+px\)$/)
 assert.equal(lastBase(studioCss,'.mls','overflow'),'visible')
 assert.equal(lastBase(studioCss,'.mls-production > .mls-header','display'),'none','a second studio brand header must not consume the chat viewport')
 assert.equal(lastBase(page,'.slp .mta-chat-title','display'),'none','the semantic page h1 replaces the repeated assistant title')
 assert.match(lastBase(studioCss,'.mls-layout','grid-template-columns'),/minmax\(0,\s*1fr\)/)
 assert.equal(lastBase(studioCss,'.mls-assistant-pane','min-width'),'0')
 assert.equal(lastBase(studioCss,'.mls-production .mls-coach-inline .mtc','position'),'static','the coach must not cover the composer from a fixed viewport corner')
 assert.equal(lastBase(studioCss,'.mls-production .mls-coach-inline .mtc-card','position'),'static')
 let horizontal=false,smallCanvas=false
 postcss.parse(studioCss).walkAtRules('media',media=>{if(!/max-width/.test(media.params))return;media.walkRules(rule=>{if(rule.selector==='.mls-sidebar nav')rule.walkDecls('overflow-x',decl=>{if(decl.value==='auto')horizontal=true})})})
 postcss.parse(page).walkAtRules('media',media=>{if(!/max-width: 700px/.test(media.params))return;media.walkRules(rule=>{if(rule.selector==='.slp')rule.walkDecls('width',decl=>{smallCanvas=decl.value==='calc(100% - 24px)'})})})
 assert.ok(horizontal,'small screens get a scrollable section strip instead of a squeezed sidebar')
 assert.ok(smallCanvas,'mobile retains a small outer gutter without a fixed desktop width')
 assert.match(page,/prefers-reduced-motion/)
})
