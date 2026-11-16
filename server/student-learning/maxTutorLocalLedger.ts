import {randomBytes,randomUUID} from 'node:crypto'
import {kill,pid} from 'node:process'
import {mkdir,open,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import path from 'node:path'
import type {MaxTutorReservationInput,MaxTutorSettlement} from './maxTutorSession'
import type {MaxTutorBundle} from '../../src/lib/maxTutor'

type Row={userId:string;requestId:string;fingerprint:string;reservationId:string;reserved:number;charge:number;state:'pending'|'done';bundle:MaxTutorBundle|null}
type State={version:1;ownerId:string;limitMicros:number;rows:Row[]}
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)
const fingerprint=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const totals=(s:State)=>s.rows.reduce((v,r)=>({spentMicros:v.spentMicros+r.charge,reservedMicros:v.reservedMicros+(r.state==='pending'?r.reserved:0)}),{spentMicros:0,reservedMicros:0})
function parse(raw:string):State{
 if(raw.length>8_000_000)throw Error('Local ledger unavailable')
 const s=JSON.parse(raw)
 if(!s||s.version!==1||!identifier(s.ownerId)||!integer(s.limitMicros)||s.limitMicros<100000||s.limitMicros>6000000||!Array.isArray(s.rows)||s.rows.length>2000)throw Error('Local ledger unavailable')
 const keys=new Set<string>()
 for(const r of s.rows){
  if(!r||!identifier(r.userId)||r.userId!==s.ownerId||!identifier(r.requestId)||!identifier(r.reservationId)||!fingerprint(r.fingerprint)||!integer(r.reserved)||r.reserved===0||!integer(r.charge)||!['pending','done'].includes(r.state)||!(r.bundle===null||typeof r.bundle==='object'&&!Array.isArray(r.bundle)))throw Error('Local ledger unavailable')
  const key=r.userId+':'+r.requestId;if(keys.has(key))throw Error('Local ledger unavailable');keys.add(key)
 }
 const used=totals(s);if(!integer(used.spentMicros)||!integer(used.reservedMicros)||!integer(used.spentMicros+used.reservedMicros))throw Error('Local ledger unavailable')
 return s
}

/** Durable local cap, not a production billing ledger. Unknown operations retain their reservation after restart. */
export async function createMaxTutorLocalLedger(directory:string){
 const dir=path.resolve(directory),file=path.join(dir,'budget.json'),lock=path.join(dir,'budget.lock'),recovery=path.join(dir,'budget.recovery.lock')
 await mkdir(dir,{recursive:true,mode:0o700})
 let queue=Promise.resolve()
 async function serialized<T>(work:()=>Promise<T>):Promise<T>{const previous=queue;let release!:()=>void;queue=new Promise<void>(r=>{release=r});await previous;try{return await work()}finally{release()}}
 const owner=()=>JSON.stringify({version:1,pid,token:randomBytes(32).toString('hex')})
 function isDead(raw:string){
  let data:unknown;try{if(raw.length>512)return false;data=JSON.parse(raw)}catch{return false}
  const value=data as {version?:unknown;pid?:unknown;token?:unknown}
  if(!value||value.version!==1||!Number.isSafeInteger(value.pid)||Number(value.pid)<=0||typeof value.token!=='string'||!(/^[a-f0-9]{64}$/).test(value.token))return false
  try{kill(Number(value.pid),0);return false}catch(e){return (e as NodeJS.ErrnoException).code==='ESRCH'}
 }
 async function removeOwned(file:string,identity:string){try{if(await readFile(file,'utf8')===identity)await unlink(file)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}}
 async function recoverDeadLock(){
  // All recoverers serialize here. A normal claimant can acquire the main lock only after
  // the dead file has gone; a second recoverer then sees that claimant's live PID/token.
  let gate:Awaited<ReturnType<typeof open>>;const gateOwner=owner()
  try{gate=await open(recovery,'wx',0o600)}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')return;throw e}
  try{
   await gate.writeFile(gateOwner)
   let observed:string;try{observed=await readFile(lock,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
   if(isDead(observed)&&await readFile(lock,'utf8')===observed)await unlink(lock)
  }finally{await gate.close();await removeOwned(recovery,gateOwner)}
 }
 async function transaction<T>(work:(state:State)=>Promise<T>|T,verifyBeforeCommit?:(state:State)=>boolean,persist=true):Promise<T>{return serialized(async()=>{
  // An exclusive filesystem lock prevents independent local preview processes from racing the cap.
  let handle:Awaited<ReturnType<typeof open>>|undefined;const lockOwner=owner()
  for(let attempt=0;attempt<20&&!handle;attempt++){try{handle=await open(lock,'wx',0o600);await handle.writeFile(lockOwner)}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;await recoverDeadLock();await new Promise(r=>setTimeout(r,25))}}
  if(!handle)throw Error('Local ledger busy')
  try{
   let state:State;try{state=parse(await readFile(file,'utf8'))}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;state={version:1,ownerId:'local-'+randomUUID(),limitMicros:1000000,rows:[]}}
   const result=await work(state),temporary=path.join(dir,'budget-'+randomUUID()+'.tmp')
   if(persist)try{
    await writeFile(temporary,JSON.stringify(state),{encoding:'utf8',mode:0o600,flag:'wx'})
    // Cancellation or a permission change can arrive while the temporary file is being written.
    // Rewrite before publication, and scrub after rename as well if it arrived during rename IO.
    if(verifyBeforeCommit?.(state))await writeFile(temporary,JSON.stringify(state),{encoding:'utf8',mode:0o600})
    await rename(temporary,file)
    if(verifyBeforeCommit?.(state)){await writeFile(temporary,JSON.stringify(state),{encoding:'utf8',mode:0o600,flag:'wx'});await rename(temporary,file)}
   }finally{await unlink(temporary).catch(()=>{})}
   return result
  }finally{await handle.close();await removeOwned(lock,lockOwner)}
 })}
 await transaction(()=>{})
 return {
  async snapshot(){return transaction(s=>({...totals(s),ownerId:s.ownerId,limitMicros:s.limitMicros}),undefined,false)},
  async configure(limitMicros:number,apply:()=>void=()=>{}){
   if(!integer(limitMicros)||limitMicros<100000||limitMicros>6000000)throw Error('Invalid local limit')
   // The callback and finish verification share this serialization domain. A changed local identity
   // cannot interleave with acceptance/storage of a result in this process.
   return transaction(s=>{s.limitMicros=limitMicros;apply()})
  },
  async begin(input:MaxTutorReservationInput){return transaction(s=>{
   if(input.userId!==s.ownerId||!identifier(input.requestId)||!fingerprint(input.fingerprint)||!integer(input.reserveMicros)||input.reserveMicros===0||!integer(input.monthlyLimitMicros))throw Error('Invalid reservation')
   const prior=s.rows.find(r=>r.userId===input.userId&&r.requestId===input.requestId)
   if(prior){if(prior.fingerprint!==input.fingerprint)return {state:'conflict' as const};if(prior.state==='pending')return {state:'pending' as const};return prior.bundle?{state:'replay' as const,bundle:prior.bundle}:{state:'conflict' as const}}
   const used=totals(s),limit=Math.min(s.limitMicros,input.monthlyLimitMicros)
   if(s.rows.length>=2000||used.spentMicros+used.reservedMicros+input.reserveMicros>limit)return {state:'denied' as const}
   const row:Row={userId:input.userId,requestId:input.requestId,fingerprint:input.fingerprint,reservationId:'reserve-'+randomUUID(),reserved:input.reserveMicros,charge:0,state:'pending',bundle:null};s.rows.push(row)
   return {state:'reserved' as const,reservationId:row.reservationId}
  })},
  async finish(input:MaxTutorSettlement,stillAuthorized:()=>boolean){let accepted=true;await transaction(s=>{
   const row=s.rows.find(r=>r.userId===input.userId&&r.requestId===input.requestId)
   if(!row||row.reservationId!==input.reservationId||row.fingerprint!==input.fingerprint||!integer(input.chargeMicros))throw Error('Invalid settlement')
   if(row.state==='done'){accepted=!input.bundle||!!row.bundle;return}
   const authorized=!input.bundle||stillAuthorized()
   row.charge=input.chargeMicros;row.state='done';row.bundle=input.bundle&&authorized?input.bundle:null
   // Keep tombstones for request idempotency, but only a bounded number of private replay results.
   const retained=s.rows.filter(r=>r.bundle);for(const old of retained.slice(0,-12))old.bundle=null
   if(!integer(totals(s).spentMicros))throw Error('Invalid settlement')
   accepted=authorized
  },s=>{const row=s.rows.find(r=>r.userId===input.userId&&r.requestId===input.requestId);if(input.bundle&&!stillAuthorized()){accepted=false;if(row?.bundle){row.bundle=null;return true}}return false});if(!accepted)throw Error('Local authorization changed')},
 }
}
