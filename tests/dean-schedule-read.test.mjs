import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {stripTypeScriptTypes} from 'node:module'
const source=await readFile(new URL('../src/lib/studyGroupScheduleRead.ts',import.meta.url),'utf8')
test('direct dean navigation resolves to its private generated app shell',async()=>{
 const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'))
 assert.equal(config.rewrites.find(rule=>rule.source==='/dean')?.destination,'/seo/dean.html')
 const seo=await import('../src/lib/seo.ts')
 assert.ok(seo.PRIVATE_SPA_PATHS.includes('/dean'))
 assert.equal(seo.metadataForPath('/dean').index,false)
})
const load=new Function('supabase',stripTypeScriptTypes(source.replace("import { supabase } from './supabase'",'').replace(/import type[^\n]+/g,'').replace('export async function','async function'))+';return loadStudyGroupScheduleHistory')
test('group reader retains old rows and paginates private dean lessons',async()=>{
 let a=0,b=0;const calls=[]
 const result=value=>({select(){return this},eq(){return this},order(){return this},limit(){return this},gt(){return this},abortSignal(){return this},then(resolve){return Promise.resolve(value()).then(resolve)}})
 const client={from(){return result(()=>({data:a++===0?[{id:'old',group_id:'g',weekday:1,starts_at:'08:00'}]:[],error:null,status:200}))},rpc(name,args){calls.push([name,args]);return result(()=>({data:b++===0?[{id:'new',group_id:'g',weekday:2,starts_at:'09:40',dean_managed:true}]:[],error:null,status:200}))}}
 const response=await load(client)('g');assert.deepEqual(response.data.map(r=>r.id),['old','new']);assert.equal(calls[1][1].p_after,'new')
})
test('revoked authentication and stale page never expose cached schedule',async()=>{
 let current=true;const q={select(){return this},eq(){return this},order(){return this},limit(){return this},then(resolve){return Promise.resolve({data:[],error:null,status:200}).then(resolve)}}
 const client={from(){return q},rpc(){current=false;return Promise.resolve({data:[{id:'private',group_id:'g',dean_managed:true}],error:null,status:200})}}
 assert.equal((await load(client)('g',()=>current)).data,null)
 client.rpc=()=>Promise.resolve({data:null,error:{code:'42501'},status:403})
 assert.equal((await load(client)('g')).error.code,'42501')
})
