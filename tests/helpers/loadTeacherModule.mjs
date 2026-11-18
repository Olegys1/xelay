import{readFileSync}from'node:fs'
import{createRequire}from'node:module'
import{fileURLToPath}from'node:url'
import path from'node:path'
import vm from'node:vm'
import ts from'typescript'
const root=fileURLToPath(new URL('../../',import.meta.url)),native=createRequire(import.meta.url)
export function teacherModuleLoader(overrides={}){
 const cache=new Map()
 function load(file){
  const absolute=path.resolve(root,file)
  if(cache.has(absolute))return cache.get(absolute).exports
  const module={exports:{}};cache.set(absolute,module)
  const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText
  const globals={module,exports:module.exports,Buffer,TextEncoder,TextDecoder,structuredClone,AbortController,AbortSignal,Response,URL,Set,Map,Promise,Date,Number,JSON,atob,btoa,setTimeout,clearTimeout,process:{env:{}},fetch:()=>{throw Error('Live network forbidden')},...overrides}
  globals.require=name=>{if(name==='@supabase/supabase-js')return{createClient(){throw Error('Inject synthetic database')}};if(name.endsWith('/supabase')||name==='./supabase')return{supabase:{auth:{async getSession(){return{data:{session:null},error:null}}}}};if(name.startsWith('.'))return load(path.resolve(path.dirname(absolute),name.replace(/\.js$/,''))+'.ts');return native(name)}
  vm.runInNewContext(code,globals,{filename:absolute});return module.exports
 }
 return load
}
export function apiCall(handler,input,{token,origin='https://www.xelay.ink',method='POST'}={}){
 return new Promise((resolve,reject)=>{
  const req={method,headers:{origin,authorization:'Bearer '+token,'content-type':'application/json'},body:input}
  const res={headers:{},setHeader(name,value){this.headers[name]=value},end(text){this.writableEnded=true;resolve({status:this.statusCode,headers:this.headers,body:JSON.parse(text)})}}
  Promise.resolve(handler(req,res)).catch(reject)
 })
}
export function syntheticTeacherModel(){
 const calls=[];let mode='normal',beforeResponse=null
 const json=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}})
 return{calls,setMode:v=>mode=v,setBeforeResponse:fn=>beforeResponse=fn,async fetcher(url,options){
  if(!String(url).startsWith('https://api.openai.com/v1/'))throw Error('Unexpected outbound URL')
  const payload=JSON.parse(options.body);calls.push({url,payload})
  if(url.endsWith('/moderations'))return json({results:[{flagged:mode==='refused',categories:{}}]})
  if(beforeResponse){const fn=beforeResponse;beforeResponse=null;await fn()}
  if(mode==='network_failure')throw Error('Synthetic network failure')
  const {request:r,context}=JSON.parse(payload.input[0].content[0].text)
  const bundle={version:1,kind:r.kind,title:'Навчальна чернетка',summary:'Перевірте перед використанням.',questions:[],tasks:[],review:null,quality:[],warnings:['Ключі й оцінки є пропозиціями; перевірте їх.']}
  if(['questions','variants','error_practice'].includes(r.kind))for(let variant=1;variant<=(r.kind==='variants'?(r.variantCount??2):1);variant++)for(let i=0;i<(r.questionCount??5);i++)bundle.questions.push({id:`q_${variant}_${i}`,type:'single',text:`Що визначає мету роботи? Приклад ${variant} ${i}`,choices:['Підготовка','Випадковість','Перерва','Завершення'],correctIndex:0,explanation:'Під час підготовки визначають мету.',points:1,topic:'Етап '+i,variant})
  if(r.kind==='tasks')bundle.tasks.push({title:'План навчального проєкту',instructions:'Визначте мету й послідовність кроків.',criteria:['Мета визначена','Кроки пов’язані з метою']})
  if(r.kind==='rubric_review'){
   const criteria=context.submission.rubric.criteria.map((c,index)=>({title:c.title,points:index===0?3:1,maxPoints:index===0?8:2,comment:'Попередня пропозиція за критерієм.',evidence:[context.submission.body.slice(0,30)]}))
   bundle.review={criteria,feedback:'Уточніть приклад. Остаточне рішення приймає викладач.',suggestedScore:4,maxScore:10}
  }
  if(r.kind==='quality')bundle.quality=[{questionId:context.test.questions[0].id,issue:'Формулювання потребує уточнення.',suggestion:'Додайте конкретний приклад.'}]
  if(mode==='invalid')bundle.questions[0].correctIndex=9
  if(mode==='invented_evidence'&&bundle.review)bundle.review.criteria[0].evidence=['Такого уривка не було.']
  return json({status:'completed',service_tier:'default',usage:{input_tokens:1000,output_tokens:500},output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(bundle)}]}]})
 }}
}
