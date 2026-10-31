const valid=(v:string)=>/^20\d{2}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().startsWith(v)
const months=[/^(?:січ|январ)/iu,/^(?:лют|феврал)/iu,/^(?:берез|март)/iu,/^(?:квіт|апрел)/iu,/^(?:трав|ма[йя])/iu,/^(?:черв|июн)/iu,/^(?:лип|июл)/iu,/^(?:серп|август)/iu,/^(?:верес|сентябр)/iu,/^(?:жовт|октябр)/iu,/^(?:листоп|ноябр)/iu,/^(?:груд|декабр)/iu]
export function parseCloudAssistantDate(source:string,now:number):string|undefined{
  if(typeof source!=='string'||source.length>10000||!Number.isFinite(now))return
  const iso=source.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];if(iso)return valid(iso)?iso:undefined
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now)),start=Date.parse(today+'T12:00:00Z')
  const numeric=/(?:^|[^\d])(\d{1,2})[./](\d{1,2})(?:[./](20\d{2}))?(?!\d)/u.exec(source)
  const named=[...source.matchAll(/(\d{1,2})\s+([\p{L}]+)(?:\s+(20\d{2}))?/giu)].find(m=>months.some(p=>p.test(m[2]))),month=named?months.findIndex(p=>p.test(named[2])):-1
  const candidate=numeric?`${numeric[3]||today.slice(0,4)}-${numeric[2].padStart(2,'0')}-${numeric[1].padStart(2,'0')}`:named&&month>=0?`${named[3]||today.slice(0,4)}-${String(month+1).padStart(2,'0')}-${named[1].padStart(2,'0')}`:undefined
  if(candidate)return valid(candidate)?candidate:undefined
  const boundary=(words:string)=>new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${words})(?=$|[^\\p{L}\\p{N}])`,'iu').test(source)
  const offset=boundary('післязавтра|послезавтра')?2:boundary('завтра|завьра|завтрa|завтр')?1:boundary('сьогодні|сегодня')?0:undefined
  if(offset!==undefined)return new Date(start+offset*86400000).toISOString().slice(0,10)
  const index=[/понеділ|понедель/iu,/вівтор|вторник/iu,/серед|сред[ауы]/iu,/четвер/iu,/п[’'`]?ятниц|пятниц/iu,/субот|суббот/iu,/неділ|воскресен/iu].findIndex(p=>p.test(source))
  if(index<0)return
  const current=(new Date(start).getUTCDay()+6)%7,nextWeek=/наступн[^.?!\n]{0,20}тиж|следующ[^.?!\n]{0,20}недел/iu.test(source)
  let days=nextWeek?7-current+index:(index-current+7)%7;if(!nextWeek&&days===0&&/наступн|следующ/iu.test(source))days=7
  return new Date(start+days*86400000).toISOString().slice(0,10)
}
/** Convert a wall-clock Kyiv deadline to UTC and reject nonexistent DST times.
 * Date-only deadlines mean the end of that explicitly supplied day, shown in
 * the review; no deadline word or date means no inferred deadline at all. */
export function parseCloudAssistantDeadline(source:string,now:number):string|null|undefined{
  if(/вільн[^.\n]{0,20}термін|без\s+(?:термін|срок|дедлайн)|свободн[^.\n]{0,20}срок/iu.test(source))return null
  const marker=/(?:термін(?:\s+здачі)?|дедлайн|deadline|здати|сдати|сдать|здача|сдача|до)\s*[:\-]?\s*(.+)/iu.exec(source)
  if(!marker)return undefined
  const date=parseCloudAssistantDate(marker[1],now);if(!date)return undefined
  const time=/(?:^|[^\d])([01]?\d|2[0-3]):([0-5]\d)(?!\d)/u.exec(marker[1])
  const wall=date+'T'+(time?time[1].padStart(2,'0')+':'+time[2]:'23:59')+':00'
  const target=Date.parse(wall+'Z');let instant=target
  const formatter=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'})
  for(let i=0;i<3;i++){const p=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(v=>[v.type,v.value]));const represented=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);instant+=target-represented}
  const p=Object.fromEntries(formatter.formatToParts(new Date(instant)).map(v=>[v.type,v.value]));if(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`!==wall)return undefined
  return new Date(instant).toISOString()
}
