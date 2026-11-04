import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.profile-names-preview.local')
const position = process.argv.indexOf('--port')
const port = position < 0 ? 3085 : Number(process.argv[position + 1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local preview port')
await mkdir(directory, { recursive: true })
await writeFile(path.join(directory, 'index.html'), '<!doctype html><html lang="uk"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Xelay · Прізвище та ім’я</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>')
await writeFile(path.join(directory, 'main.tsx'), `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import'../src/index.css';import{ToastProvider}from'../src/context/ToastContext';import{SeasonalThemePreviewProvider,useTheme}from'../src/context/ThemeContext';import{ProfileSettingsModal}from'../src/components/ProfileSettingsModal';import{AuthModal}from'../src/components/AuthModal';import{useAuth,usePreview}from'virtual:profile-names-state';
function Preview(){const[mode,setMode]=useState('profile');const{ xelayUser }=useAuth();const{reset,lastSaved}=usePreview();const{theme,toggleTheme}=useTheme();const button='rounded-full border border-border px-4 py-2.5 text-sm font-medium hover:bg-muted';return <main className="min-h-screen bg-background px-5 py-10 text-foreground"><div className="mx-auto max-w-3xl"><p className="text-xs font-semibold uppercase tracking-widest text-primary">Xelay · Локальна перевірка профілю</p><h1 className="mt-3 text-3xl font-bold">Спочатку прізвище, потім ім’я</h1><p className="mt-3 text-sm leading-relaxed text-muted-foreground">Це справжні форми профілю та реєстрації з вигаданим акаунтом. Збереження працює лише в пам’яті цієї вкладки, без робочої бази й відправлення листів.</p><div className="mt-5 flex flex-wrap gap-2"><button className={button} onClick={()=>{reset(false);setMode('profile')}}>Профіль зі старим записом</button><button className={button} onClick={()=>{reset(true);setMode('profile')}}>Профіль з окремими полями</button><button className={button} onClick={()=>setMode('register')}>Реєстрація</button><button className={button} onClick={()=>setMode('google')}>Завершення Google</button><button className={button} onClick={toggleTheme}>{theme==='light'?'Темна тема':'Світла тема'}</button></div><section className="mt-6 rounded-2xl border border-border p-5"><p className="text-sm text-muted-foreground">Поточне відображення</p><p className="mt-1 text-2xl font-semibold">{xelayUser.name}</p>{lastSaved&&<pre className="mt-4 overflow-auto rounded-xl bg-muted p-3 text-xs">{JSON.stringify(lastSaved,null,2)}</pre>}<button className={button+' mt-5'} onClick={()=>setMode('profile')}>Відкрити налаштування</button></section></div>{mode==='profile'&&<ProfileSettingsModal key={xelayUser.id+':'+xelayUser.previewVersion} onClose={()=>setMode('none')}/>} {(mode==='register'||mode==='google')&&<AuthModal key={mode} onClose={()=>setMode('none')} {...(mode==='google'?{googleCompletion:{userId:'11111111-1111-4111-8111-111111111111',email:'synthetic@example.invalid',name:'Олена Прикладенко'},onCompleted:()=>setMode('none')}:{})}/>}</main>}
createRoot(document.getElementById('root')!).render(<SeasonalThemePreviewProvider initialTheme="light"><ToastProvider><Preview/></ToastProvider></SeasonalThemePreviewProvider>);`)

const state = `import{useSyncExternalStore}from'react';
const id='11111111-1111-4111-8111-111111111111',university='22222222-2222-4222-8222-222222222222',unit='33333333-3333-4333-8333-333333333333',specialty='44444444-4444-4444-8444-444444444444';
const base={id,userId:id,name:'Олена Прикладенко',username:'synthetic_teacher',email:'synthetic@example.invalid',accountType:'teacher',universityId:university,academicUnitId:unit,faculty:'Економічний факультет',specialty:'Економіка',specialtyId:specialty,categories:[],experience:'',skills:[],helpWith:[],wantToLearn:[],previewVersion:0};let user={...base},lastSaved=null,revision=0;const listeners=new Set();const emit=()=>listeners.forEach(fn=>fn());const subscribe=fn=>{listeners.add(fn);return()=>listeners.delete(fn)};const snapshot=()=>user;
export function useAuth(){const xelayUser=useSyncExternalStore(subscribe,snapshot);return{authUser:{id,email:base.email},xelayUser,isAuthenticated:true,refreshUser:async()=>{}}}
export function usePreview(){useSyncExternalStore(subscribe,snapshot);return{lastSaved,reset(structured){lastSaved=null;user={...base,previewVersion:++revision,...(structured?{firstName:'Олена',lastName:'Прикладенко',name:'Прикладенко Олена'}:{})};emit()}}}
const tables={universities:[{id:university,name:'КНУ · навчальний приклад',slug:'knu',is_active:true}],academic_units:[{id:unit,university_id:university,name:'Економічний факультет',unit_type:'faculty',slug:'economics',is_active:true}],academic_specialties:[{id:specialty,university_id:university,academic_unit_id:unit,name:'Економіка',code:'C1',specialty_name:'Економіка',is_active:true,study_levels:['bachelor','master']}],profiles:[]};
function capture(payload){lastSaved={...(payload.last_name!==undefined?{last_name:payload.last_name}:{}),...(payload.first_name!==undefined?{first_name:payload.first_name}:{}),...(payload.full_name!==undefined?{full_name:payload.full_name}:{})};user={...user,...(payload.full_name!==undefined?{name:payload.full_name}:{}),...(payload.first_name!==undefined?{firstName:payload.first_name}:{}),...(payload.last_name!==undefined?{lastName:payload.last_name}:{})};emit()}
function query(table){let change=null,filters=[];const result=()=>{if(table==='profiles'&&change){capture(change);return{data:[{id}],error:null}}let data=table==='profiles'?[{id,username:user.username,full_name:user.name,first_name:user.firstName,last_name:user.lastName}]:tables[table]||[];for(const[key,value]of filters)data=data.filter(row=>row[key]===value);return{data,error:null}};const chain={select(){return chain},update(value){change=value;return chain},upsert(value){change=value;return chain},eq(key,value){filters.push([key,value]);return chain},order(){return chain},abortSignal(){return chain},returns(){return chain},limit(){return chain},maybeSingle(){const r=result();return Promise.resolve({...r,data:r.data[0]||null})},single(){const r=result();return Promise.resolve({...r,data:r.data[0]||null})},then(resolve,reject){return Promise.resolve(result()).then(resolve,reject)}};return chain}
export const supabase={from:query,rpc(name,payload){const value=name==='xelay_complete_google_registration'?{completed:true}:{};if(name==='xelay_complete_google_registration')capture(payload.p_profile);const response={data:value,error:null};return{abortSignal(){return Promise.resolve(response)},then(resolve,reject){return Promise.resolve(response).then(resolve,reject)}}},auth:{getUser:async()=>({data:{user:{id,email:base.email}},error:null}),getSession:async()=>({data:{session:null},error:null}),signUp:async(options)=>{capture(options.options.data);return{data:{user:{id,user_metadata:options.options.data},session:null},error:null}},resetPasswordForEmail:async()=>({data:{},error:null})}};
export function emailLinkVerifier(){return{auth:{refreshSession:async()=>({data:{session:null,user:null},error:new Error('LOCAL_PREVIEW_EMAIL_LINK_UNAVAILABLE')})}}}
`
const emptyComponents = new Map([
  ['ProfileBadgeSettings', ['ProfileBadgeSettings']], ['SupporterBadgeSettings', ['SupporterBadgeSettings']], ['AppreciationBadge', ['AppreciationBadgeSettings']],
  ['ProfileBirthdaySettings', ['ProfileBirthdaySettings']], ['HalloweenBadge', ['HalloweenBadgeSettings']], ['TeacherStatusCard', ['TeacherStatusCard']], ['TeacherAcademicSettings', ['TeacherAcademicProfileEditor']],
])
const plugin = { name: 'synthetic-profile-preview', enforce: 'pre', resolveId(source) {
  if (source === 'virtual:profile-names-state' || source.endsWith('/AuthContext') || source.endsWith('/supabase')) return '\0profile-names-state'
  if (source === '@tanstack/react-router') return '\0profile-names-router'
  const name = source.split('/').at(-1)
  if (emptyComponents.has(name)) return '\0profile-names-empty:' + name
}, load(id) {
  if (id === '\0profile-names-state') return state
  if (id === '\0profile-names-router') return 'export const useNavigate=()=>()=>{};'
  if (id.startsWith('\0profile-names-empty:')) return emptyComponents.get(id.split(':').at(-1)).map(name => 'export const ' + name + '=()=>null;').join('\n')
} }
const server = await createServer({ root, configFile: false, envDir: false, envPrefix: 'UNUSED_PROFILE_PREVIEW_', plugins: [plugin, react()],
  server: { host: '127.0.0.1', port, strictPort: true, hmr: false, cors: false }, appType: 'mpa' })
await server.listen()
console.log('http://127.0.0.1:' + port + '/.profile-names-preview.local/index.html')
