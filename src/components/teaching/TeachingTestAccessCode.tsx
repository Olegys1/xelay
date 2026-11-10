import { useEffect, useRef, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { teachingTestError, type TeachingTest, type TeachingTestAccessCode, type TeachingTestDetail, type TeachingTestRepository } from '../../lib/teachingTests'
import { TeachingButton, TeachingModal } from './TeachingUI'

type AccessCodeView = {
  code?: TeachingTestAccessCode
  status: TeachingTest['status']
  required: boolean
}

function codeView(result: TeachingTestDetail): AccessCodeView {
  return { code: result.access_code, status: result.test.status, required: result.test.require_access_code === true }
}

export function TeachingTestAccessCodeDialog({ repository, testId, userId, onClose }: {
  repository: TeachingTestRepository
  testId: string
  userId: string
  onClose: () => void
}) {
  const [view, setView] = useState<AccessCodeView>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [revision, setRevision] = useState(0)
  const rotating = useRef(false)
  const code = view?.code
  const canRotate = Boolean(view?.required && view.status !== 'closed')

  useEffect(() => {
    let active = true
    setBusy(true)
    setError('')
    setView(undefined)
    void repository.mutate('read_access_code', { id: testId, expected_user_id: userId }).then(result => {
      if (active) setView(codeView(result))
    }).catch(failure => {
      if (active) setError(teachingTestError(failure))
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [repository, testId, userId, revision])

  async function rotate() {
    if (!canRotate || busy || rotating.current || code?.current && !confirmRotate) return
    rotating.current = true
    setBusy(true)
    setError('')
    setConfirmRotate(false)
    try {
      const result = await repository.mutate('rotate_access_code', { id: testId, expected_user_id: userId })
      setView(codeView(result))
    } catch (failure) {
      setView(undefined)
      const message = failure instanceof Error ? failure.message : String((failure as { message?: unknown })?.message || '')
      if (message.includes('TEST_IMMUTABLE')) {
        // The status can change between displaying and confirming the code.
        setRevision(value => value + 1)
      } else {
        setError(teachingTestError(failure))
      }
    } finally {
      rotating.current = false
      setBusy(false)
    }
  }

  return <TeachingModal guide={{ topic: 'test-admission', step: 'code', label: 'Код доступу' }} title="Код доступу" onClose={onClose} busy={busy}>
    <p className="text-sm text-muted-foreground" data-teaching-guide="test-access-code">{view?.status === 'closed'
      ? 'Тест закрито. Для нової спроби підготуйте перездачу.'
      : 'Повідомте чинний код студентам, які мають почати тест. Для спроб, що вже тривають, код повторно вводити не потрібно.'}</p>
    {error && <div role="alert" className="teaching-error mt-4">{error}</div>}
    {view && !view.required && <p className="teaching-note mt-4">Для цього тесту вхід за кодом вимкнено.</p>}
    {view?.required && <div className="mt-4 grid gap-3">
      <div className="teaching-card"><p className="text-sm font-semibold">{view.status === 'closed' ? 'Останній код' : 'Чинний код'}</p>
        {code?.current ? <code className="mt-2 block select-all text-3xl font-semibold tracking-widest">{code.current}</code> : <p className="text-sm text-muted-foreground">Код ще не створено.</p>}
      </div>
      {code?.previous && <p className="text-sm text-muted-foreground">Попередній код <code className="select-all">{code.previous}</code> · більше не діє</p>}
    </div>}
    {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">Оновлюємо дані…</p>}
    {confirmRotate && !busy && !error && <p role="status" className="mt-4 text-sm">Після оновлення попередній код одразу втратить чинність.</p>}
    <div className="teaching-test-actions">
      {error && <TeachingButton disabled={busy} onClick={() => { setConfirmRotate(false); setRevision(value => value + 1) }}><RefreshCw size={15} />Перевірити чинний код</TeachingButton>}
      {canRotate && <TeachingButton primary disabled={busy} onClick={() => code?.current && !confirmRotate ? setConfirmRotate(true) : void rotate()}><KeyRound size={15} />{!code?.current ? 'Створити код' : confirmRotate ? 'Підтвердити оновлення' : 'Оновити код'}</TeachingButton>}
      {confirmRotate && canRotate && <TeachingButton disabled={busy} onClick={() => setConfirmRotate(false)}>Скасувати</TeachingButton>}
    </div>
  </TeachingModal>
}
