import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const dataModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const fixture = { profile: null, states: [], cursor: 0, calls: [], refreshes: 0, submitError: null }
globalThis.__representativeProfileClient = fixture
const react = dataModule(`export const useEffect=()=>{};export const useState=initial=>{const x=globalThis.__representativeProfileClient,i=x.cursor++;if(!(i in x.states))x.states[i]=typeof initial==='function'?initial():initial;return[x.states[i],v=>{x.states[i]=typeof v==='function'?v(x.states[i]):v}];}`)
const jsx = dataModule(`export const jsx=(type,props)=>({type,props});export const jsxs=jsx;export const Fragment='Fragment';`)
const router = dataModule('export const useNavigate=()=>()=>{}')
const icons = dataModule('export const BadgeCheck=()=>null,Loader2=()=>null,ShieldQuestion=()=>null')
const auth = dataModule(`export const useAuth=()=>({authUser:{id:'test-user'},xelayUser:globalThis.__representativeProfileClient.profile,refreshUser:async()=>{globalThis.__representativeProfileClient.refreshes++}})`)
const database = dataModule(`const x=globalThis.__representativeProfileClient;export const supabase={rpc:async(name,args)=>{x.calls.push({name,args});return{error:x.submitError}},from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:()=>q,maybeSingle:async()=>({data:{id:'request',status:'pending',group_name:'МА-2'}})};return q}}`)

async function pureModule(path) {
  return dataModule(ts.transpileModule(await readFile(new URL(path, root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText)
}
let componentSource = ts.transpileModule(await readFile(new URL('src/components/ClassRepresentativeRequestCard.tsx', root), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
for (const [specifier, url] of Object.entries({
  react, 'react/jsx-runtime': jsx, '@tanstack/react-router': router, 'lucide-react': icons,
  '../context/AuthContext': auth, '../lib/supabase': database,
  '../lib/academicStatus': await pureModule('src/lib/academicStatus.ts'),
  '../lib/studyYearProgression': await pureModule('src/lib/studyYearProgression.ts'),
})) componentSource = componentSource.replaceAll(`from "${specifier}"`, `from ${JSON.stringify(url)}`).replaceAll(`from '${specifier}'`, `from ${JSON.stringify(url)}`)
const { ClassRepresentativeRequestCard } = await import(dataModule(componentSource))

const ready = { name: 'Тестова староста', universityId: 'university', academicUnitId: 'faculty', specialty: 'Міжнародна аналітика', studyYear: 1, experience: 'bachelor' }
function render(profile) {
  fixture.profile = profile; fixture.cursor = 0; fixture.calls = []; fixture.refreshes = 0; fixture.submitError = null
  fixture.states = [null, false, true, ' МА-2 ', 'telegram', ' @test_leader ', false, '']
  return ClassRepresentativeRequestCard({ onEditProfile() {} })
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
async function submit(tree) {
  nodes(tree).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} })
  await new Promise(resolve => setImmediate(resolve))
}

test('representative application rejects missing or invalid course even if submit handler is invoked directly', async () => {
  for (const studyYear of [undefined, null, 0, 7, 1.5, '1']) {
    const tree = render({ ...ready, studyYear })
    assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, true)
    await submit(tree)
    assert.equal(fixture.calls.length, 0)
    assert.match(fixture.states[7], /поточний курс/)
  }
})

test('representative application requires active study status and the existing identity fields', async () => {
  for (const patch of [{ experience: 'graduate' }, { experience: 'Student / Fresh Graduate' }, { experience: '' }, { name: '  ' }, { name: undefined }, { universityId: null }, { academicUnitId: null }, { specialty: '  ' }]) {
    const tree = render({ ...ready, ...patch })
    await submit(tree)
    assert.equal(fixture.calls.length, 0)
    assert.ok(fixture.states[7].length > 0)
  }
})

test('ready bachelor, master, and postgraduate profiles keep the original application RPC contract', async () => {
  for (const experience of ['bachelor', 'master', 'postgraduate']) {
    const tree = render({ ...ready, experience })
    assert.equal(nodes(tree).find(node => node.type === 'button' && node.props.type === 'submit').props.disabled, false)
    await submit(tree)
    assert.deepEqual(fixture.calls, [{ name: 'xelay_submit_class_representative_request', args: { p_group_name: 'МА-2', p_telegram_username: 'test_leader', p_phone: null } }])
    assert.equal(fixture.refreshes, 1)
    assert.equal(fixture.states[2], false)
  }
})

test('server GROUP_COHORT_REQUIRED response gives a precise course/status instruction', async () => {
  const tree = render(ready)
  fixture.submitError = { message: 'GROUP_COHORT_REQUIRED' }
  await submit(tree)
  assert.match(fixture.states[7], /поточний курс від 1 до 6/)
  assert.match(fixture.states[7], /бакалаврат, магістратура або аспірантура/)
})
