export const RESEARCH_STORAGE_KEY='xelay:local-max-research:synthetic:v1'
export const RESEARCH_PDF_MAX_BYTES=15*1024*1024
export const RESEARCH_PDF_MAX_PAGES=150
export const RESEARCH_MAX_SOURCES=5
export type ResearchSource={id:string;title:string;pages:number;lastPage:number;bookmarks:number[];createdAt:string}
export type ResearchExcerpt={id:string;title:string;sourceTitle:string;sourceId:string;page:number|null;quote:string;note:string;createdAt:string}
export type ResearchState={version:1;sources:ResearchSource[];excerpts:ResearchExcerpt[];activeId:string}
export const RESEARCH_DEMO_ID='demo-economic-choice'
export const RESEARCH_DEMO_PAGES=[
 'ЕКОНОМІЧНИЙ ВИБІР\n\nАльтернативна вартість — цінність найкращої можливості, від якої ми відмовляємося, коли робимо вибір. Це не сума всіх можливих альтернатив.\n\nУявімо, що студент обирає між вечором підготовки та оплачуваною зміною. Якщо він готується, альтернативною вартістю може бути заробіток, який він не отримає за зміну.\n\nПоняття допомагає пояснити, чому навіть корисне рішення має ціну. Гроші — лише один зі способів вимірювання цієї ціни. Інколи важливішими є час, досвід або можливість відпочити.\n\nНавчальний авторський приклад Xelay. Це вигаданий фрагмент для демонстрації інструментів читання.',
 'ПОПИТ: РУХ ЧИ ЗМІЩЕННЯ?\n\nЗміна власної ціни товару за інших рівних умов спричиняє рух уздовж кривої попиту. Це зміна величини попиту.\n\nЗміна доходів, уподобань або цін пов’язаних товарів може змістити всю криву. Тоді ми говоримо про зміну попиту.\n\nПеред відповіддю на задачу варто запитати себе: що саме змінилося? Якщо лише власна ціна — шукаємо нову точку на тій самій кривій. Якщо зовнішній чинник — перевіряємо можливість зміщення.\n\nПорівняй два випадки: кава подорожчала; кава стала популярнішою через зміну вподобань. Перший приклад описує рух уздовж кривої, другий може описувати її зміщення.\n\nНавчальний авторський приклад Xelay.',
]
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const instant=(v:unknown):v is string=>typeof v==='string'&&v.length<=40&&Number.isFinite(Date.parse(v))
export function initialResearchState(empty=false):ResearchState{return {version:1,sources:[],excerpts:[],activeId:empty?'':RESEARCH_DEMO_ID}}
export function validateResearchPdf(buffer:ArrayBuffer,fileName:string,size=buffer.byteLength){
 if(!(buffer instanceof ArrayBuffer)||!Number.isSafeInteger(size)||size<=0||size!==buffer.byteLength||size>RESEARCH_PDF_MAX_BYTES)throw new Error('Оберіть PDF до 15 МБ.')
 if(!/\.pdf$/i.test(fileName)||!new TextDecoder().decode(new Uint8Array(buffer,0,Math.min(8,buffer.byteLength))).startsWith('%PDF-'))throw new Error('Потрібен справжній PDF-файл.')
 return true
}
export function validateResearchPages(pages:number){if(!Number.isSafeInteger(pages)||pages<1||pages>RESEARCH_PDF_MAX_PAGES)throw new Error('PDF має містити від 1 до 150 сторінок. Завантажте потрібну главу окремо.');return pages}
export function cleanResearchExcerpt(value:unknown):ResearchExcerpt|null{
 if(!object(value)||!id(value.id)||!id(value.sourceId)||!text(value.title,160)||!value.title.trim()||!text(value.sourceTitle,160)||!value.sourceTitle.trim()||!text(value.quote,4000)||!value.quote.trim()||!text(value.note,3000)||!instant(value.createdAt)||!(value.page===null||Number.isInteger(value.page)&&Number(value.page)>=1&&Number(value.page)<=150))return null
 return {id:value.id,title:value.title.trim(),sourceId:value.sourceId,sourceTitle:value.sourceTitle.trim(),page:value.page as number|null,quote:value.quote.trim(),note:value.note,createdAt:value.createdAt}
}
export function parseResearchState(raw:string|null,empty=false):ResearchState{
 const state=initialResearchState(empty);if(!raw||raw.length>1_500_000)return state
 try{const v=JSON.parse(raw);if(!object(v)||v.version!==1||!Array.isArray(v.sources)||!Array.isArray(v.excerpts))return state
 const seen=new Set<string>();for(const s of v.sources){if(!object(s)||!id(s.id)||s.id===RESEARCH_DEMO_ID||seen.has(s.id)||!text(s.title,160)||!s.title.trim()||!Number.isInteger(s.pages)||Number(s.pages)<1||Number(s.pages)>150||!instant(s.createdAt))continue
 const pages=Number(s.pages);state.sources.push({id:s.id,title:s.title.trim(),pages,lastPage:Number.isInteger(s.lastPage)?Math.max(1,Math.min(pages,Number(s.lastPage))):1,createdAt:s.createdAt,bookmarks:Array.isArray(s.bookmarks)?[...new Set(s.bookmarks.filter((n:unknown):n is number=>typeof n==='number'&&Number.isInteger(n)&&n>=1&&n<=pages))].slice(0,150):[]});seen.add(s.id);if(state.sources.length===5)break}
 const allowedSources=new Set([...(empty?[]:[RESEARCH_DEMO_ID]),...state.sources.map(s=>s.id)]);seen.clear();for(const candidate of v.excerpts){const e=cleanResearchExcerpt(candidate);if(!e||seen.has(e.id)||!allowedSources.has(e.sourceId))continue;const max=e.sourceId===RESEARCH_DEMO_ID?2:state.sources.find(s=>s.id===e.sourceId)!.pages;if(e.page!==null&&e.page>max)continue;state.excerpts.push(e);seen.add(e.id);if(state.excerpts.length===200)break}
 if(typeof v.activeId==='string'&&allowedSources.has(v.activeId))state.activeId=v.activeId
 return state
 }catch{return state}
}
export type ResearchSearchResult={page:number;snippet:string;offset:number}
export function searchResearchPages(pages:readonly string[],query:string):ResearchSearchResult[]{
 const needle=query.trim().slice(0,100).toLocaleLowerCase('uk-UA');if(needle.length<2)return []
 const result:ResearchSearchResult[]=[];let total=0
 for(let i=0;i<Math.min(150,pages.length);i++){const raw=pages[i]||'',body=raw.slice(0,80000);total+=body.length;if(total>2_000_000)break
 const lower=body.toLocaleLowerCase('uk-UA');let offset=0;while((offset=lower.indexOf(needle,offset))!==-1){result.push({page:i+1,offset,snippet:body.slice(Math.max(0,offset-55),Math.min(body.length,offset+needle.length+100))});offset+=needle.length;if(result.length>=80)return result}}
 return result
}
export function researchTextSegments(body:string,query:string):{text:string;hit:boolean}[]{
 const needle=query.trim().slice(0,100);if(needle.length<2)return [{text:body,hit:false}]
 const lower=body.toLocaleLowerCase('uk-UA'),target=needle.toLocaleLowerCase('uk-UA'),result:{text:string;hit:boolean}[]=[];let cursor=0,found=0,count=0
 while((found=lower.indexOf(target,cursor))!==-1&&count++<100){if(found>cursor)result.push({text:body.slice(cursor,found),hit:false});result.push({text:body.slice(found,found+target.length),hit:true});cursor=found+target.length}
 result.push({text:body.slice(cursor),hit:false});return result
}
export function exportResearchExcerpts(excerpts:ResearchExcerpt[]):string{return excerpts.map(e=>`${e.title}\n${e.sourceTitle}${e.page?` · с. ${e.page}`:''}\n\n${e.quote}\n${e.note?`\nМоя нотатка: ${e.note}\n`:''}`).join('\n──────────\n\n')}

const dbName='xelay-local-max-research-v1'
export function researchOwnerDatabaseName(ownerId?:string):string{if(ownerId!==undefined&&(!id(ownerId)||ownerId==='__proto__'||ownerId==='constructor'))throw Error('Некоректний власник особистого сховища.');return ownerId?dbName+':owner:'+ownerId:dbName}
async function researchDatabase(ownerId?:string):Promise<IDBDatabase>{return new Promise((resolve,reject)=>{if(typeof indexedDB==='undefined'){reject(new Error('Локальне сховище PDF недоступне.'));return}const r=indexedDB.open(researchOwnerDatabaseName(ownerId),1);r.onupgradeneeded=()=>{if(!r.result.objectStoreNames.contains('pdfs'))r.result.createObjectStore('pdfs',{keyPath:'id'})};r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(new Error('Не вдалося відкрити локальне сховище PDF.'))})}
export async function storeResearchPdf(sourceId:string,bytes:ArrayBuffer,ownerId?:string):Promise<void>{if(!id(sourceId)||bytes.byteLength>RESEARCH_PDF_MAX_BYTES)throw new Error('Некоректний PDF.');const db=await researchDatabase(ownerId);try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('pdfs','readwrite');tx.objectStore('pdfs').put({id:sourceId,bytes});tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('Немає місця для PDF. Файл не збережено.'));tx.onabort=()=>reject(new Error('Збереження PDF перервано.'))})}finally{db.close()}}
export async function readResearchPdf(sourceId:string,ownerId?:string):Promise<ArrayBuffer|null>{if(!id(sourceId))return null;const db=await researchDatabase(ownerId);try{return await new Promise((resolve,reject)=>{const tx=db.transaction('pdfs','readonly'),r=tx.objectStore('pdfs').get(sourceId);r.onsuccess=()=>resolve(r.result?.bytes instanceof ArrayBuffer?r.result.bytes:null);r.onerror=()=>reject(new Error('Не вдалося прочитати збережений PDF.'))})}finally{db.close()}}
export async function deleteResearchPdf(sourceId:string,ownerId?:string):Promise<void>{if(!id(sourceId))return;const db=await researchDatabase(ownerId);try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('pdfs','readwrite');tx.objectStore('pdfs').delete(sourceId);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(new Error('Не вдалося видалити локальну копію PDF.'))})}finally{db.close()}}
