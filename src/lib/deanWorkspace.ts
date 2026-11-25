/** Private interchange with the local solver. No student data is bundled in the app. */
export const DEAN_ACTIVITY_LABELS = { lecture: 'Лекція', practice: 'Практичне заняття', seminar: 'Семінар', lab: 'Лабораторна робота' } as const
export type DeanActivity = keyof typeof DEAN_ACTIVITY_LABELS
export type DeanRoom = { id:string; capacity:number|null; computer:boolean; disabled:boolean; allowedPrograms:string[]; blockedSlots:[number,number][]; note:string }
export type DeanEvent = { id: string; course: string; activity: DeanActivity; teacher: string; teacherIds: string[]; studentIds: string[]; day: number; period: number; weeks: number[]; room?:string; section?:string|number }
export type DeanSource = { events: DeanEvent[]; students: { id: string; name: string; group: string }[]; blockers: unknown[]; metadata: Record<string, unknown>; rooms?:DeanRoom[] }
export type DeanMapping = Record<string, { userId: string; groupId: string }>
export type DeanRosterGroup = { id: string; name: string; members: { id: string; name: string; username: string }[] }
export const DEAN_TIMES = [['08:00','09:20'],['09:40','11:00'],['11:20','12:40'],['12:50','14:10'],['14:30','15:50'],['16:00','17:20']]
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown, max = 200): v is string => typeof v === 'string' && !!v.trim() && v.length <= max
const int = (v: unknown, max: number): v is number => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= max
export function parseDeanRooms(input:unknown):DeanRoom[]{
 if(!Array.isArray(input)||input.length>200)throw Error('Вкажіть до 200 аудиторій.')
 const ids=new Set<string>()
 return input.map(r=>{
  if(!object(r)||!text(r.id,80)||ids.has(r.id)||typeof r.computer!=='boolean'||typeof r.disabled!=='boolean'||!(r.disabled&&r.capacity===null||int(r.capacity,5000))||!Array.isArray(r.allowedPrograms)||r.allowedPrograms.length>100||r.allowedPrograms.some(p=>!text(p,120))||!Array.isArray(r.blockedSlots)||r.blockedSlots.length>30||r.blockedSlots.some(s=>!Array.isArray(s)||s.length!==2||!int(s[0],5)||!int(s[1],6)))throw Error('Перевірте номер, місткість і доступність аудиторії.')
  ids.add(r.id);return {id:r.id,capacity:r.capacity as number|null,computer:r.computer,disabled:r.disabled,allowedPrograms:r.allowedPrograms as string[],blockedSlots:r.blockedSlots as DeanRoom['blockedSlots'],note:typeof r.note==='string'?r.note.slice(0,1000):''}
 })
}
export function parseDeanSource(input: unknown, validatePlacement=true): DeanSource {
  const data = object(input) && object(input.payload) ? input.payload : input
  if (!object(data) || !Array.isArray(data.students) || !Array.isArray(data.events) || !data.events.length || data.events.length > 1500 || data.students.length > 5000) throw Error('Потрібен файл експорту кабінету деканату (до 1500 занять).')
  const ids = new Set<string>(), eventIds = new Set<string>()
  const students = data.students.map(s => {
    if (!object(s) || !text(s.id) || !text(s.name) || typeof s.group !== 'string' || s.group.length > 120 || ids.has(s.id)) throw Error('Некоректний список студентів.')
    ids.add(s.id); return { id: s.id, name: s.name, group: s.group }
  })
  const events = data.events.map(e => {
    if (!object(e) || !text(e.id) || eventIds.has(e.id) || !text(e.course, 120) || typeof e.activity !== 'string' || !Object.prototype.hasOwnProperty.call(DEAN_ACTIVITY_LABELS, e.activity) || typeof e.teacher !== 'string' || e.teacher.length > 180 || !int(e.day,5) || !int(e.period,6)
      || !Array.isArray(e.weeks) || !e.weeks.length || e.weeks.length > 30 || e.weeks.some(w=>!int(w,30)) || new Set(e.weeks).size !== e.weeks.length
      || !Array.isArray(e.studentIds) || !e.studentIds.length || e.studentIds.some(id=>typeof id !== 'string' || !ids.has(id)) || new Set(e.studentIds).size !== e.studentIds.length
      || !Array.isArray(e.teacherIds) || e.teacherIds.some(id=>!text(id)) || (e.activity === 'lab' && e.studentIds.length > 18)) throw Error('Некоректне заняття, склад групи або кількість студентів лабораторної.')
    eventIds.add(e.id)
    if(e.room!==undefined&&!text(e.room,80)||e.section!==undefined&&!text(e.section,120)&&!int(e.section,5000))throw Error('Некоректна аудиторія або підгрупа.')
    return { id:e.id, course:e.course, activity:e.activity as DeanActivity, teacher:e.teacher, teacherIds:e.teacherIds as string[], studentIds:e.studentIds as string[], day:e.day, period:e.period, weeks:e.weeks as number[],...(e.room?{room:e.room as string}:{}),...(e.section?{section:e.section as string|number}:{}) }
  })
  const occupied = new Set<string>()
  for (const e of validatePlacement?events:[]) for (const week of e.weeks) for (const person of [...e.studentIds.map(id=>`s:${id}`), ...e.teacherIds.map(id=>`t:${id}`)]) {
    const key = `${person}:${week}:${e.day}:${e.period}`
    if (occupied.has(key)) throw Error('У розрахунку є накладка студента або викладача.')
    occupied.add(key)
  }
  const roomInput=data.rooms??(object(input)?input.roomInventory:undefined)
  const rooms=roomInput===undefined?undefined:parseDeanRooms(roomInput)
  if(validatePlacement&&rooms){
   const assigned=new Set<string>()
   for(const e of events){
    const r=rooms.find(r=>r.id===e.room)
    if(!r||r.disabled||r.capacity===null||e.studentIds.length>r.capacity+3||e.activity==='lab'&&!r.computer||r.blockedSlots.some(b=>b[0]===e.day&&b[1]===e.period)||r.allowedPrograms.length&&e.studentIds.some(id=>!r.allowedPrograms.map(p=>p.trim().toLocaleUpperCase()).includes(students.find(s=>s.id===id)!.group.split('-')[0].trim().toLocaleUpperCase())))throw Error('Аудиторія не відповідає заняттю, місткості або доступному часу.')
    for(const w of e.weeks){const key=`${r.id}:${w}:${e.day}:${e.period}`;if(assigned.has(key))throw Error('В аудиторії дві пари одночасно.');assigned.add(key)}
   }
  }
  return { students, events, blockers:Array.isArray(data.blockers)?data.blockers:[], metadata:object(data.metadata)?data.metadata:{},...(rooms?{rooms}:{}) }
}
export function deanPublicationRows(source: DeanSource, mapping: DeanMapping, monday: string) {
  const date = new Date(`${monday}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(monday) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0,10)!==monday || date.getUTCDay()!==1) throw Error('Оберіть дату понеділка першого навчального тижня.')
  const used = new Map<string,string>()
  const rows: { sourceId:string; groupId:string; userIds:string[]; subject:string; teacher:string; teacherIds:string[]; activity:string; date:string; period:number; room?:string }[] = []
  for (const e of source.events) {
    const groups = new Map<string,string[]>()
    for (const id of e.studentIds) {
      const m = mapping[id]
      if (!m?.userId || !m.groupId) throw Error('Прив’яжіть усіх студентів із заняттями до акаунтів Xelay.')
      if (used.has(m.userId) && used.get(m.userId)!==id) throw Error('Один акаунт не можна прив’язати до двох студентів.')
      used.set(m.userId,id)
      groups.set(m.groupId,[...(groups.get(m.groupId)??[]),m.userId])
    }
    for (const week of e.weeks) for (const [groupId,userIds] of groups) rows.push({ sourceId:e.id, groupId,userIds,subject:e.course,teacher:e.teacher,teacherIds:e.teacherIds,activity:e.activity,date:new Date(date.valueOf()+((week-1)*7+e.day-1)*86400000).toISOString().slice(0,10),period:e.period,...(e.room?{room:e.room}:{}) })
  }
  if (rows.length>20000) throw Error('Завеликий пакет: розділіть публікацію на семестри.')
  return rows
}
