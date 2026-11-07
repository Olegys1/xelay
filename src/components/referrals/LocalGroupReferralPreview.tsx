import { useMemo, useState, useSyncExternalStore } from 'react'
import { GroupReferralCampaign } from './GroupReferralCampaign'
import { createLocalGroupReferralStore } from '../../lib/localGroupReferralRepository'
import { GROUP_REFERRAL_PREVIEW_ACTORS as ACTORS } from '../../lib/groupReferralPreviewSeed'
import { groupReferralError } from '../../lib/groupReferralTypes'
import { normalizeGroupReferralCode } from '../../lib/groupReferralInvitation'

const store = createLocalGroupReferralStore()
const fakeNow = () => Date.parse(store.now())
const button = 'min-h-10 rounded-xl border border-white/25 px-3 py-2 text-xs font-semibold hover:bg-white/10'

/** Standalone synthetic entry. Never imported by the production application. */
export function LocalGroupReferralPreview() {
  const revision = useSyncExternalStore(store.subscribe, store.getRevision, store.getRevision)
  const [actor, setActor] = useState<string | null>(ACTORS.organizerA)
  const [epoch, setEpoch] = useState(0), [code, setCode] = useState(() => { const search = new URL(window.location.href).searchParams; return normalizeGroupReferralCode(search.get('ref')) || normalizeGroupReferralCode(search.get('code')) || '' }), [error, setError] = useState('')
  const [selected, setSelected] = useState(store.getScenarioState().groups[6]?.id || '')
  const repository = useMemo(() => store.repositoryFor(actor), [actor, epoch])
  const state = store.getScenarioState(), actors = store.actors()
  const selectable = actors.filter(item => item.previewRole !== 'student' || item.id === actors.find(x => x.previewRole === 'student')?.id)
  const refresh = () => setEpoch(value => value + 1)
  const simulate = (action: () => void) => { try { setError(''); action(); refresh() } catch (cause) { setError(groupReferralError(cause)) } }
  const chooseActor = (value: string) => { setActor(value || null); setError('') }
  const createGroup = () => simulate(() => {
    const headman = actors.find(item => item.previewRole === 'headman' && !state.groups.some(group => group.headmanId === item.id)) || actors.find(item => item.previewRole === 'headman')!
    setSelected(store.simulateGroupCreation({ headmanId: headman.id, groupName: `Нова група ${state.groups.length + 1} · приклад` })); setActor(headman.id)
  })
  return <>
    <header className="bg-[#3d0718] px-4 py-4 text-white sm:px-8">
      <div className="mx-auto max-w-7xl">
        <div className="flex flex-wrap items-center justify-between gap-3"><a className="font-serif text-3xl font-bold" href="#">Xelay</a><strong className="rounded-full bg-white/10 px-4 py-2 text-xs">Локальний перегляд · усі дані вигадані</strong></div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-xs">Переглянути як<select aria-label="Переглянути як" value={actor || ''} onChange={event => chooseActor(event.target.value)} className="mt-1 block min-h-10 max-w-[90vw] rounded-xl bg-white px-3 text-sm text-[#3d0718]"><option value="">Гість</option>{selectable.map(item => <option key={item.id} value={item.id}>{item.alias}</option>)}</select></label>
          <p className="pb-2 text-xs text-white/70">Час прикладу: {new Intl.DateTimeFormat('uk-UA', { timeZone: 'Europe/Kyiv', dateStyle: 'medium', timeStyle: 'short' }).format(fakeNow())} · {state.campaign.state} · зміна {revision}</p>
          <button className={button} onClick={() => simulate(() => store.advanceClock(1))}>Наступний день</button>
        </div>
        <details className="mt-3 border-t border-white/15 pt-3"><summary className="cursor-pointer text-xs font-medium">Перевірка сценаріїв на вигаданих даних</summary>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs">Група<select aria-label="Тестова група" value={selected} onChange={event => setSelected(event.target.value)} className="mt-1 block min-h-10 max-w-[88vw] rounded-xl bg-white px-3 text-sm text-[#3d0718]"><option value="">Оберіть групу</option>{state.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
            <button className={button} disabled={!selected} onClick={() => simulate(() => store.simulateGroupContent({ groupId: selected, schedule: true, resource: true }))}>Додати розклад і матеріал</button>
            <button className={button} disabled={!selected} onClick={() => simulate(() => store.fillVerifiedMembers(selected, 10))}>Додати 10 студентів</button>
            <button className={button} disabled={!selected} onClick={() => simulate(() => store.readForMembers(selected, 'schedule'))}>Студенти відкрили розклад</button>
            <button className={button} disabled={!selected} onClick={() => simulate(() => store.readForMembers(selected, 'material'))}>Студенти відкрили матеріал</button>
            <button className={button} onClick={createGroup}>Створити нову групу</button>
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs">Вхідний код запрошення<input aria-label="Вхідний код запрошення" value={code} onChange={event => setCode(event.target.value.toUpperCase())} className="mt-1 block min-h-10 rounded-xl bg-white px-3 text-sm text-[#3d0718]" placeholder="LOCAL-DDDD-2026" /></label>
            <button className={button} onClick={() => simulate(() => { store.resetDemo(); setActor(ACTORS.organizerA); setSelected(store.getScenarioState().groups[6]?.id || '') })}>Відновити готовий приклад</button>
            <button className={button} onClick={() => simulate(() => { if (window.confirm('Очистити лише вигаданий приклад та пройти шлях від чернетки?')) { store.resetDraft(); setActor(ACTORS.admin); setSelected('') } })}>Почати з чернетки</button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-white/65">Ці кнопки змінюють тільки приклад у цьому браузері. Код, студенти, дні й призи тут тестові. Прийом заявок, перевірка та розіграш відбуваються через звичайні кнопки нижче.</p>
        </details>
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-100 p-3 text-sm text-red-900">{error}</p>}
      </div>
    </header>
    <GroupReferralCampaign repository={repository} initialCode={code} now={fakeNow} onAuthRequest={() => chooseActor(ACTORS.organizerD)} onCreateGroup={createGroup} />
  </>
}
