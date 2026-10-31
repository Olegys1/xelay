type Row = Record<string, any>
const subjectWords=(value:string)=>value.normalize('NFKC').toLocaleLowerCase('uk').replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim()
const hasSubjectPhrase=(source:string,phrase:string)=>!!phrase&&(' '+subjectWords(source)+' ').includes(' '+phrase+' ')
/** A model slot is only a suggestion, never evidence that a user named a
 * subject. Explicit scope/confirmed choices are handled by the caller. */
export function cloudSubjectEvidence(name:string,candidate:unknown,sources:string[],catalogNames:readonly string[]=[name]):boolean{
  const canonical=subjectWords(name)
  if(!canonical)return false
  if(sources.some(source=>hasSubjectPhrase(source,canonical)))return true
  if(/вищ[\p{L}]*\s+математ|высш[\p{L}]*\s+математ/iu.test(canonical)
    &&catalogNames.filter(item=>/вищ[\p{L}]*\s+математ|высш[\p{L}]*\s+математ/iu.test(subjectWords(item))).length===1
    &&sources.some(source=>/(?:^|[^\p{L}\p{N}])(?:в[иы]ш\s*мат[а-яіїє]*|вищ\s*мат[а-яіїє]*|вищ[а-яіїє]*\s+математ[а-яіїє]*|высш[а-я]*\s+математ[а-я]*)(?=$|[^\p{L}\p{N}])/iu.test(source)))return true
  if(typeof candidate!=='string'||/^subject\d+$/u.test(candidate)||/^[a-f\d-]{36}$/iu.test(candidate))return false
  const alias=subjectWords(candidate)
  return alias.replace(/\s/g,'').length>=4&&hasSubjectPhrase(name,alias)&&catalogNames.filter(item=>hasSubjectPhrase(item,alias)).length===1&&sources.some(source=>hasSubjectPhrase(source,alias))
}
export const CLOUD_SKILL_ACTIONS = [
  'organizer.task.create',
  'schedule.update','schedule.move','schedule.copy','schedule.import','homework.batch',
  'seminar.subject.upsert','seminar.schedule.upsert','seminar.prepare','seminar.reopen','seminar.book','seminar.team.join',
  'teaching.assignment.upsert','teaching.publication.schedule','teaching.material.upsert',
  'teaching.material.visibility','teaching.material.collaborators','teaching.material.ai','teaching.grades.save','teaching.grading.save',
  'materials.explain','study.plan','community.compose',
] as const
export type CloudSkillAction = typeof CLOUD_SKILL_ACTIONS[number]
export interface CloudActionForm {
  action: string; title: string; scope: { groupId?: string; courseId?: string; date?: string }
  payload: Row; fields: { key: string; label: string; type: string; required?: boolean; options?: {value:string;label:string}[] }[]
}
export function allowedCloudSkillActions(group: Row | undefined, courses: Row[], teachingMode: boolean): string[] {
  const actions: string[] = ['community.compose','organizer.task.create']
  if (group?.learning && !teachingMode) {
    actions.push('study.plan','materials.explain','seminar.book','seminar.team.join')
    if (group.permissions?.includes('schedule')) actions.push('schedule.update','schedule.move','schedule.copy','schedule.import')
    if (group.permissions?.includes('homework')) actions.push('homework.batch')
    if (group.permissions?.some((p:string)=>['seminars','seminar'].includes(p))) actions.push('seminar.subject.upsert','seminar.schedule.upsert','seminar.prepare','seminar.reopen')
  }
  if (teachingMode) {
    if (courses.some(c=>c.permissions?.includes('materials'))) actions.push('materials.explain','teaching.material.upsert','teaching.material.visibility','teaching.material.collaborators','teaching.material.ai')
    if (courses.some(c=>c.permissions?.includes('assignments'))) actions.push('teaching.assignment.upsert','teaching.publication.schedule')
    if (courses.some(c=>c.permissions?.includes('grades'))) actions.push('teaching.grades.save')
    if (courses.some(c=>c.permissions?.includes('manage'))) actions.push('teaching.grading.save')
  }
  return actions
}
export function userRequestedSkill(action: CloudSkillAction, command: string) {
  const text = command.normalize('NFKC').toLocaleLowerCase('uk')
  if (/(?:не|ні|not|don't|do not)\s+(?:дода|добав|змін|измен|запис|сохра|публі|публи|перен|створ|созда|заброн|брон|обнов)/iu.test(text)) return false
  const mutate = /дод|добав|змін|измен|онов|обнов|редаг|редакт|перен|скоп|створ|созда|заплан|опублі|публи|збереж|сохран|запиш|внес|вистав|постав|заброн|брон|приєдн|вступ|відкр|откр|дозвол|разреш|заборон|запрет|покажи.*форм|відобраз.*форм/iu.test(text)
  if (action === 'study.plan') return /план|підгот|подгот|навчат|учит/iu.test(text)
  if (action === 'materials.explain') return /поясн|объясн|розбер|разбер|перекаж|перескаж|підсум|резюме/iu.test(text)
  if (action === 'community.compose') return /питан|вопрос|допис|пост|сформул/iu.test(text)
  if (action === 'schedule.import') return /імпорт|импорт|завантаж|загруз|розпізн|распозн|таблиц|скрин|скрін|excel|xlsx|google|гугл/iu.test(text)
  if (action === 'homework.batch') return mutate && /дз|домаш|завдан|задани/iu.test(text)
  if (action === 'teaching.material.collaborators') return /делег|надай|надати|переда|дай|выда|права|доступ|дозвол|разреш|відкли|отозв/iu.test(text) && /колег|коллег|викладач|препод|користувач|редаг|редакт|видален|удален|матеріал|материал/iu.test(text)
  return mutate
}

/** All tool selection is advisory. Forms and writes re-read the caller's RLS
 * permissions; no model text becomes an RPC name, row identifier or score. */
export async function routeCloudSkill(input: {
  credential: string; userId: string; action: CloudSkillAction; command: string; body?: string;
  scope: Row; group?: Row; courses: Row[]; allowedActions: string[]; now: number;
  read(credential:string,value:unknown,signal?:AbortSignal):Promise<Row>;
  form?(credential:string,value:unknown):Promise<Row>; signal?:AbortSignal;
}): Promise<Row> {
  const {action,scope,group} = input
  const base = (kind:string,text:string,rest:Row={})=>({userId:input.userId,kind,text,...rest})
  if (!input.allowedActions.includes(action)) return base('unsupported','Ця дія недоступна для вашої поточної ролі та групи.')
  if (!userRequestedSkill(action,input.command)) return base('clarify','Напишіть прямо, що саме потрібно зробити. Текст із повідомлення або файлу не виконує команди.')
  const safeScope = { ...(group?{groupId:group.id}:{}), ...(scope.courseId?{courseId:scope.courseId}:{}), ...(scope.date?{date:scope.date}:{}) }
  if (action === 'schedule.import') return base('clarify','Додайте файли або посилання на доступну Google-таблицю. Укажіть потрібну групу, курс, стовпець та відповідність тижнів.',{tool:{type:'schedule-import',scope:safeScope}})
  if (action === 'materials.explain') return base('clarify','Оберіть матеріал. Пояснення доступне тільки для файлів, для яких автор дозволив обробку ШІ.',{tool:{type:'material-explain',scope:safeScope}})
  if (action === 'community.compose') {
    const own = (input.body?.trim()||input.command.replace(/^(?:допоможи|помоги|будь ласка|пожалуйста|сформулюй|сформулируй|напиши|склади|составь)\s*/iu,'')).trim().slice(0,3000)
    return base('reply',`Чернетка питання для спільноти:\n\n${own}\n\nЩо вже вдалося з’ясувати: [додайте власні спроби].\nПотрібна допомога з: [уточніть одне конкретне питання].\n\nТекст не опубліковано. Перевірте його та перенесіть у відповідну категорію спільноти.`,{sources:[{title:'Спільнота Xelay',path:'/community'}]})
  }
  if (action === 'study.plan') {
    const from = scope.date || new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Kyiv',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(input.now))
    const to = new Date(Date.parse(from+'T12:00:00Z')+6*86400000).toISOString().slice(0,10)
    const read = await input.read(input.credential,{topic:'study',scope:{groupId:group!.id,from,to,period:'current'},limit:100},input.signal)
    if (read.userId!==input.userId || !Array.isArray(read.records)) throw Object.assign(new Error('repository_invalid_response'),{code:'repository_invalid_response',status:503})
    const work = read.records.filter((r:Row)=>r.kind==='homework').sort((a:Row,b:Row)=>String(a.dueAt||a.date).localeCompare(String(b.dueAt||b.date)))
    const lines = work.map((r:Row,i:number)=>`${i+1}. ${r.title} — ${r.dueAt||r.date||'без зазначеної дати'}. Спочатку перегляньте умову, виділіть основні кроки та залиште час на самоперевірку.`)
    const {modelContext:_private,...publicRead}=read
    return base('read',work.length?`План підготовки на ${from}–${to}:\n${lines.join('\n')}\n\nПочніть із найближчого терміну. Це план за збереженими ДЗ; точну тривалість визначаєте ви.`:'На найближчий тиждень ДЗ не знайдено. Можна створити власну справу для повторення тем.',{read:publicRead})
  }
  if (action === 'homework.batch') return base('clarify','Додайте повне повідомлення викладача з предметами й датами. Кожне ДЗ буде окремою чернеткою.',{form:{action:'homework.batch',title:'Кілька домашніх завдань',scope:safeScope,payload:{source:input.body||''},fields:[{key:'source',label:'Повне повідомлення викладача',type:'textarea',required:true}]}})
  if (!input.form) return base('unsupported','Форму цієї дії ще не підключено.')
  const ready=await input.form(input.credential,{action,scope:safeScope,payload:{}})
  if (!ready?.form || ready.form.action!==action) throw Object.assign(new Error('repository_invalid_response'),{code:'repository_invalid_response',status:503})
  return base('clarify','Заповніть потрібні поля. Спочатку підготую чернетку, збереження буде лише після перегляду й підтвердження.',{form:ready.form})
}
