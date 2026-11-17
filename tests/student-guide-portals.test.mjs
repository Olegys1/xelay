import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const root=new URL('../',import.meta.url),read=file=>readFileSync(new URL(file,root),'utf8'),compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const guides={exports:{}},roots={exports:{}}
vm.runInNewContext(compile(read('src/lib/studentGuides.ts')),{module:guides,exports:guides.exports,JSON,Math,Number,Set,Map})
vm.runInNewContext(compile(read('src/lib/studentGuideRoots.ts')),{module:roots,exports:roots.exports})
const g=guides.exports,resolve=roots.exports.studentGuideOwnedRoots,ui=read('src/components/student/StudentLearningGuide.tsx'),ast=ts.createSourceFile('guide.tsx',ui,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),nodes=[]
const walk=node=>{nodes.push(node);ts.forEachChild(node,walk)};walk(ast)
const functionSource=name=>nodes.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name).getText(ast)
const effectSource=marker=>nodes.find(node=>ts.isCallExpression(node)&&node.expression.getText(ast)==='useEffect'&&node.arguments[0]?.getText(ast).includes(marker)).arguments[0].getText(ast)
const visibleSource=nodes.find(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='visible').initializer.getText(ast)

class Element{
 constructor(tag='div',{id='',classes='',attrs={},label='',type=''}={}){this.tagName=tag.toUpperCase();this.id=id;this.classes=classes.split(/\s+/);this.attrs={...attrs,...(id?{id}:{}),...(label?{'aria-label':label}:{} )};this.type=type;this.children=[];this.parent=null;this.style={visibility:'visible'};this.hidden=false;this.inert=false;this.isConnected=true;this.readOnly=false;this.disabled=false;this.textContent='';this.scans=[];this.scrolled=0}
 append(...children){for(const child of children){child.parent=this;this.children.push(child)}return this}
 contains(node){return node===this||this.children.some(child=>child.contains(node))}
 matches(selector){return selector.split(',').some(option=>{const parts=option.trim().split(/\s+/);let node=this;if(!node.matchOne(parts.pop()))return false;while(parts.length){const part=parts.pop();node=node.parent;while(node&&!node.matchOne(part))node=node.parent;if(!node)return false}return true})}
 matchOne(selector){if(!selector)return false;if(selector.startsWith('input:not('))return this.tagName==='INPUT'&&!['hidden','checkbox','radio','file','range','button','submit'].includes(this.type);const tag=selector.match(/^[a-z]+/i)?.[0];if(tag&&tag.toUpperCase()!==this.tagName)return false;for(const id of selector.matchAll(/#([\w-]+)/g))if(this.id!==id[1])return false;for(const cls of selector.matchAll(/\.([\w-]+)/g))if(!this.classes.includes(cls[1]))return false;for(const attr of selector.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)){if(!(attr[1] in this.attrs)||attr[2]!==undefined&&this.attrs[attr[1]]!==attr[2])return false}return true}
 closest(selector){for(let node=this;node;node=node.parent)if(node.matches(selector))return node;return null}
 querySelectorAll(selector){this.scans.push(selector);return this.children.flatMap(child=>[child,...child.descendants()]).filter(node=>node.matches(selector))}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null}
 descendants(){return this.children.flatMap(child=>[child,...child.descendants()])}
 getAttribute(key){return key in this.attrs?this.attrs[key]:null}
 getBoundingClientRect(){let hidden=false;for(let node=this;node;node=node.parent)hidden||=node.hidden;return {left:20,top:70,width:hidden?0:190,height:hidden?0:44}}
 scrollIntoView(){this.scrolled++}
 focus(){}
}
const e=(tag,props)=>new Element(tag,props)
function fixture({local=false,immersive=true}={}){
 const app=e('main'),workspace=e('main',{classes:'slp'+(immersive?' slp-immersive':'')}),block=e('section',{classes:'mls'}),ownField=e('textarea',{label:'Власний конспект'}),rail=e(local?'aside':'header',{classes:local?'slp-local-rail':'',attrs:local?{}:{'data-learning-immersive':'true'}})
 const nav=e('div',{id:local?'':'xelay-learning-navigation',classes:local?'slp-local-navigation-target':''}),sidebar=e('aside',{classes:'mls-sidebar mls-immersive-nav'}),menu=e('nav'),chat=e('button',{label:'Чат'}),control=e('div',{id:local?'':'xelay-learning-controls',classes:local?'slp-local-controls':''}),quota=e('div',{id:local?'':'xelay-learning-quota',classes:local?'slp-local-quota':''}),launcher=e('div',{attrs:{'data-student-guide':'launcher'}}),guideButton=e('button',{label:'Підказки'}),quotaButton=e('button',{label:'Залишок навчального ліміту'}),globalButton=e('button',{label:'Викладання'}),profile=e('section'),privateField=e('input',{label:'Приватний пароль',type:'password'})
 Object.defineProperty(privateField,'value',{get(){throw Error('Private profile value was read')}})
 app.append(workspace);workspace.append(block);block.append(ownField);(local?workspace:app).append(rail);rail.append(globalButton,nav,control,quota,profile);nav.append(sidebar);sidebar.append(menu);menu.append(chat);control.append(launcher);launcher.append(guideButton);quota.append(quotaButton);profile.append(privateField)
 return{app,workspace,block,ownField,rail,nav,sidebar,menu,chat,control,quota,launcher,guideButton,quotaButton,globalButton,profile,privateField}
}
function runtime(f,guideId='max'){
 const observed=[],handlers=new Map(),target={current:null},state={missing:null,rect:null,selected:null,mode:null,found:null,measured:0},context={mode:'tour',guide:g.getStudentGuide(guideId),guideId,current:g.getStudentGuide(guideId).steps[0],controls:vm.runInNewContext(nodes.find(node=>ts.isVariableDeclaration(node)&&node.name.getText(ast)==='controls').initializer.getText(ast)),complete:false,target,reduce:true,raf:{current:0},Element,HTMLElement:Element,STUDENT_GUIDE_CONTROL_CONTEXTS:g.STUDENT_GUIDE_CONTROL_CONTEXTS,describeStudentGuideAction:g.describeStudentGuideAction,isSafeStudentGuideReveal:g.isSafeStudentGuideReveal,ownedRoots:()=>resolve(guideId,f.block,f.launcher),getComputedStyle:node=>node.style,setMissing:value=>state.missing=value,setRect:value=>state.rect=value,setSelected:value=>state.selected=value,setMode:value=>state.mode=value,setComplete(){},setQuery(){},setStep(){},setFound:value=>state.found=value,measure(){state.measured++},opener:{current:null},document:{activeElement:f.guideButton,addEventListener(name,handler){const list=handlers.get(name)||new Set();list.add(handler);handlers.set(name,list)},removeEventListener(name,handler){handlers.get(name)?.delete(handler)}},requestAnimationFrame:()=>1,cancelAnimationFrame(){},MutationObserver:class{constructor(callback){this.callback=callback;this.nodes=[];observed.push(this)}observe(node){this.nodes.push(node)}disconnect(){this.disconnected=true}},console}
 const compiled=compile('const visible='+visibleSource+';'+functionSource('describeControl')+';'+functionSource('open')+';exports.tour='+effectSource("mode!=='tour'")+';exports.inspect='+effectSource("mode!=='inspect'||!guide")+';exports.open=open;'),module={exports:{}}
 vm.runInNewContext(compiled,{module,exports:module.exports,...context});return{...module.exports,state,context,target,observed,handlers,emit(name,event){for(const handler of handlers.get(name)||[])handler(event)}}
}
const event=target=>({target,prevented:0,stopped:0,preventDefault(){this.prevented++},stopPropagation(){this.stopped++},stopImmediatePropagation(){this.stopped++}})

test('immersive Max resolves only its current main block and exact owned navigation/footer slots',()=>{
 const f=fixture(),owned=resolve('max',f.block,f.launcher);assert.deepEqual(Array.from(owned),[f.block,f.nav,f.control,f.quota]);assert.equal(owned.some(node=>node.contains(f.privateField)),false);assert.equal(owned.some(node=>node.contains(f.globalButton)),false)
 assert.ok(f.rail.scans.every(selector=>['#xelay-learning-navigation','#xelay-learning-controls','#xelay-learning-quota'].includes(selector)));assert.equal(f.app.scans.length,0)
})

test('isolated preview fallback rail must be contained in the same immersive workspace',()=>{
 const f=fixture({local:true});assert.deepEqual(Array.from(resolve('assistant',f.block,f.launcher)),[f.block,f.nav,f.control,f.quota]);f.rail.parent=f.app;f.workspace.children=f.workspace.children.filter(node=>node!==f.rail);f.app.children.push(f.rail);assert.deepEqual(Array.from(resolve('max',f.block,f.launcher)),[f.block])
})

test('ordinary guides and misplaced or absent launchers never widen into header/profile forms',()=>{
 for(const id of g.STUDENT_GUIDE_IDS.filter(id=>!['max','assistant'].includes(id))){const f=fixture();assert.deepEqual(Array.from(resolve(id,f.block,f.launcher)),[f.block],id);assert.equal(f.rail.scans.length,0)}
 const f=fixture();assert.deepEqual(Array.from(resolve('max',f.block,f.profile)),[f.block]);assert.deepEqual(Array.from(resolve('max',null,f.launcher)),[]);assert.deepEqual(Array.from(resolve('max',f.block,null)),[f.block]);const ordinary=fixture({immersive:false});assert.deepEqual(Array.from(resolve('max',ordinary.block,ordinary.launcher)),[ordinary.block])
})

test('the actual first Max tour step finds and highlights the real portaled menu rather than reporting missing',()=>{
 const f=fixture(),h=runtime(f),cleanup=h.tour();assert.equal(h.state.missing,false);assert.equal(h.target.current,f.menu);assert.equal(f.menu.scrolled,1);assert.equal(h.state.measured,1);assert.deepEqual(h.observed[0].nodes,[f.block,f.nav,f.control,f.quota]);cleanup();assert.equal(h.observed[0].disconnected,true)
})

test('collapsed mobile menus remain a legitimate missing prerequisite without automatic navigation',()=>{
 const f=fixture();f.nav.hidden=true;const h=runtime(f),cleanup=h.tour();assert.equal(h.state.missing,true);assert.equal(h.target.current,null);assert.equal(f.menu.scrolled,0);assert.match(g.getStudentGuide('max').steps[0].prerequisite,/відкрий меню/);cleanup()
})

test('manual index includes only visible own study controls and never reads private profile data',()=>{
 const f=fixture(),h=runtime(f);h.open('manual');const labels=Array.from(h.state.found,control=>control.label);assert.ok(labels.includes('Чат'));assert.ok(labels.includes('Власний конспект'));assert.ok(labels.includes('Залишок навчального ліміту'));assert.equal(labels.includes('Підказки'),false);assert.equal(labels.includes('Викладання'),false);assert.equal(labels.includes('Приватний пароль'),false)
})

test('the actual inspector blocks owned portaled controls and edits, preserves foreign account fields, and restores readOnly',()=>{
 const f=fixture(),h=runtime(f)
 const module={exports:{}},owned=()=>resolve('max',f.block,f.launcher),handlers=new Map(),readonlyState={selected:null},context={...h.context,mode:'inspect',ownedRoots:owned,setSelected:value=>readonlyState.selected=value,document:{addEventListener(name,handler){handlers.set(name,handler)},removeEventListener(name){handlers.delete(name)}}}
 vm.runInNewContext(compile(functionSource('describeControl')+';exports.run='+effectSource("mode!=='inspect'||!guide")+';'),{module,exports:module.exports,...context});const cleanup=module.exports.run();assert.equal(f.ownField.readOnly,true);assert.equal(f.privateField.readOnly,false)
 const navClick=event(f.chat);handlers.get('click')(navClick);assert.equal(navClick.prevented,1);assert.equal(readonlyState.selected.detail.id,'max-navigation');assert.equal(h.target.current,f.chat)
 const foreign=event(f.privateField);handlers.get('click')(foreign);assert.equal(foreign.prevented,0);handlers.get('beforeinput')(foreign);assert.equal(foreign.prevented,0)
 const edit=event(f.ownField);handlers.get('beforeinput')(edit);assert.equal(edit.prevented,1);assert.equal(edit.stopped,2)
 cleanup();assert.equal(f.ownField.readOnly,false);assert.equal(f.privateField.readOnly,false);assert.equal(handlers.size,0)
})
