import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { teacherModuleLoader } from './helpers/loadTeacherModule.mjs'

const load=teacherModuleLoader(),{createWinterBenefitsHandler}=load('server/winter-benefits.ts')
const {parseWinterBenefitAction,parseWinterBenefitsState}=load('src/lib/winterBenefits.ts')
const user=randomUUID(),session=randomUUID(),now=Date.parse('2026-12-31T12:00:00Z')
const environment={SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-private'}
const token=overrides=>['synthetic',Buffer.from(JSON.stringify({sub:user,session_id:session,role:'authenticated',exp:now/1000+3600,...overrides})).toString('base64url'),'synthetic'].join('.')
const state=()=>({campaignId:'winter-2026',serverNow:new Date(now).toISOString(),eligible:true,activationEndsAt:'2027-02-28T22:00:00.000Z',promo:{collectedCredits:50,purchaseBonusCredits:0,availableCredits:50,reservedCredits:0,spentCredits:0,activatedAt:new Date(now).toISOString(),activationEndsAt:'2027-01-31T22:00:00.000Z',usable:true},subscriptions:{student:{planId:'plus',effectivePlanId:'plus',expiresAt:'2027-01-15T00:00:00Z',pausedUntil:null,upgradeUntil:null},teacher:{planId:null,effectivePlanId:null,expiresAt:null,pausedUntil:null,upgradeUntil:null}},benefits:[{day:2,kind:'extension',amountDays:1,status:'available',audience:null,activeUntil:null,convertedToExtension:false}]})
function fixture(options={}){
 const calls=[]
 const handler=createWinterBenefitsHandler({environment,now:()=>now,clientFactory(_url,key,config){return{auth:{async getUser(){return options.auth||{data:{user:{id:user,email_confirmed_at:'2026-11-01'}},error:null}}},async rpc(name,args){calls.push({name,args:JSON.parse(JSON.stringify(args)),key,config});return{data:options.state||state(),error:options.error||null}}}}})
 const run=async(extra={})=>{const req={method:'GET',url:'/api/winter/benefits',headers:{authorization:'Bearer '+token(),'content-type':'application/json',origin:'https://www.xelay.ink'},...extra};const res={headers:{},setHeader(k,v){this.headers[k]=v},end(v){this.body=JSON.parse(v);this.writableEnded=true}};await handler(req,res);return res}
 return{run,calls}
}
test('winter benefit actions use the verified exact session and a private service RPC with no caller authority',async()=>{
 const f=fixture(),result=await f.run({method:'POST',body:{action:'redeem',day:2,audience:'student'}})
 assert.equal(result.statusCode,200);assert.equal(result.headers['Cache-Control'],'no-store, private')
 assert.deepEqual(f.calls[0].args,{p_user_id:user,p_session_id:session,p_action:{action:'redeem',day:2,audience:'student'}})
 assert.equal(f.calls[0].name,'xelay_winter_benefits');assert.equal(f.calls[0].key,environment.SUPABASE_SERVICE_ROLE_KEY)
 assert.equal(f.calls[0].config.global.headers,undefined)
})
test('unverified, foreign, expired, cross-site and forged clock/reward requests never call the mutation RPC',async()=>{
 for(const extra of[
  {method:'POST',body:{action:'activate_credits',amount:10000}},
  {method:'POST',body:{action:'redeem',day:1,audience:'student'}},
  {method:'POST',body:{action:'resume',audience:'student',userId:user}},
  {method:'POST',body:{action:'activate_credits'},headers:{authorization:'Bearer '+token(),'content-type':'application/json'}},
  {url:'/api/winter/benefits?now=2026-12-31'},
  {headers:{authorization:'Bearer '+token({sub:randomUUID()}),origin:'https://www.xelay.ink'}},
  {headers:{authorization:'Bearer '+token({exp:now/1000-1}),origin:'https://www.xelay.ink'}},
  {headers:{authorization:'Bearer '+token(),origin:'https://foreign.example'}},
 ]){const f=fixture();assert.ok((await f.run(extra)).statusCode>=400);assert.equal(f.calls.length,0)}
 for(const userState of[{id:user,email_confirmed_at:null},{id:user,email_confirmed_at:'2026-11-01',is_anonymous:true}]){const f=fixture({auth:{data:{user:userState},error:null}});assert.ok((await f.run()).statusCode>=400);assert.equal(f.calls.length,0)}
})
test('wallet parser rejects fabricated caps, unknown benefits and duplicate days; actions cannot grant arbitrary data',()=>{
 for(const change of[{promo:{...state().promo,collectedCredits:151}},{promo:{...state().promo,purchaseBonusCredits:301}},{benefits:[...state().benefits,...state().benefits]},{benefits:[{...state().benefits[0],amountDays:1000}]}])assert.throws(()=>parseWinterBenefitsState({...state(),...change}))
 assert.equal(parseWinterBenefitsState(state()).promo.availableCredits,50)
 for(const action of[{action:'redeem',day:5,audience:'student'},{action:'activate_credits',serverNow:'2026-12-31'},{action:'resume',audience:'admin'}])assert.throws(()=>parseWinterBenefitAction(action))
})
test('expected state conflicts are understandable and provider/database details are never exposed',async()=>{
 for(const[message,code]of[['WINTER_UPGRADE_ACTIVE','upgrade_active'],['WINTER_GIFT_ACTIVE','gift_active'],['WINTER_SUBSCRIPTION_PAUSED','subscription_paused'],['WINTER_PAID_PLAN_REQUIRED','paid_plan_required']]){
  const result=await fixture({error:{code:'PT409',message}}).run({method:'POST',body:{action:'activate_credits'}})
  assert.equal(result.statusCode,409);assert.equal(result.body.code,code)
 }
 const failed=await fixture({error:{code:'XX000',message:'private database information'}}).run();assert.equal(failed.statusCode,503);assert.ok(!JSON.stringify(failed.body).includes('private database'))
})
