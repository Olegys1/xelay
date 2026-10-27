import { useEffect, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { teachingError, type TeachingPublication, type TeachingRepository } from '../../lib/teaching'
import { TeachingButton, TeachingModal } from './TeachingUI'

export function TeachingMaterialWithdrawal({ material, repository, onWithdrawn, onOpenChange }: { material: TeachingPublication; repository: TeachingRepository; onWithdrawn: () => Promise<void> | void; onOpenChange?: (open: boolean) => void }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [withdrawn, setWithdrawn] = useState(false)
  const lock = useRef(false)
  useEffect(() => { if (!confirm) return; onOpenChange?.(true); return () => onOpenChange?.(false) }, [confirm, onOpenChange])
  async function withdraw() {
    if (lock.current || withdrawn) return
    lock.current = true; setBusy(true); setError('')
    try {
      await repository.withdrawMaterial(material.id, material.version)
      setWithdrawn(true)
      try { await onWithdrawn() } catch { setError('Матеріал відкликано. Оновіть список, щоб побачити зміни.') }
    } catch (failure) { setError(teachingError(failure)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <>
    <TeachingButton disabled={withdrawn} onClick={() => { setConfirm(true); setError('') }}><Trash2 size={15} />{withdrawn ? 'Відкликано' : 'Відкликати матеріал'}</TeachingButton>
    {confirm && <TeachingModal title={withdrawn ? 'Матеріал відкликано' : 'Відкликати матеріал?'} description={material.title} busy={busy} onClose={() => setConfirm(false)}>
      <p className="text-sm leading-relaxed">{withdrawn ? 'Матеріал більше не відображається у групах. Нові посилання для завантаження недоступні.' : 'Матеріал зникне з усіх груп, до яких ви його опублікували. Доступні раніше завантажені копії залишаться у тих, хто їх зберіг.'}</p>
      {error && <p role="alert" className="teaching-error mt-4">{error}</p>}
      <div className="teaching-form-actions"><TeachingButton disabled={busy} onClick={() => setConfirm(false)}>{withdrawn ? 'Закрити' : 'Залишити матеріал'}</TeachingButton>{!withdrawn && <TeachingButton primary busy={busy} onClick={() => void withdraw()}><Trash2 size={15} />Відкликати з усіх груп</TeachingButton>}</div>
    </TeachingModal>}
  </>
}
