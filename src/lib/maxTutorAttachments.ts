import type {TutorSource} from './maxTutor'

export const MAX_TUTOR_ATTACHMENT_ACCEPT='.txt,.md,.doc,.docx,.pdf,text/plain,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/pdf'
export const MAX_TUTOR_ATTACHMENT_LIMITS=Object.freeze({files:3,fileBytes:10*1024*1024,totalBytes:20*1024*1024,textBytes:24000})
const EXTENSIONS=new Set(['txt','md','doc','docx','pdf'])
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)throw new DOMException('Читання зупинено.','AbortError')}
const encoder=new TextEncoder()

/** Keep a complete UTF-8 boundary, never split a surrogate pair or conceal truncation. */
export function maxTutorAttachmentExcerpt(text:string,maximumBytes:number):{text:string;truncated:boolean}{
 if(typeof text!=='string'||!Number.isSafeInteger(maximumBytes)||maximumBytes<1||maximumBytes>24000)throw Error('Некоректний обсяг уривка.')
 const clean=text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').trim()
 if(!clean||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(clean))throw Error('У файлі немає придатного навчального тексту.')
 if(/<\/?[a-z][^>]*>/i.test(clean))throw Error('Файл містить HTML. Додайте звичайний текст без HTML-тегів.')
 if(encoder.encode(clean).length<=maximumBytes&&clean.length<=20000)return {text:clean,truncated:false}
 let output='',size=0
 for(const character of clean){const bytes=encoder.encode(character).length;if(size+bytes>maximumBytes||output.length+character.length>20000)break;output+=character;size+=bytes}
 if(!output.trim())throw Error('Уривок завеликий. Вставте потрібний текст окремо.')
 return {text:output.trimEnd(),truncated:true}
}

/** Reads only explicit File objects on this device. No upload, URL fetch, OCR or model call. */
export async function readMaxTutorAttachments(files:readonly File[],options:{signal?:AbortSignal}={}):Promise<{sources:TutorSource[];warnings:string[]}>{
 if(!Array.isArray(files)||files.length<1||files.length>MAX_TUTOR_ATTACHMENT_LIMITS.files)throw Error('Додайте від одного до трьох файлів.')
 let total=0
 for(const file of files){
  if(!file||typeof file.name!=='string'||typeof file.arrayBuffer!=='function'||!Number.isSafeInteger(file.size)||file.size<1||file.size>MAX_TUTOR_ATTACHMENT_LIMITS.fileBytes)throw Error('Оберіть непорожній файл до 10 МБ.')
  const extension=file.name.toLowerCase().split('.').pop()||''
  if(!EXTENSIONS.has(extension))throw Error('Підтримуються TXT, MD, DOC, DOCX і текстовий PDF. Для фото чи сканів поки вставте розпізнаний текст.')
  total+=file.size
  if(total>MAX_TUTOR_ATTACHMENT_LIMITS.totalBytes)throw Error('Загальний розмір файлів має бути до 20 МБ.')
 }
 abort(options.signal)
 const {extractTeachingQuestionFile}=await import('./teachingQuestionImportFiles')
 const sources:TutorSource[]=[],warnings:string[]=[],perFile=Math.floor(MAX_TUTOR_ATTACHMENT_LIMITS.textBytes/files.length)
 for(const file of files){
  abort(options.signal)
  const extracted=await extractTeachingQuestionFile(file)
  abort(options.signal)
  const excerpt=maxTutorAttachmentExcerpt(extracted.text,perFile)
  const name=file.name.replace(/[\u0000-\u001f\u007f<>\u202a-\u202e\u2066-\u2069]/g,'').slice(0,170).trim()||'Мій матеріал'
  sources.push({id:'file-'+crypto.randomUUID(),title:name+(excerpt.truncated?' · початковий уривок':''),text:excerpt.text,page:null,kind:'own_excerpt'})
  if(excerpt.truncated)warnings.push(`«${name}»: вибрано лише початковий уривок (${encoder.encode(excerpt.text).length.toLocaleString('uk-UA')} байт). Перегляньте його перед надсиланням; повний файл не передається моделі.`)
  if(/\.pdf$/i.test(file.name))warnings.push(`«${name}»: прочитано лише текстовий шар PDF. Зображення та рукописні сторінки не розпізнавалися.`)
  if(/\.docx?$/i.test(file.name))warnings.push(`«${name}»: додано текст документа. Перевірте формули й таблиці у вибраному уривку.`)
 }
 return {sources,warnings}
}
