export type MaxStudioCapture={id:string;title:string;sourceTitle:string;page:number|null;quote:string;note:string;createdAt:string}
export const MAX_STUDIO_INBOX_KEY='xelay:local-max-studio:source-inbox:v1'
export function normalizeMaxCapture(value:unknown):MaxStudioCapture|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as Record<string,unknown>,text=(x:unknown,max:number)=>typeof x==='string'&&x.trim().length>0&&x.length<=max
 if(typeof v.id!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,100}$/.test(v.id)||['constructor','prototype'].includes(v.id)||!text(v.title,200)||!text(v.sourceTitle,200)||!text(v.quote,12000)||typeof v.note!=='string'||v.note.length>4000||!(v.page===null||Number.isInteger(v.page)&&Number(v.page)>=1&&Number(v.page)<=150)||typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt)))return null
 return {id:v.id,title:v.title as string,sourceTitle:v.sourceTitle as string,page:v.page as number|null,quote:v.quote as string,note:v.note,createdAt:v.createdAt}
}
export function parseMaxInbox(raw:string|null):MaxStudioCapture[]{
 if(!raw||raw.length>1_500_000)return []
 try{const value=JSON.parse(raw);if(!Array.isArray(value))return [];const result:MaxStudioCapture[]=[],ids=new Set<string>();for(const entry of value){const item=normalizeMaxCapture(entry);if(item&&!ids.has(item.id)){result.push(item);ids.add(item.id)}}return result.slice(-100)}catch{return []}
}
