import { useEffect, useState } from 'react'
import { KeyRound, RefreshCw } from 'lucide-react'
import { teachingTestError, type TeachingTestAccessCode, type TeachingTestRepository } from '../../lib/teachingTests'
import { TeachingButton, TeachingModal } from './TeachingUI'

export function TeachingTestAccessCodeDialog({ repository, testId, userId, onClose }: {
  repository: TeachingTestRepository
  testId: string
  userId?: string
  onClose: () => void
}) {
  const [code, setCode] = useState<TeachingTestAccessCode>()
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const [confirmRotate, setConfirmRotate] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let active = true
    setBusy(true)
    setError('')
    void repository.mutate('read_access_code', { id: testId, expected_user_id: userId }).then(result => {
      if (active) setCode(result.access_code)
    }).catch(failure => {
      if (active) setError(teachingTestError(failure))
    }).finally(() => {
      if (active) setBusy(false)
    })
    return () => { active = false }
  }, [repository, testId, userId, revision])

  async function rotate() {
    setBusy(true)
    setError('')
    try {
      const result = await repository.mutate('rotate_access_code', { id: testId, expected_user_id: userId })
      setCode(result.access_code)
      setConfirmRotate(false)
    } catch (failure) {
      setCode(undefined)
      setError(teachingTestError(failure))
    } finally {
      setBusy(false)
    }
  }

  return <TeachingModal title="Код доступу" onClose={onClose} busy={busy}>
    <p className="text-sm text-muted-foreground">Повідомте чинний код студентам, які мають почати тест. Для спроб, що вже тривають, код повторно вводити не потрібно.</p>
    {error && <div role="alert" className="teaching-error mt-4">{error}</div>}
    {code && <div className="mt-4 grid gap-3">
      <div className="teaching-card"><p className="text-sm font-semibold">Чинний код</p>
        {code.current ? <code className="mt-2 block select-all text-3xl font-semibold tracking-widest">{code.current}</code> : <p className="text-sm text-muted-foreground">Код ще не створено.</p>}
      </div>
      {code.previous && <p className="text-sm text-muted-foreground">Попередній код <code className="select-all">{code.previous}</code> · більше не діє</p>}
    </div>}
    {busy && <p role="status" className="mt-3 text-sm text-muted-foreground">Оновлюємо дані…</p>}
    {confirmRotate && !busy && !error && <p role="status" className="mt-4 text-sm">Після оновлення попередній код одразу втратить чинність.</p>}
    <div className="teaching-test-actions">
      {error && <TeachingButton disabled={busy} onClick={() => { setConfirmRotate(false); setRevision(value => value + 1) }}><RefreshCw size={15} />Перевірити чинний код</TeachingButton>}
      {code && <TeachingButton primary disabled={busy} onClick={() => code.current && !confirmRotate ? setConfirmRotate(true) : void rotate()}><KeyRound size={15} />{!code.current ? 'Створити код' : confirmRotate ? 'Підтвердити оновлення' : 'Оновити код'}</TeachingButton>}
      {confirmRotate && code && <TeachingButton disabled={busy} onClick={() => setConfirmRotate(false)}>Скасувати</TeachingButton>}
    </div>
  </TeachingModal>
}
