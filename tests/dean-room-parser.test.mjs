import test from 'node:test'
import assert from 'node:assert/strict'
import {parseDeanSource,deanPublicationRows} from '../src/lib/deanWorkspace.ts'
const sample=()=>({students:Array.from({length:4},(_,i)=>({id:'s'+i,name:'Synthetic '+i,group:'G-1'})),events:[{id:'e',course:'Course',activity:'lab',teacher:'Teacher',teacherIds:['t'],studentIds:['s0','s1','s2','s3'],day:2,period:3,weeks:[1,2],section:1,room:'R'}],rooms:[{id:'R',capacity:1,computer:true,disabled:false,blockedSlots:[[2,4],[2,5],[2,6]],allowedPrograms:['G'],note:''}]})
test('room assignments and restrictions survive roundtrip, max three own laptops',()=>{
 const s=sample(),parsed=parseDeanSource(s);assert.equal(parsed.events[0].room,'R');assert.equal(parsed.events[0].section,1)
 assert.deepEqual(parseDeanSource(JSON.parse(JSON.stringify(parsed))),parsed)
 const rows=deanPublicationRows(parsed,Object.fromEntries(s.students.map(x=>[x.id,{userId:x.id,groupId:'g'}])),'2027-02-01');assert.equal(rows[0].room,'R')
 for(const mutate of [x=>x.rooms[0].capacity=0,x=>x.rooms[0].computer=false,x=>x.rooms[0].disabled=true,x=>x.events[0].period=4,x=>x.students[0].group='OTHER-1',x=>x.events[0].room='missing']){const bad=sample();mutate(bad);assert.throws(()=>parseDeanSource(bad))}
 const over=sample();over.students.push({id:'s4',name:'Synthetic 4',group:'G-1'});over.events[0].studentIds.push('s4');assert.throws(()=>parseDeanSource(over))
})
test('room collision is independent of student and teacher collision; pending inputs allow recalculation',()=>{
 const s=sample();s.students.push({id:'s4',name:'Other',group:'G-1'});s.events.push({...s.events[0],id:'other',studentIds:['s4'],teacherIds:['t2']});assert.throws(()=>parseDeanSource(s),/аудиторії/)
 assert.equal(parseDeanSource(s,false).events.length,2)
})
