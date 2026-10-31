// Content contract for an optional feature. No account, model, network or DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ASSISTANT_MODEL_NOTICE_VERSION, PRIVACY_POLICY_VERSION, PERSONAL_DATA_CONSENT_VERSION, getLegalPage } from '../../src/lib/legal.ts'
import { renderLegalHtml } from '../legalHtml.ts'

const page = kind => getLegalPage(kind)
const section = kind => {
  const matches = page(kind).sections.filter(item => item.id === 'assistant-model')
  assert.equal(matches.length, 1, `${kind} has one usable public anchor`)
  return matches[0]
}
const text = kind => section(kind).paragraphs.join('\n')
const policy = () => text('privacy-policy')
const consent = () => text('personal-data-consent')

test('assistant notice is a separate dated addendum without changing signup document editions', () => {
  assert.equal(ASSISTANT_MODEL_NOTICE_VERSION, '2026-11-01.1')
  assert.equal(PRIVACY_POLICY_VERSION, '2026-10-25.1')
  assert.equal(PERSONAL_DATA_CONSENT_VERSION, '2026-10-25.1')
  for (const kind of ['privacy-policy', 'personal-data-consent']) {
    assert.equal(page(kind).updatedAt, '25 жовтня 2026 року')
    assert.ok(text(kind).includes('1 листопада 2026 року'))
    assert.ok(text(kind).includes(ASSISTANT_MODEL_NOTICE_VERSION))
  }
  assert.ok(policy().includes('не змінює раніше наданих згод'))
  assert.ok(consent().includes('Раніше записані згоди на роботу акаунта зберігаються без змін'))
  assert.ok(consent().includes('не створює нової згоди заднім числом'))
})

test('both addenda disclose user text, limited user history and contextual fields before Send', () => {
  for (const value of [policy(), consent()]) {
    assert.ok(value.includes('«Надіслати»'))
    assert.ok(value.includes('OpenAI'))
    assert.ok(value.includes('поточного запиту') || value.includes('поточний запит'))
    assert.ok(value.includes('текст повідомлення викладача') || value.includes('тексту викладача'))
    assert.ok(value.includes('до 6 попередніх'))
    assert.ok(value.includes('із цього чату'))
    assert.ok(value.includes('предметів і викладацьких курсів'))
    assert.ok(value.includes('за Києвом'))
    assert.ok(value.includes('дата або період') || value.includes('дати або періоду'))
    assert.ok(value.includes('перелік доступних дій') || value.includes('переліку доступних дій'))
  }
  assert.ok(policy().includes('до надсилання'))
  assert.ok(consent().includes('До натискання «Надіслати» бачу повідомлення'))
})

test('notice distinguishes protected records from private information a user may type', () => {
  const value = policy()
  const protectedFields = section('privacy-policy').paragraphs.find(item => item.startsWith('Xelay автоматично не передає'))
  assert.ok(protectedFields)
  for (const field of ['вміст записів навчальної бази', 'списки студентів', 'оцінки', 'файли', 'тексти закритих матеріалів', 'приватні переписки', 'попередні відповіді помічника']) assert.ok(protectedFields.includes(field))
  assert.ok(protectedFields.includes('реальні внутрішні ідентифікатори користувачів і груп'))
  assert.ok(protectedFields.includes('облікові дані або ключі доступу'))
  assert.ok(value.includes('Якщо ви самі введете приватні дані'))
  assert.ok(value.includes('можуть потрапити до OpenAI разом із повідомленням'))
  assert.ok(consent().includes('відомості, які самостійно введу в повідомлення, можуть бути передані'))
})

test('server reads and confirmed writes remain separate from model planning', () => {
  const value = policy()
  assert.ok(value.includes('Модель визначає намір'))
  assert.ok(value.includes('читає сервер Xelay після перевірки поточних прав користувача'))
  assert.ok(value.includes('їхній вміст не додається до запиту моделі'))
  assert.ok(value.includes('Чат не підтверджує зміни замість вас'))
  assert.ok(value.includes('Збереження чернетки потребує окремого підтвердження'))
  assert.ok(value.includes('сервер повторно перевіряє ваші права'))
  assert.ok(consent().includes('Підготовлену зміну перевіряю та підтверджую окремо'))
})

test('store false and budget audit descriptions do not promise zero provider retention', () => {
  const value = policy()
  assert.ok(value.includes('store: false'))
  assert.ok(value.includes('не є обіцянкою відсутності або негайного видалення всіх технічних записів постачальника'))
  assert.ok(value.includes('не є режимом нульового зберігання даних'))
  const audit = section('privacy-policy').paragraphs.find(item => item.startsWith('Окремий службовий журнал бюджету'))
  assert.ok(audit.includes('стан резервування й числові дані про використання та витрати'))
  assert.ok(audit.includes('У цьому журналі не зберігаються сирі тексти запитів, вставлених повідомлень, відповідей моделі або ключі доступу'))
  assert.ok(audit.includes('чернетки зберігаються окремо'))
  assert.ok(consent().includes('store: false не означає відсутності всіх технічних записів OpenAI'))
})

test('file explanations require current access, separate author permission and the reader explicit action',()=>{
  const material=section('privacy-policy').paragraphs.find(p=>p.startsWith('Пояснення матеріалу потребує'))
  assert.ok(material.includes('одночасно вашого доступу'))
  assert.ok(material.includes('окремого чинного дозволу автора на ШІ'))
  assert.ok(material.includes('натискання вами відповідної кнопки'))
  assert.ok(material.includes('обмежений за обсягом текст вибраного матеріалу'))
  assert.ok(material.includes('Автор може відкликати дозвіл'))
  assert.ok(material.includes('зміна матеріалу скидає попередній дозвіл'))
  assert.ok(material.includes('не відкриває файл іншим користувачам'))
  assert.ok(consent().includes('Авторський дозвіл сам по собі не запускає обробку'))
})

test('optional processing discloses free OpenAI moderation before and after generation and its limits',()=>{
  const moderation=section('privacy-policy').paragraphs.find(p=>p.startsWith('Перед і після генерації'))
  assert.ok(moderation.includes('запит і результат'))
  assert.ok(moderation.includes('безплатним сервісом модерації OpenAI'))
  assert.ok(moderation.includes('Якщо перевірка недоступна'))
  assert.ok(moderation.includes('цей результат не показується'))
  assert.ok(moderation.includes('не є гарантією від усіх помилок чи обходів'))
  assert.ok(consent().includes('OpenAI Moderation'))
})

test('offline notice identifies account-bound timetable/homework copies, age and logout cleanup',()=>{
  const offline=section('privacy-policy').paragraphs.find(p=>p.includes('Збережений для офлайн-перегляду'))
  assert.ok(offline.includes('розклад і ДЗ прив’язуються до акаунта на цьому пристрої'))
  assert.ok(offline.includes('дату оновлення й строк до 14 днів'))
  assert.ok(offline.includes('вихід з акаунта очищає ці копії'))
  assert.ok(offline.includes('Без інтернету нові відповіді й зміни недоступні'))
})

test('ordinary forms remain available and linked addenda render without login or JavaScript', async () => {
  assert.ok(policy().includes('Можна не користуватися ШІ-чатом і працювати зі звичайними формами'))
  assert.ok(policy().includes('не закриває доступ до розкладу, ДЗ'))
  assert.ok(consent().includes('Можу користуватися звичайними формами без ШІ-чату'))
  assert.ok(section('personal-data-consent').links.some(link => link.href === '/privacy-policy#assistant-model'))
  assert.ok(section('privacy-policy').links.some(link => link.href === '/personal-data-consent#assistant-model'))

  for (const kind of ['privacy-policy', 'personal-data-consent']) {
    const html = renderLegalHtml(kind)
    assert.ok(html.includes('<section id="assistant-model">'))
    assert.ok(html.includes(`<h2>${section(kind).title}</h2>`))
    assert.ok(html.includes(ASSISTANT_MODEL_NOTICE_VERSION))
    assert.equal(html.includes('<script'), false)
  }
})
