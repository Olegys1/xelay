// All content comes from the same local preview server. No production endpoints.
const byId = id => document.getElementById(id)
const coverage = {
  healthy: { text: 'Дані отримано', note: 'Нуль сигналів не є гарантією безпеки', tone: 'calm' },
  partial: { text: 'Неповне покриття', note: 'Частину статусів неможливо оцінити', tone: 'warning' },
  not_configured: { text: 'Не налаштовано', note: 'Відсутність даних не є успішною перевіркою', tone: 'warning' },
}
let selected = null
let repeats = 0
function selectScenario(scenario) {
  selected = scenario
  repeats = 0
  for (const button of document.querySelectorAll('[data-scenario]')) {
    const active = button.dataset.scenario === scenario.id
    button.classList.toggle('selected', active)
    button.setAttribute('aria-pressed', String(active))
  }
  const status = coverage[scenario.coverage]
  byId('coverage-value').textContent = status.text
  byId('coverage-value').className = `coverage-${status.tone}`
  byId('coverage-note').textContent = status.note
  byId('situation').dataset.tone = scenario.tone
  byId('situation-label').textContent = scenario.tone === 'critical' ? 'Потребує пріоритетної уваги · приклад' : scenario.tone === 'warning' ? 'Потребує перевірки · приклад' : 'Звичайна ситуація · приклад'
  byId('scenario-title').textContent = scenario.title
  byId('scenario-explanation').textContent = scenario.explanation
  byId('scenario-count').textContent = scenario.count
  byId('scenario-count-label').textContent = scenario.countLabel
  byId('scenario-threshold').textContent = scenario.threshold
  byId('message-text').textContent = scenario.message || ''
  byId('telegram-message').hidden = !scenario.message
  byId('empty-message').hidden = Boolean(scenario.message)
  byId('empty-explanation').textContent = scenario.id === 'not-configured' ? 'Перша перевірка ще не створює попередження. Покриття залишається непідтвердженим.' : 'За заданими порогами сигналів немає. Це не гарантія відсутності загроз.'
  byId('message-count').textContent = scenario.message ? '1 повідомлення' : '0 повідомлень'
  byId('repeat-example').disabled = false
  byId('dedup-result').textContent = 'Демонстрація повторів діє лише на цій сторінці; реальна база не використовується.'
}
byId('repeat-example').addEventListener('click', () => {
  if (!selected) return
  repeats += 1
  byId('dedup-result').textContent = `Демонстрація: повторів — ${repeats}. Нових повідомлень — 0. ${selected.message ? 'Залишається один приклад повідомлення.' : 'Повідомлень як і раніше немає.'} Реальна база не викликалася.`
})
async function load() {
  try {
    const response = await fetch('/demo.json', { cache: 'no-store', credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw Error('PREVIEW_UNAVAILABLE')
    const data = await response.json()
    if (data.demonstration !== true || data.monitoring_enabled !== false || !Array.isArray(data.scenarios)) throw Error('PREVIEW_INVALID')
    for (const scenario of data.scenarios) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.scenario = scenario.id
      button.textContent = scenario.label
      button.setAttribute('aria-pressed', 'false')
      button.addEventListener('click', () => selectScenario(scenario))
      byId(scenario.primary ? 'primary-scenarios' : 'other-scenarios').append(button)
    }
    selectScenario(data.scenarios[0])
  } catch { byId('load-error').hidden = false }
}
void load()
