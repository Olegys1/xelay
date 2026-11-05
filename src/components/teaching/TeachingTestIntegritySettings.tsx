import type { TeachingTest } from '../../lib/teachingTests'

export function TeachingTestIntegritySettings({ test, onChange, disabled }: {
  test: TeachingTest
  onChange: (patch: Partial<TeachingTest>) => void
  disabled?: boolean
}) {
  return <fieldset className="mt-4 grid gap-3" disabled={disabled}>
    <legend className="mb-2 text-sm font-semibold">Доступ і правила проходження</legend>
    <label className="flex items-start gap-2 text-sm">
      <input className="mt-1" type="checkbox" checked={Boolean(test.require_access_code)} onChange={event => onChange({ require_access_code: event.target.checked })} />
      <span><strong>Вхід за кодом викладача</strong><span className="block text-xs text-muted-foreground">Після збереження відкрийте «Код доступу» у списку тестів. Код потрібен для початку спроби.</span></span>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input className="mt-1" type="checkbox" checked={Boolean(test.restrict_tab_switch)} onChange={event => onChange({ restrict_tab_switch: event.target.checked })} />
      <span><strong>Контролювати вихід із вкладки</strong><span className="block text-xs text-muted-foreground">Після першого виходу студент отримає попередження. Другий вихід завершує спробу зі збереженими відповідями.</span></span>
    </label>
    <label className="flex items-start gap-2 text-sm">
      <input className="mt-1" type="checkbox" checked={Boolean(test.discourage_capture)} onChange={event => onChange({ discourage_capture: event.target.checked })} />
      <span><strong>Ускладнити знімки екрана</strong><span className="block text-xs text-muted-foreground">Показує позначку спроби поверх запитань і приховує їх під час друку. Системні знімки екрана браузер заблокувати не може.</span></span>
    </label>
  </fieldset>
}
