import {PGlite} from '@electric-sql/pglite'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import {fileURLToPath} from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
const root=fileURLToPath(new URL('../../',import.meta.url)),native=createRequire(import.meta.url),cache=new Map()
const read=file=>readFileSync(path.resolve(root,file),'utf8')
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);vm.runInNewContext(ts.transpileModule(read(absolute),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,process,Buffer,TextEncoder,TextDecoder,Uint8Array,AbortController,AbortSignal,Response,URL,Set,Map,Promise,Date,Number,JSON,setTimeout,clearTimeout,fetch(){throw Error('Real network forbidden in Plus fixture')},require(name){if(name==='@supabase/supabase-js')return{createClient(){throw Error('Fixture must inject its own database')}};if(name.startsWith('.'))return load(path.resolve(path.dirname(absolute),name.replace(/\.(?:js|ts)$/,''))+'.ts');return native(name)}});return module.exports}
export const tutor=load('src/lib/maxTutor.ts'),production=load('server/student-learning/maxTutorProduction.ts')
export const id=n=>`81000000-0000-4000-8000-${String(n).padStart(12,'0')}`,users={plus:id(1),other:id(2),max:id(3),teacher:id(4),legacy:id(5)},sessions={plus:id(101),other:id(102),max:id(103),teacher:id(104),legacy:id(105)}
export const hash=value=>createHash('sha256').update(value).digest('hex'),plain=value=>JSON.parse(JSON.stringify(value))
export const PLUS_MIGRATION='20261117171507_student_plus_ai_paid_period.sql'
export {load as loadFixtureModule}
export async function createPlusBackendFixture({applyPlus=true,applyLibrary=applyPlus,onProvider}={}){
 const db=new PGlite(),rows=async(sql,args=[])=>(await db.query(sql,args)).rows
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create table public.profiles(id uuid primary key,account_type text default'student',legacy_access boolean default false,lifetime_access boolean default false);
 create function public.xelay_has_participant_access(u uuid)returns boolean language sql stable security definer as $$select coalesce((select legacy_access or lifetime_access from public.profiles where id=u),false)$$;
 create function public.xelay_private_participant_lifetime(u uuid)returns boolean language sql stable security definer as $$select coalesce((select lifetime_access from public.profiles where id=u),false)$$;
 create table public.official_grades(id integer primary key,score integer);insert into public.official_grades values(1,85),(2,92);
 insert into auth.users(id,email_confirmed_at)values ${Object.values(users).map(u=>`('${u}',clock_timestamp())`).join(',')};
 insert into public.profiles(id)select id from auth.users;
 insert into auth.sessions(id,user_id)values ${Object.keys(users).map(k=>`('${sessions[k]}','${users[k]}')`).join(',')};`)
 for(const name of['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261116161046_student_max_tutor_chat.sql','20261116165652_student_max_study_formats.sql','20261117070036_student_max_topic_generation.sql','20261117105257_student_max_ai_credits.sql'])await db.exec(read('supabase/migrations/'+name))
 const roles=async(role,who,work)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:users[who],session_id:sessions[who],role})]);try{return await work()}finally{await db.exec('reset role')}}
 const rpc=(name,args=[])=>rows(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args).then(result=>result[0].v)
 const service=(name,args=[],who='plus')=>roles('service_role',who,()=>rpc(name,args)),own=(name,args=[],who='plus')=>roles('authenticated',who,()=>rpc(name,args))
 const grant=async(who,plan,from=new Date(Date.now()-86400000).toISOString(),until=new Date(Date.now()+29*86400000).toISOString(),reference='synthetic-plus-grant-'+who)=>service('xelay_student_plan_grant',[users[who],plan,from,until,reference])
 for(const who of Object.keys(users))await service('xelay_student_audience_assign',[users[who],who==='teacher'?'teacher':'student','Synthetic Plus backend verification'],who)
 for(const who of ['plus','other','max'])await grant(who,who==='max'?'max':'plus')
 await rows('update public.profiles set lifetime_access=true,legacy_access=true where id=$1',[users.legacy])
 if(applyPlus)await db.exec(read('supabase/migrations/'+PLUS_MIGRATION))
 if(applyLibrary)await db.exec(read('supabase/migrations/20261117171709_student_learning_cloud_library.sql'))
 const environment={STUDENT_MAX_ENABLED:'true',STUDENT_MAX_AI_ENABLED:'true',SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_ANON_KEY:'synthetic-plus-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-plus-private-key',OPENAI_API_KEY:['sk','synthetic','plus','provider','credential','only'].join('-')}
 const issuedExp=Math.floor(Date.now()/1000)+3600
 const token=who=>['synthetic-header',Buffer.from(JSON.stringify({sub:users[who],role:'authenticated',session_id:sessions[who],exp:issuedExp})).toString('base64url'),'synthetic-signature'].join('.')
 const tokens=new Map(Object.keys(users).map(who=>[token(who),who]))
 const rpcCalls=[]
 const params={xelay_student_library_run:['p_run_id'],xelay_student_workspace_status:[],xelay_max_runs_list:['p_limit'],xelay_max_sources_put:['p_request_id','p_sources'],xelay_max_sources_get:['p_request_id','p_source_ids'],xelay_max_ai_reserve:['p_user_id','p_session_hash','p_request_id','p_fingerprint','p_reserve_micros','p_monthly_limit_micros','p_request'],xelay_max_ai_finish:['p_user_id','p_session_hash','p_request_id','p_fingerprint','p_reservation_id','p_charge_micros','p_bundle','p_request'],xelay_max_run_progress:['p_run_id','p_expected_version','p_progress']}
 const factory=(_url,key,options)=>{const isService=key===environment.SUPABASE_SERVICE_ROLE_KEY,raw=options.global?.headers?.Authorization?.slice(7),who=tokens.get(raw)||'plus';return{auth:{async getUser(value){const verified=tokens.get(value);return verified?{data:{user:{id:users[verified],email_confirmed_at:'2026-11-17T00:00:00Z',user_metadata:{planId:'max'}}},error:null}:{data:{user:null},error:{message:'Invalid synthetic token'}}}},async rpc(name,values={}){rpcCalls.push({name,service:isService,who});if(!Object.hasOwn(params,name))throw Error('Unexpected RPC '+name);try{return{data:await roles(isService?'service_role':'authenticated',who,()=>rpc(name,params[name].map(k=>values[k]??null))),error:null}}catch(error){return{data:null,error:{code:error.code,message:error.message}}}},from(){return{select(){return{eq(_column,value){return{async maybeSingle(){return{data:value===users[who]?{id:users[who],first_name:who==='plus'?'Марія':'Олексій'}:null,error:null}}}}}}}}}}
   const providerInputs=[],providerModels=[]
 const fetcher=async(url,init)=>{const payload=JSON.parse(init.body);if(url==='https://api.openai.com/v1/moderations')return new Response(JSON.stringify({results:[{flagged:false}]}),{headers:{'content-type':'application/json'}});if(url!=='https://api.openai.com/v1/responses')throw Error('Unexpected real network endpoint');const content=JSON.parse(payload.input[0].content[0].text);providerInputs.push(content);providerModels.push(payload.model);if(onProvider)await onProvider({payload,content,db,rows,service,own});const bundle=plain(tutor.createTutorDemo('synthetic-provider-response',content.mode).bundle),source=content.sources[0];bundle.mode=content.mode;if(payload.model==='gpt-5.4-mini'){bundle.plan=[];bundle.math=null}for(const q of bundle.questions)q.sourceId=source?.id||'';for(const c of bundle.cards)c.sourceId=source?.id||'';bundle.citations=source?[{sourceId:source.id,quote:source.text.slice(0,80)}]:[];if(content.mode==='chat'){bundle.questions=[];bundle.cards=[];bundle.plan=[];bundle.math=null;bundle.steps=[];bundle.introduction='Марія, привіт! Допоможу підготуватися до заняття.'}return new Response(JSON.stringify({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:100}}}),{headers:{'content-type':'application/json'}})}
 const handler=production.createMaxTutorProduction({environment,clientFactory:factory,fetcher})
 async function call(action='status',body,who='plus',extraHeaders={}){const req=new EventEmitter(),res=new EventEmitter();req.method=body===undefined?'GET':'POST';req.url='/api/student-learning?action='+action;req.headers={authorization:'Bearer '+[...tokens].find(([,w])=>w===who)[0],'content-type':'application/json',...(body===undefined?{}:{origin:'https://www.xelay.ink'}),...extraHeaders};req.body=body;res.text='';res.setHeader=()=>{};res.end=value=>{res.text+=value||'';res.writableEnded=true};await handler(req,res);return{http:res.statusCode,value:JSON.parse(res.text)}}
 return{db,rows,roles,rpc,service,own,grant,call,rpcCalls,providerInputs,providerModels,environment,token,applyPlus:()=>db.exec(read('supabase/migrations/'+PLUS_MIGRATION)),close:()=>db.close()}
}
