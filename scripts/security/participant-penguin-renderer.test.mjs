// Actual catalogue and renderer with local JSX/state stubs. No accounts or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import vm from 'node:vm'
import ts from 'typescript'

const root=new URL('../../',import.meta.url)
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText
const catalog={}
vm.runInNewContext(compile(await readFile(new URL('src/lib/participantStatus.ts',root),'utf8')),{exports:catalog})
const source=await readFile(new URL('src/components/ParticipantStatusEmoji.tsx',root),'utf8')
const token='sticker:penguin'
function fixture(){
  let cursor=0,slots=[],key
  const jsx=(type,props,key)=>({type,props,key}),renderer={}
  vm.runInNewContext(compile(source),{
    exports:renderer,
    require(name){
      if(name==='react')return{useState(initial){const i=cursor++;if(!(i in slots))slots[i]=initial;return[slots[i],value=>{slots[i]=value}]}}
      if(name==='react/jsx-runtime')return{jsx,jsxs:jsx}
      if(name==='../lib/participantStatus')return catalog
      if(name.endsWith('.css'))return{}
      if(name.startsWith('../assets/status/'))return name
      throw new Error('Unexpected live import '+name)
    },
  })
  return{renderer,render(emoji=token,extra={}){
    let tree=renderer.ParticipantStatusEmoji({emoji,...extra})
    if(typeof tree.type==='function'){
      if(tree.key!==key){key=tree.key;slots=[]}
      cursor=0;tree=tree.type(tree.props)
    }
    return tree
  }}
}
function nodes(tree,type){
  if(!tree||typeof tree!=='object')return[]
  if(Array.isArray(tree))return tree.flatMap(item=>nodes(item,type))
  return[...(tree.type===type?[tree]:[]),...nodes(tree.props?.children,type)]
}

test('penguin is one labeled token in the existing sticker group and retains three-slot limits',()=>{
  assert.equal(catalog.PARTICIPANT_PENGUIN_STATUS,token)
  assert.equal(catalog.PARTICIPANT_STATUS_EMOJIS.filter(value=>value===token).length,1)
  assert.ok(catalog.PARTICIPANT_STATUS_EMOJI_GROUPS.find(group=>group.name==='Стікери').emojis.includes(token))
  assert.equal(catalog.participantStatusEmojiLabel(token),'Пінгвін')
  assert.equal(catalog.PARTICIPANT_STATUS_MAX_EMOJIS,3)
  assert.equal(catalog.PARTICIPANT_STATUS_MAX_LENGTH,48)
})

test('penguin uses the single static asset at 24px or 32px and stays static after load',()=>{
  for(const picker of [false,true]){
    const fx=fixture(),before=fx.render(token,{picker}),image=nodes(before,'img')[0],size=picker?32:24
    assert.equal(nodes(before,'img').length,1)
    assert.match(image.props.src,/penguin-20261016\.png$/)
    assert.equal(image.props.width,size);assert.equal(image.props.height,size)
    assert.match(image.props.className,/object-contain/)
    assert.equal(image.props.draggable,false)
    assert.doesNotMatch(before.props.className,/--animated|--running|--leopard/)
    image.props.onLoad()
    assert.doesNotMatch(fx.render(token,{picker}).props.className,/--animated|--running|--leopard/)
  }
})

test('penguin has a readable accessible label, decorative suppression and native fallback',()=>{
  const fx=fixture(),before=fx.render()
  assert.equal(before.props.role,'img');assert.equal(before.props['aria-label'],'Пінгвін')
  nodes(before,'img')[0].props.onError()
  const failed=fx.render()
  assert.equal(nodes(failed,'img').length,0)
  assert.equal(nodes(failed,'span').at(-1).props.children,'🐧')
  assert.equal(failed.props['aria-label'],'Пінгвін')
  const decorative=fx.render(token,{decorative:true})
  assert.equal(decorative.props['aria-hidden'],true)
  assert.equal(decorative.props.role,undefined);assert.equal(decorative.props['aria-label'],undefined)
  const group=fx.renderer.ParticipantStatusEmojis({status:'sticker:penguin ❤️'})
  assert.equal(group.props['aria-label'],'Емодзі-статус: Пінгвін, ❤️')
  assert.doesNotMatch(group.props['aria-label'],/sticker:/)
})

test('a different selection remounts failed sticker state and every old token retains its renderer',()=>{
  const fx=fixture()
  nodes(fx.render(),'img')[0].props.onError()
  assert.equal(nodes(fx.render(),'img').length,0)
  assert.equal(nodes(fx.render('sticker:frog'),'img').length,1)
  assert.equal(nodes(fx.render(),'img').length,1)
  for(const [emoji,path,count]of[
    ['🦛','hippo-20261014.webp',1],['sticker:cheburashka','cheburashka-20261014.png',2],
    ['sticker:leopard','leopard-run-20261016.png',1],['sticker:frog','frog-20261016.png',1],
  ]){
    const rendered=fx.render(emoji),images=nodes(rendered,'img')
    assert.equal(images.length,count);assert.ok(images[0].props.src.endsWith(path))
  }
  assert.equal(fx.render('😊').props.children,'😊')
  const cheb=fx.render('sticker:cheburashka');for(const image of nodes(cheb,'img'))image.props.onLoad()
  assert.match(fx.render('sticker:cheburashka').props.className,/--animated/)
  nodes(fx.render('sticker:leopard'),'img')[0].props.onLoad()
  assert.match(fx.render('sticker:leopard').props.className,/--running/)
})

test('the production penguin asset is a visible transparent 128px PNG',async()=>{
  const data=await readFile(new URL('src/assets/status/penguin-20261016.png',root))
  assert.equal(data.subarray(1,4).toString(),'PNG')
  const width=data.readUInt32BE(16),height=data.readUInt32BE(20)
  assert.deepEqual([width,height],[128,128])
  assert.equal(data[24],8);assert.equal(data[25],6)
  const chunks=[]
  for(let offset=8;offset<data.length;){
    const length=data.readUInt32BE(offset)
    if(data.subarray(offset+4,offset+8).toString()==='IDAT')chunks.push(data.subarray(offset+8,offset+8+length))
    offset+=length+12
  }
  const filtered=inflateSync(Buffer.concat(chunks)),stride=width*4,pixels=Buffer.alloc(stride*height)
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}
  for(let y=0;y<height;y++)for(let x=0;x<stride;x++){
    const i=y*stride+x,a=x>=4?pixels[i-4]:0,b=y?pixels[i-stride]:0,c=y&&x>=4?pixels[i-stride-4]:0,filter=filtered[y*(stride+1)]
    pixels[i]=(filtered[y*(stride+1)+1+x]+(filter===1?a:filter===2?b:filter===3?Math.floor((a+b)/2):filter===4?paeth(a,b,c):0))&255
  }
  const alpha=pixels.filter((_,i)=>i%4===3)
  assert.ok(alpha.includes(0));assert.ok(alpha.some(value=>value>200));assert.equal(pixels[3],0)
})
