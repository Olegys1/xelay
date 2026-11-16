import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/studentGuides.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,{module,exports:module.exports,JSON,Math,Number,Set,Map})
const g=module.exports,plain=v=>JSON.parse(JSON.stringify(v))
test('every current study workflow has explicit instructions, safe selectors and independently meaningful actions',()=>{
 assert.equal(g.STUDENT_GUIDE_IDS.length,11)
 assert.equal(g.getStudentGuide('__proto__'),null);assert.equal(g.getStudentGuide('constructor'),null)
 for(const id of g.STUDENT_GUIDE_IDS){const guide=g.getStudentGuide(id);assert.equal(guide.id,id);assert.ok(guide.root.startsWith('.'));assert.ok(guide.steps.length>=4);assert.ok(guide.actions.length>=5);assert.equal(new Set(guide.actions.map(a=>a.id)).size,guide.actions.length)
  for(const step of guide.steps){assert.ok(step.target.length>0);assert.ok(step.body.trim());assert.ok(step.tip.trim());if(step.reveal)assert.ok(g.isSafeStudentGuideReveal(step.reveal),step.reveal)}
  for(const a of guide.actions){assert.doesNotThrow(()=>new RegExp(a.pattern,'iu'));assert.equal(a.body.length,3);assert.ok(a.body.every(p=>p.length>25));assert.ok(a.tip.length>25)}
 }
})
test('indexed controls and actual static labels resolve to specific explanations rather than pretending generic coverage',()=>{
 const fixtures={
  plans:['Випробувати Макс','Переглянути анімацію Старт','Переглянути анімацію Плюс','Повний склад і пояснення 35','Порівняти всі можливості'],
  tools:['Мій день','Збережене','Що потрібно зробити?','Предмет','Дата','Виділити 25 хвилин','Відкрити шаблон','Моя підготовка','До п’ятихвилинної перерви','Шукати в особистій добірці','Текстова нотатка','Назва','Почати','Пауза','Скинути','Конспект лекції'],
  research:['Свій PDF','Економічний вибір Навчальний приклад · 2 стор.','max-research-study.pdf 2 стор. · читали до 2','Попередня сторінка джерела','Наступна сторінка джерела','Сторінка 2','с. 2 Demand changes','Прибрати закладку сторінки','Зберегти думку','До роботи','Завантажити всі власні виписки'],
  coursework:['Формат','Предмет','Завершити до','Відкрити джерело','Зберегти версію','Відновити','Додати до цієї роботи','Підняти розділ Вступ','Опустити розділ Вступ','01 Вступ 30 слів'],
  practice:['Додати питання','Предмет','Тема','Текст питання','Пояснення після відповіді','Питання 2, відповідь обрана','Перевірити імпорт','Завершити тренування','Повторити лише помилки · 2','Далі'],
  academic:['Робота 1','Сценарій 3','Припущення: Проєкт','Правила й відомі бали','Додати складову','Мої дані'],
  assistant:['Мої джерела /3','Зупинити','Власний текст для агента','Відкрити навчальний приклад','Перевірити відповідь','Далі','Повторити помилки (2)','Ще повторити','Пам’ятаю','Показати координати графіка','Завантажити навчальну сесію'],
 }
 for(const [id,labels] of Object.entries(fixtures)){const coverage=g.studentGuideActionCoverage(id,labels.map(label=>({label})));assert.deepEqual(plain(coverage.unmatched),[],id)}
 assert.equal(g.describeStudentGuideAction('practice','Далі').id,'answer');assert.equal(g.describeStudentGuideAction('practice','Завершити тренування').tone,'finish')
 assert.match(g.describeStudentGuideAction('coursework','Відновити').body.join(' '),/резервна копія/)
 assert.match(g.describeStudentGuideAction('assistant','Відкрити навчальний приклад').body.join(' '),/не надсилається моделі/)
})
test('dynamic source, history, answer and scenario rows use owned UI context without consuming their private values',()=>{
 for(const [id,rules] of Object.entries(g.STUDENT_GUIDE_CONTROL_CONTEXTS))for(const rule of rules){assert.ok(g.getStudentGuide(id).actions.some(a=>a.id===rule.actionId),id+':'+rule.actionId);assert.notEqual(g.describeStudentGuideAction(id,'Динамічний власний текст','button',false,rule.actionId).id,'visible-control')}
 const unknown=g.describeStudentGuideAction('assistant','Невідома майбутня кнопка');assert.equal(unknown.id,'visible-control');assert.match(unknown.title,/немає окремої інструкції/)
 const disabled=g.describeStudentGuideAction('practice','Додати питання','button',true);assert.match(disabled.tip,/Зараз дія недоступна/)
})
test('manual search is literal, case-insensitive, scoped and bounded',()=>{
 assert.ok(g.searchStudentGuideActions('coursework','ВЕРСІЮ').length>0)
 assert.equal(g.searchStudentGuideActions('coursework','.*').length,0)
 assert.equal(g.searchStudentGuideActions('foreign','зберегти').length,0)
 assert.ok(g.searchStudentGuideActions('research','сторін').every(a=>g.getStudentGuide('research').actions.some(original=>original.id===a.id)))
})
test('completion preferences persist only known guide IDs and cannot contain application content or forged properties',()=>{
 const prefs=g.parseStudentGuidePreferences(JSON.stringify({version:1,completed:['research','research','constructor','__proto__','foreign'],answers:{secret:'not retained'}}));assert.deepEqual(plain(prefs),{version:1,completed:['research']})
 const next=g.completeStudentGuide(prefs,'coursework');assert.deepEqual(plain(prefs.completed),['research']);assert.ok(next.completed.includes('coursework'));assert.equal(g.completeStudentGuide(next,'foreign').completed.length,2)
 for(const raw of ['{broken','x'.repeat(3001),JSON.stringify({version:2,completed:['max']})])assert.equal(g.parseStudentGuidePreferences(raw).completed.length,0)
})
test('coach card stays in the viewport and chooses a non-overlapping position when one exists',()=>{
 const overlap=(a,b)=>Math.max(0,Math.min(a.left+a.width,b.left+b.width)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.top+a.height,b.top+b.height)-Math.max(a.top,b.top))
 for(const viewport of [{width:1365,height:900},{width:390,height:844},{width:320,height:640},{width:180,height:300}])for(const point of [{left:20,top:30,width:110,height:44},{left:viewport.width-140,top:viewport.height-100,width:120,height:44}]){const p=g.placeStudentGuidePanel(point,viewport,{width:430,height:240});assert.ok(p.left>=0&&p.top>=0);assert.ok(p.left+p.width<=viewport.width+.01);assert.ok(p.top+p.height<=viewport.height+.01);if(viewport.width>=320)assert.equal(overlap(p,point),0)}
 const centered=g.placeStudentGuidePanel(null,{width:390,height:844},{width:430,height:300});assert.equal(centered.side,'center');assert.ok(centered.left+centered.width<390)
})
test('tour activation is restricted to known harmless view tabs and never payments or destructive controls',()=>{
 for(const s of ['.mcs-tabs button:nth-child(2)','.spl-tabs button:nth-child(3)','.sdt-tabs button:nth-child(1)','.swb-tabs button:nth-child(5)'])assert.equal(g.isSafeStudentGuideReveal(s),true)
 for(const s of ['button','.mcs-primary','.mta-send','.swp-plan-choose','a[href]','.mcs-tabs button:nth-child(99)','body form button'])assert.equal(g.isSafeStudentGuideReveal(s),false)
 const ui=readFileSync(new URL('../src/components/student/StudentLearningGuide.tsx',import.meta.url),'utf8')
 assert.match(ui,/isSafeStudentGuideReveal\(current.reveal\)/);assert.doesNotMatch(ui,/dangerouslySetInnerHTML|fetch\(|supabase\.|eval\(/)
 assert.match(ui,/const mutations=\['beforeinput','paste','cut','drop','dragover','input','change','submit'\]/)
 assert.match(ui,/field.readOnly=true/);assert.match(ui,/field.readOnly=value/);assert.match(ui,/event.stopImmediatePropagation\(\)/)
 assert.match(ui,/node.inert=true/);assert.match(ui,/node.inert=value/);assert.match(ui,/previousFocus.focus\(\{preventScroll:true\}\)/)
})


test('local model configuration, source consent, feedback and side coach controls all have specific accurate guidance',()=>{
 const local=['Підключити','Налаштування','Згорнути','API-ключ OpenAI','Модель','Локальний ліміт, $','Дозволяю справжні запити за моїм API-ключем у межах зазначеного локального ліміту.','Підключити модель','Від’єднати й забути ключ','Повторити підключення','Дозволяю надіслати до OpenAI мій запит і лише обраний вище навчальний текст.','Обрати інші','Завершити й отримати фідбек','Картки за матеріалом','Розібрати складне','Новий тест','Окремий навчальний приклад · без моделі','Почати розбір']
 assert.deepEqual(plain(g.studentGuideActionCoverage('assistant',local.map(label=>({label}))).unmatched),[])
 const coach=['Налаштувати помічника поруч','Підказки за моїми діями','Увімкнути підказки','Пауза на годину','Відновити підказки','Нагадати про цю підказку через десять хвилин','Згорнути підказки','Розгорнути підказки','Закрити цю підказку','Закрити налаштування помічника','Відкрити план','Розібрати помилки','До роботи']
 for(const id of ['max','assistant'])assert.deepEqual(plain(g.studentGuideActionCoverage(id,coach.map(label=>({label}))).unmatched),[])
 assert.equal(g.getStudentGuide('assistant').root,'.mta-local-runtime, .mta-production, .mta')
 assert.equal(g.describeStudentGuideAction('assistant','API-ключ OpenAI','input').id,'local-api-key')
 assert.match(g.describeStudentGuideAction('assistant','Локальний ліміт, $').tip,/не рахунок OpenAI/)
 assert.match(g.describeStudentGuideAction('assistant','Картки за матеріалом').body.join(' '),/не починається автоматично/)
 assert.match(g.describeStudentGuideAction('assistant','Завершити й отримати фідбек').body.join(' '),/без нового платного запиту/)
 assert.match(g.describeStudentGuideAction('max','Нагадати про цю підказку через десять хвилин').body.join(' '),/простір відкритий/)
 for(const selector of ['.mta-local-config button[type="submit"]','.mta-send','.mta-source-consent input','.mta-local-approval input','.mtc-enable'])assert.equal(g.isSafeStudentGuideReveal(selector),false)
})

test('password inspection reads only its label and never accesses or exposes the entered API key',()=>{
 const ui=readFileSync(new URL('../src/components/student/StudentLearningGuide.tsx',import.meta.url),'utf8'),start=ui.indexOf('function describeControl('),end=ui.indexOf('function readPrefs()',start);assert.ok(start>=0&&end>start)
 const code=ts.transpileModule(ui.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,extracted={exports:{}}
 vm.runInNewContext(code+';module.exports=describeControl;',{module:extracted,exports:extracted.exports,STUDENT_GUIDE_CONTROL_CONTEXTS:g.STUDENT_GUIDE_CONTROL_CONTEXTS,describeStudentGuideAction:g.describeStudentGuideAction})
 const field={tagName:'INPUT',type:'password',labels:[{textContent:'API-ключ OpenAI'}],disabled:false,textContent:'',getAttribute:()=>null,closest:()=>null}
 Object.defineProperty(field,'value',{get(){throw Error('Password value must never be read')}})
 const described=extracted.exports('assistant',field);assert.equal(described.label,'API-ключ OpenAI');assert.equal(described.detail.id,'local-api-key');assert.match(described.detail.tip,/ніколи не читають/)
 assert.doesNotMatch(ui.slice(start,end),/field[.]value|node[.]value|getAttribute\(['"]value/)
})

test('automatic ordinary work mode has a dedicated explanation without enabling model actions',()=>{assert.equal(g.describeStudentGuideAction('assistant','Авто').id,'assistant-auto');assert.equal(g.isSafeStudentGuideReveal('.mta-auto'),false)})

test('server progress recovery controls explain local copy and conflict consequences',()=>{for(const label of ['Копія відповідей','Повторити збереження','Оновити стан'])assert.notEqual(g.describeStudentGuideAction('assistant',label).id,'visible-control');assert.match(g.describeStudentGuideAction('assistant','Оновити стан').tip,/скопійовані/)})

test('current chat menus, all six study formats and real browser voice controls have accurate dedicated guidance',()=>{
 const guide=g.getStudentGuide('assistant'),text=guide.steps.map(step=>step.body+' '+step.tip).join(' ')
 for(const selector of ['.mta-chat-history-trigger','.mta-attach','.mta-format-options','.mta-format-chip','.mta-lesson-dialog'])assert.ok(guide.steps.some(step=>step.target===selector),selector)
 const labels=['Правда чи неправда','Пропуски','Інтерактивний урок','Письмове тренування','Практична вправа','Навчальний діалог','Відповідь у пропуск','Зберегти й порівняти','Переглянути приклад відповіді','Я прослухав або прочитав','Текст розмови','Прибрати формат Пропуски','Надиктувати повідомлення','Почати диктування','Завершити й додати текст','Дозволяю браузеру розпізнати моє мовлення.','Прослухати діалог голосом браузера','Голос браузера для озвучення']
 assert.deepEqual(plain(g.studentGuideActionCoverage('assistant',labels.map(label=>({label}))).unmatched),[])
 assert.match(g.describeStudentGuideAction('assistant','Письмове тренування').body.join(' '),/Автоматичного бала ШІ.*немає/)
 assert.match(g.describeStudentGuideAction('assistant','Практична вправа').tip,/самооцінкою/)
 assert.match(g.describeStudentGuideAction('assistant','Надиктувати повідомлення').body.join(' '),/саме не надсилає/)
 assert.match(g.describeStudentGuideAction('assistant','Прослухати діалог голосом браузера').tip,/Завантаження MP3.*немає/)
 assert.match(text,/Фото та скан.*не розпізнаються/);assert.match(text,/трьох джерел і 24 КБ/)
 for(const selector of ['.mta-format-options button','.mta-attach','.mta-format-chip','.mta-lesson-dialog button','.mtv-icon'])assert.equal(g.isSafeStudentGuideReveal(selector),false)
})

test('new exam preparation guide describes four-step local drafts, explicit consent handoff and actual private progress without replacing the legacy calendar guide',()=>{
 const guide=g.getStudentGuide('exams');assert.equal(guide.root,'.mep');assert.equal(g.getStudentGuide('session').root,'.ssp')
 assert.match(guide.steps.map(step=>step.body+' '+step.tip).join(' '),/Чотири|чотири/)
 assert.match(g.describeStudentGuideAction('exams','Продовжити чернетку').body.join(' '),/лише на цьому пристрої/)
 assert.match(g.describeStudentGuideAction('exams','До помічника').body.join(' '),/підтвердь передачу матеріалу/)
 assert.match(g.describeStudentGuideAction('exams','До помічника').tip,/не генерує.*автоматично/)
 assert.match(g.describeStudentGuideAction('exams','Мій прогрес').body.join(' '),/без автоматичного бала ШІ/)
 assert.match(g.describeStudentGuideAction('exams','Завантажити мій конспект і налаштування').body.join(' '),/JSON/)
 const labels=['Новий іспит','Продовжити чернетку','Почати підготовку','Предмет','Дата іспиту','Хвилин на день','Моя ціль','Власний конспект','Далі','Назад','До помічника','Завантажити мій конспект і налаштування','Продовжити у чаті','Відкрити крок','Збережений план','Мій прогрес','План навчання','Закрити підготовку']
 assert.deepEqual(plain(g.studentGuideActionCoverage('exams',labels.map(label=>({label}))).unmatched),[])
 for(const selector of ['.mep-header button','.mep-dialog footer button','.mep-step input','.mep-timeline button'])assert.equal(g.isSafeStudentGuideReveal(selector),false)
 const prefs=g.completeStudentGuide(g.parseStudentGuidePreferences(null),'exams');assert.ok(prefs.completed.includes('exams'))
})
