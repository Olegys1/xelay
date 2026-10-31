import {inflateRawSync} from 'node:zlib'
import * as XLSX from 'xlsx'
import {validateUploadContent} from '../uploadContentValidation.ts'
import {extractValidatedDocxText} from './fileViewer.ts'

export const CLOUD_MATERIAL_LIMITS=Object.freeze({fileBytes:8*1024*1024,totalBytes:12*1024*1024,files:3,textBytes:24000,pdfPages:12,zipExpanded:16*1024*1024,zipPart:4*1024*1024})
const fail=(code='material_file_unsupported'):never=>{throw Object.assign(new Error(code),{code,status:422})}
export function boundedMaterialText(value:string):{text:string;truncated:boolean}{let n=0,result='';for(const ch of value){const size=Buffer.byteLength(ch);if(n+size>CLOUD_MATERIAL_LIMITS.textBytes)return{text:result,truncated:true};result+=ch;n+=size}return{text:result,truncated:false}}
const decode=(b:Uint8Array)=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(b).replace(/^\uFEFF/u,'')}catch{return fail('material_file_encoding')}}
function zipParts(bytes:Buffer):Map<string,Buffer>{
 if(bytes.length<22)return fail();let e=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){e=i;break}
 if(e<0)return fail();const count=bytes.readUInt16LE(e+10),out=new Map<string,Buffer>();if(count>512)return fail('material_file_limit')
 let cursor=bytes.readUInt32LE(e+16),total=0
 for(let i=0;i<count;i++){
  if(cursor+46>e||bytes.readUInt32LE(cursor)!==0x02014b50)return fail()
  const packed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),method=bytes.readUInt16LE(cursor+10),n=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),offset=bytes.readUInt32LE(cursor+42)
  total+=size;if(size>CLOUD_MATERIAL_LIMITS.zipPart||total>CLOUD_MATERIAL_LIMITS.zipExpanded)return fail('material_file_limit')
  if(offset+30>bytes.length||cursor+46+n+extra+comment>e)return fail()
  const name=decode(bytes.subarray(cursor+46,cursor+46+n));if(name.includes('..')||name.includes('\\')||name.startsWith('/')||out.has(name))return fail()
  const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+packed>bytes.length)return fail()
  if(/^ppt\/slides\/slide[1-9]\d*\.xml$/.test(name)){
   const source=bytes.subarray(start,start+packed),part=method===0?source:method===8?inflateRawSync(source,{maxOutputLength:CLOUD_MATERIAL_LIMITS.zipPart}):fail()
   if(part.length!==size)return fail();out.set(name,part)
  }
  cursor+=46+n+extra+comment
 }
 return out
}
function xmlText(xml:string):string{
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))return fail()
 const entity=(s:string)=>s.replace(/&(?:lt|gt|amp|quot|apos|#\d+|#x[a-f\d]+);/gi,v=>{
  const table:Record<string,string>={'&lt;':'<','&gt;':'>','&amp;':'&','&quot;':'"','&apos;':"'"};if(table[v])return table[v]
  const n=parseInt(v.slice(v[2].toLowerCase()==='x'?3:2,-1),v[2].toLowerCase()==='x'?16:10);return n>=0x20&&n<=0x10ffff&&! (n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):''
 })
 return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([^<]*)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)].map(m=>entity(m[1])).join('\n')
}
/** Validated plain text only: no macros, scripts, HTML execution, external
 * relationships, URLs, shell process or image/resource fetching. */
export async function extractCloudMaterialText(input:Uint8Array,file:{name:string;mimeType:string}):Promise<{text:string;truncated:boolean}>{
 if(!(input instanceof Uint8Array)||input.byteLength<1||input.byteLength>CLOUD_MATERIAL_LIMITS.fileBytes)return fail('material_file_limit')
 const bytes=Buffer.from(input),extension=file.name.split('.').pop()?.toLowerCase()||''
 if(!['pdf','docx','pptx','xlsx','xls','txt','csv'].includes(extension))return fail()
 const parts=extension==='pptx'?zipParts(bytes):null
 await validateUploadContent(bytes,extension,file.mimeType)
 if(extension==='docx')return boundedMaterialText(await extractValidatedDocxText(bytes))
 if(extension==='txt'||extension==='csv')return boundedMaterialText(decode(bytes))
 if(extension==='pptx')return boundedMaterialText([...parts!.entries()].sort((a,b)=>Number(/slide(\d+)/.exec(a[0])?.[1])-Number(/slide(\d+)/.exec(b[0])?.[1])).map(([,part],i)=>{const t=xmlText(decode(part));return t.trim()?`Слайд ${i+1}\n${t}`:''}).filter(Boolean).join('\n\n'))
 if(extension==='xlsx'||extension==='xls'){
  const book=XLSX.read(bytes,{type:'buffer',cellFormula:false,cellHTML:false,cellStyles:false,bookVBA:false,dense:true})
  const value=book.SheetNames.slice(0,5).map(name=>`${name}\n${XLSX.utils.sheet_to_json<any[]>(book.Sheets[name],{header:1,raw:false}).slice(0,200).map(row=>row.slice(0,30).map(v=>String(v??'').slice(0,1000)).join('\t')).join('\n')}`).join('\n\n')
  const bounded=boundedMaterialText(value);return{...bounded,truncated:bounded.truncated||book.SheetNames.length>5}
 }
 const pdf=await import('pdfjs-dist/legacy/build/pdf.mjs')
 // PDF.js 6 removed the legacy eval option and font-script evaluator. Use
 // actual supported flags to keep this byte-only extraction off network paths.
 const parameters={data:new Uint8Array(bytes),disableAutoFetch:true,disableStream:true,useWorkerFetch:false,disableFontFace:true,useSystemFonts:false,enableXfa:false,stopAtErrors:true} satisfies NonNullable<Parameters<typeof pdf.getDocument>[0]>
 const task=pdf.getDocument(parameters)
 try{
  const document=await task.promise;if(document.numPages>200)return fail('material_file_limit')
  const chunks:string[]=[];let truncated=document.numPages>CLOUD_MATERIAL_LIMITS.pdfPages
  for(let i=1;i<=Math.min(document.numPages,CLOUD_MATERIAL_LIMITS.pdfPages);i++){
   const page=await document.getPage(i),content=await page.getTextContent(),text=content.items.map(item=>'str'in item?item.str:'').join(' ').trim();if(text)chunks.push(`Сторінка ${i}\n${text}`);page.cleanup()
   if(Buffer.byteLength(chunks.join('\n\n'))>CLOUD_MATERIAL_LIMITS.textBytes){truncated=true;break}
  }
  const bounded=boundedMaterialText(chunks.join('\n\n'));return{...bounded,truncated:truncated||bounded.truncated}
 }finally{await task.destroy()}
}
