import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
const source=await readFile(new URL('../../src/pages/StudyGroupsPage.tsx',import.meta.url),'utf8')
const tree=ts.createSourceFile('page.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
const workspace=tree.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='StudyGroupWorkspace')
const declarations=workspace.body.statements.filter(ts.isVariableStatement).flatMap(n=>[...n.declarationList.declarations])
const arrow=name=>declarations.find(n=>n.name.getText(tree)===name).initializer.getText(tree)
const keys=['loadGroup','groupLoadSequence','active','group','canInviteMembers','inviting','setInviting','setError','supabase','inviteUsername','setInviteUsername','showGroupActionError','notify','id']
const compiled=ts.transpileModule(`export function create(context:any){const {${keys.join(',')}}=context;const refreshGroupAfterAction=${arrow('refreshGroupAfterAction')};return {refresh:refreshGroupAfterAction,invite:${arrow('inviteMember')}}}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const harness=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'))
function fixture(options={}){
 const calls=[],state={loading:false,inviting:false,username:'student',error:''}
 const context={group:{id:'group-a'},canInviteMembers:true,inviting:false,inviteUsername:' student ',id:'group-a',active:{current:true},groupLoadSequence:{current:0},
  setInviting:value=>{state.inviting=value},setError:value=>{state.error=value},setInviteUsername:value=>{state.username=value},
  showGroupActionError:(...args)=>calls.push(['error',...args]),notify:value=>calls.push(['notice',value]),
  supabase:{rpc:async(name,args)=>{calls.push(['rpc',name,args]);return {error:options.inviteError||null}}},
  async loadGroup(silent){calls.push(['refresh',silent]);context.groupLoadSequence.current++;if(!silent)state.loading=true;const result=options.pending?await options.pending:options.refreshed!==false;state.loading=false;return result},
 }
 return {context,calls,state,...harness.create(context)}
}
test('invitation refresh keeps the current page mounted throughout a delayed roster update',async()=>{
 let finish;const fx=fixture({pending:new Promise(resolve=>{finish=resolve})})
 let prevented=false
 const pending=fx.invite({preventDefault(){prevented=true}})
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(prevented,true)
 assert.equal(fx.state.inviting,true)
 assert.equal(fx.state.loading,false)
 assert.deepEqual(fx.calls.filter(call=>call[0]==='refresh'),[['refresh',true]])
 finish(true);await pending
 assert.equal(fx.state.inviting,false)
 assert.equal(fx.state.username,'')
 assert.deepEqual(fx.calls.find(call=>call[0]==='rpc'),['rpc','xelay_invite_to_study_group',{p_group_id:'group-a',p_username:'student'}])
 assert.equal(fx.calls.find(call=>call[0]==='notice')[1].title,'Запрошення надіслано')
})
test('failed invitations preserve the entered nickname and do not reload or move the page',async()=>{
 const fx=fixture({inviteError:{message:'user not found'}})
 await fx.invite({preventDefault(){}})
 assert.equal(fx.state.username,'student')
 assert.equal(fx.state.inviting,false)
 assert.equal(fx.state.loading,false)
 assert.equal(fx.calls.some(call=>call[0]==='refresh'),false)
 assert.match(fx.calls.find(call=>call[0]==='error')[1],/не знайдено/)
 assert.doesNotMatch(arrow('inviteMember'),/scrollTo|scrollIntoView|navigate\(|\.focus\(/)
})
test('refresh failures warn that the invitation was sent and never claim roster success',async()=>{
 const fx=fixture({refreshed:false});await fx.invite({preventDefault(){}})
 assert.equal(fx.calls.some(call=>call[0]==='notice'),false)
 assert.equal(fx.calls.find(call=>call[0]==='error')[3],'warning')
})
test('the refresh guard still discards obsolete results and other actions keep the default reload',async()=>{
 let finish;const fx=fixture({pending:new Promise(resolve=>{finish=resolve})})
 const pending=fx.refresh(true);fx.context.active.current=false;finish(true)
 assert.equal(await pending,null)
 const normal=fixture();assert.equal(await normal.refresh(),true)
 assert.deepEqual(normal.calls,[['refresh',false]])
})
