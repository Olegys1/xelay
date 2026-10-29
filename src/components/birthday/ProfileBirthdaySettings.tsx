import { useEffect, useRef, useState } from 'react'
import { BIRTHDAY_PROFILE_CHANGED, loadBirthdayProfile, saveBirthdayProfile, type BirthdayProfile } from '../../lib/birthdayProfile'
import { BirthdayProfileSettings } from './BirthdayProfileSettings'

const empty: BirthdayProfile = { day: null, month: null, showToGroup: false }
export function ProfileBirthdaySettings({ userId, onSaved, onBusyChange }: { userId: string; onSaved?: () => void; onBusyChange?: (busy: boolean) => void }) {
  const [state, setState] = useState({ owner: userId, value: empty, hasDate: false, loading: true, saving: false, saved: false, error: '' })
  const [reload, setReload] = useState(0)
  const owner = useRef(userId); owner.current = userId
  const alive = useRef(false), locked = useRef(false)
  const saveRequest = useRef<AbortController | null>(null)
  const savedCallback = useRef(onSaved); savedCallback.current = onSaved
  const busyCallback = useRef(onBusyChange); busyCallback.current = onBusyChange
  useEffect(() => { busyCallback.current?.(state.saving); return () => busyCallback.current?.(false) }, [state.saving])
  useEffect(() => {
    alive.current = true
    const actor = userId, request = new AbortController()
    locked.current = false
    setState({ owner: actor, value: empty, hasDate: false, loading: true, saving: false, saved: false, error: '' })
    void loadBirthdayProfile(actor, request.signal).then(value => {
      if (!request.signal.aborted && alive.current && owner.current === actor) setState({ owner: actor, value, hasDate: value.day !== null, loading: false, saving: false, saved: false, error: '' })
    }, () => {
      if (!request.signal.aborted && alive.current && owner.current === actor) setState({ owner: actor, value: empty, hasDate: false, loading: false, saving: false, saved: false, error: 'Не вдалося завантажити дату. Спробуйте ще раз перед зміною налаштувань.' })
    })
    return () => { alive.current = false; request.abort(); saveRequest.current?.abort() }
  }, [userId, reload])
  async function save(value: BirthdayProfile) {
    if (locked.current || state.owner !== userId || state.loading) return
    const actor = userId, controller = new AbortController()
    locked.current = true; saveRequest.current = controller
    setState(current => ({ ...current, saving: true, saved: false, error: '' }))
    try {
      const result = await saveBirthdayProfile(actor, value, controller.signal)
      if (!controller.signal.aborted && alive.current && owner.current === actor) {
        setState({ owner: actor, value: result, hasDate: result.day !== null, loading: false, saving: false, saved: true, error: '' })
        savedCallback.current?.()
        window.dispatchEvent(new CustomEvent(BIRTHDAY_PROFILE_CHANGED, { detail: { userId: actor } }))
      }
    } catch (error) {
      if (!controller.signal.aborted && alive.current && owner.current === actor) setState(current => ({ ...current, saving: false, error: error instanceof Error ? error.message : 'Не вдалося зберегти дату.' }))
    } finally { if (saveRequest.current === controller) { saveRequest.current = null; locked.current = false } }
  }
  const current = state.owner === userId ? state : { ...state, value: empty, hasDate: false, loading: true, saved: false, error: '' }
  return <div className="mb-5"><BirthdayProfileSettings value={current.value} loading={current.loading} saving={current.saving} saved={current.saved} error={current.error}
    onChange={value => setState(previous => ({ ...previous, value, saved: false, error: '' }))}
    onSave={() => save(current.value)} onRemove={current.hasDate ? () => save(empty) : undefined} />
    {current.error && <button type="button" className="mt-2 text-xs font-medium text-primary underline" disabled={current.saving} onClick={() => setReload(value => value + 1)}>Оновити налаштування дня народження</button>}
  </div>
}
