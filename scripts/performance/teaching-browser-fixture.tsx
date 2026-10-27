// Browser-only behavioral checks of the real React components. All repository
// data is synthetic and stored in memory; this module never uses Supabase.
import { StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { TeachingWorkspace } from '../../src/components/teaching/TeachingWorkspace'
import { TeachingWorkspace as BaselineTeachingWorkspace } from './teaching-baseline-workspace'
import { createLocalTeachingRepository, LOCAL_TEACHING_IDENTITIES } from '../../src/lib/localTeachingRepository'
import type { TeachingRepository, TeachingSnapshot, TeachingWorkspaceData } from '../../src/lib/teaching'

type Deferred = { promise: Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }
type Call = { method: string; args: unknown[]; rpcWeight: number; at: number }
type Result = { name: string; passed: boolean; detail?: unknown; error?: string }
function deferred(): Deferred {
  let resolve!: Deferred['resolve'], reject!: Deferred['reject']
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const copy = <T,>(value: T): T => structuredClone(value)
const wait = (milliseconds = 25) => new Promise<void>(resolve => setTimeout(resolve, milliseconds))
async function until(check: () => boolean, description: string, milliseconds = 3000) {
  const end = performance.now() + milliseconds
  while (!check()) { if (performance.now() >= end) throw new Error(`Timed out: ${description}`); await wait() }
  await wait()
}
function ensure(value: unknown, description: string): asserts value { if (!value) throw new Error(description) }

export async function createInstrumentedTeachingFixture(suffix = '') {
  const local = createLocalTeachingRepository('teacher')
  const seed = await local.workspace()
  const firstCourse = seed.courses.find(item => !item.archived_at && item.owner_id === LOCAL_TEACHING_IDENTITIES.teacher.userId)!
  const original = await local.course(firstCourse.id)
  const courseId = firstCourse.id, secondCourseId = 'c0000000-0000-4000-8000-000000000002'
  const userId = suffix ? `synthetic-user-${suffix}` : LOCAL_TEACHING_IDENTITIES.teacher.userId
  const groups = original.groups.filter(group => group.status === 'accepted').slice(0, 2)
  ensure(groups.length === 2, 'The isolated fixture has two connected groups')
  const course = { ...copy(firstCourse), owner_id: userId, title: `Synthetic mathematics${suffix ? ` ${suffix}` : ''}` }
  const secondCourse = { ...copy(course), id: secondCourseId, title: `Synthetic economics${suffix ? ` ${suffix}` : ''}` }
  const workspace: TeachingWorkspaceData = {
    ...copy(seed), courses: [course, secondCourse], invitations: [], teacher_invites: [], pending_invites: [],
    classrooms: groups.map(group => ({
      ...(seed.classrooms?.find(item => item.group_id === group.group_id) || {}),
      group_id: group.group_id, group_name: group.group_name,
      courses: [{ course_id: courseId }, { course_id: secondCourseId }],
    })) as TeachingWorkspaceData['classrooms'],
  }
  const createdCourses = new Map<string, typeof course>()
  const snapshot = (id: string): TeachingSnapshot => ({ ...copy(original), course: copy(createdCourses.get(id) || (id === secondCourseId ? secondCourse : course)), groups: copy(groups), assignments: [], materials: [] })
  const calls: Call[] = [], pending = new Map<string, Deferred[]>(), failures = new Map<string, Error>()
  let instant = false
  const raw = new Proxy(local, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const method = String(key)
        calls.push({ method, args, rpcWeight: method === 'workspace' ? 2 : 1, at: performance.now() })
        const held = pending.get(method)?.shift()
        if (held) return held.promise
        if (!instant) await wait(10)
        const failure = failures.get(method)
        if (failure) { failures.delete(method); throw failure }
        if (method === 'workspace') return copy(workspace)
        if (method === 'course') return snapshot(String(args[0]))
        if (method === 'mutate' && args[0] === 'create_course') {
          const payload = args[1] as { id: string; title: string }
          const saved = { ...copy(course), ...payload }
          createdCourses.set(saved.id, saved); workspace.courses.push(saved)
          return { id: saved.id }
        }
        return value.apply(target, args)
      }
    },
  }) as TeachingRepository
  return {
    repository: raw, calls, userId, courseId, secondCourseId, groups, workspace, snapshot,
    count: (method: string) => calls.filter(item => item.method === method).length,
    counts: () => Object.fromEntries([...new Set(calls.map(item => item.method))].map(method => [method, calls.filter(item => item.method === method).length])),
    rpcCount: () => calls.reduce((total, item) => total + item.rpcWeight, 0),
    clear() { calls.length = 0 },
    instant(value = true) { instant = value },
    hold(method: string) { const next = deferred(); pending.set(method, [...(pending.get(method) || []), next]); return next },
    fail(method: string) { failures.set(method, new Error('Synthetic transport failure')) },
  }
}

function button(host: HTMLElement, text: string) {
  const node = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === text)
  ensure(node, `Button exists: ${text}`); ensure(!node.disabled, `Button enabled: ${text}`)
  node.click()
}
function select(host: HTMLElement, name: string, value: string) {
  const node = host.querySelector<HTMLSelectElement>(`select[name="${name}"]`)
  ensure(node, `Select exists: ${name}`)
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
  setter.call(node, value); node.dispatchEvent(new Event('change', { bubbles: true }))
}
function setText(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
}

export async function runTeachingBrowserTests(container?: HTMLElement): Promise<{ results: Result[]; comparisons: unknown[] }> {
  const host = container || document.body.appendChild(document.createElement('section'))
  host.dataset.teachingBehavioralTests = 'running'
  let root: Root | undefined
  const results: Result[] = [], comparisons: unknown[] = []
  let visibility = 'visible'
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  const initialDocumentTitle = document.title
  async function unmount() { if (root) { root.unmount(); root = undefined; await wait() } host.replaceChildren() }
  async function mount(fx: Awaited<ReturnType<typeof createInstrumentedTeachingFixture>>, baseline = false, props = {}) {
    await unmount(); root = createRoot(host)
    const Component = baseline ? BaselineTeachingWorkspace : TeachingWorkspace
    root.render(<Component repository={fx.repository} userId={fx.userId} fullName="Synthetic Teacher" initialCourseId={fx.courseId} {...props} />)
    await until(() => Boolean(host.querySelector('[name="classroom-group"]')), 'selected teaching group ready')
    await wait(100)
  }
  async function scenario(name: string, action: () => Promise<unknown>) {
    try { results.push({ name, passed: true, detail: await action() }) }
    catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.message : String(error) }) }
    finally { await unmount() }
  }
  try {
    for (const baseline of [true, false]) {
      const label = baseline ? 'baseline' : 'optimized'
      await scenario(`${label}: open a subject and switch to its other group`, async () => {
        const fx = await createInstrumentedTeachingFixture()
        await mount(fx, baseline)
        const opening = { methods: fx.counts(), rpc: fx.rpcCount() }
        if (!baseline) { ensure(fx.count('workspace') === 1, 'Subject opens with one metadata read'); ensure(fx.count('course') === 1, 'Subject opens with one course read') }
        fx.clear(); select(host, 'classroom-group', fx.groups[1].group_id)
        await until(() => host.querySelector<HTMLSelectElement>('[name="classroom-group"]')?.value === fx.groups[1].group_id, 'second group selected')
        await wait(100)
        const groupSwitch = { methods: fx.counts(), rpc: fx.rpcCount() }
        if (!baseline) ensure(fx.rpcCount() === 0, 'Same subject/group switch does not repeat RPCs')
        comparisons.push({ variant: label, opening, groupSwitch })
        return { opening, groupSwitch }
      })
      await scenario(`${label}: returning to the visible materials section`, async () => {
        const fx = await createInstrumentedTeachingFixture()
        await mount(fx, baseline); button(host, 'Мої матеріали')
        await until(() => fx.count('materialLibrary') === 1 && !host.querySelector('.material-library-loading'), 'library loaded')
        await wait(100); fx.clear()
        visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))
        await wait(50); ensure(fx.rpcCount() === 0, 'Hidden section does not refresh')
        visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus'))
        await until(() => fx.count('materialLibrary') > 0, 'return refresh'); await wait(100)
        const details = { methods: fx.counts(), rpc: fx.rpcCount() }
        if (!baseline) { ensure(fx.count('materialLibrary') === 1, 'Focus and visibility share one library read'); ensure(fx.count('workspace') === 0 && fx.count('course') === 0, 'Hidden group details stay idle') }
        comparisons.push({ variant: label, materialsReturn: details }); return details
      })
    }
    await scenario('optimized: opening a different subject reads only that subject', async () => {
      const fx = await createInstrumentedTeachingFixture(); await mount(fx); fx.clear()
      select(host, 'classroom-course', fx.secondCourseId)
      await until(() => host.querySelector<HTMLSelectElement>('[name="classroom-course"]')?.value === fx.secondCourseId, 'second subject ready'); await wait(100)
      ensure(fx.count('course') === 1 && fx.count('workspace') === 0, 'Only the new course is read')
      return { methods: fx.counts(), rpc: fx.rpcCount() }
    })
    await scenario('optimized: StrictMode effect replay shares initial reads', async () => {
      const fx = await createInstrumentedTeachingFixture(); await unmount(); root = createRoot(host)
      root.render(<StrictMode><TeachingWorkspace repository={fx.repository} userId={fx.userId} fullName="Synthetic Teacher" initialCourseId={fx.courseId} /></StrictMode>)
      await until(() => Boolean(host.querySelector('[name="classroom-group"]')), 'StrictMode initial group'); await wait(100)
      ensure(fx.count('workspace') === 1 && fx.count('course') === 1, 'Effect replay shares pending reads')
      return { methods: fx.counts(), rpc: fx.rpcCount() }
    })
    await scenario('optimized: a newly saved subject reloads once even with instant responses', async () => {
      const fx = await createInstrumentedTeachingFixture(); await mount(fx)
      button(host, 'Мої групи'); await until(() => Boolean([...host.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Новий предмет')), 'new subject button')
      button(host, 'Новий предмет'); await until(() => Boolean(host.querySelector('[name="course-title"]')), 'course form')
      setText(host.querySelector<HTMLInputElement>('[name="course-title"]')!, 'Synthetic newly created subject')
      await wait(50); fx.clear(); fx.instant(); button(host, 'Зберегти')
      await until(() => !host.querySelector('dialog') && host.querySelector('h1')?.textContent === 'Synthetic newly created subject', 'new subject saved')
      await wait(100)
      ensure(fx.count('mutate') === 1, 'The subject is written once')
      ensure(fx.count('workspace') === 1 && fx.count('course') === 1, 'Saved callback and selection effect do not duplicate course reads')
      return { methods: fx.counts(), rpc: fx.rpcCount() }
    })
    for (const [label, method] of [['Мої матеріали', 'materialLibrary'], ['Мій розклад', 'teacherCalendar'], ['Заплановані', 'scheduledItems'], ['Запити щодо балів', 'gradeRequests']]) {
      await scenario(`optimized: header refresh reads only the active ${method} section`, async () => {
        const fx = await createInstrumentedTeachingFixture(); await mount(fx); button(host, label)
        await until(() => fx.count(method) === 1, `${method} initially loaded`); await wait(100); fx.clear()
        button(host, 'Оновити викладання'); await until(() => fx.count(method) === 1, `${method} refreshed`); await wait(100)
        ensure(fx.count('workspace') === 0 && fx.count('course') === 0, 'Header does not refresh hidden group data')
        ensure(fx.count(method) === 1, 'Header refresh does not repeat the active read')
        return { methods: fx.counts(), rpc: fx.rpcCount() }
      })
    }
    await scenario('optimized: returning from library to groups refreshes current permissions and course once', async () => {
      const fx = await createInstrumentedTeachingFixture(); await mount(fx); button(host, 'Мої матеріали')
      await until(() => fx.count('materialLibrary') === 1 && !host.querySelector('.material-library-loading'), 'library ready'); fx.clear()
      button(host, 'Групи')
      await until(() => fx.count('workspace') === 1 && fx.count('course') === 1, 'fresh group workspace'); await wait(100)
      ensure(fx.count('workspace') === 1 && fx.count('course') === 1, 'Return reads fresh metadata and course once each')
      ensure(fx.count('materialLibrary') === 0, 'Unmounted library remains idle')
      return { methods: fx.counts(), rpc: fx.rpcCount() }
    })
    await scenario('optimized: an out-of-order course response cannot restore the previous subject', async () => {
      const fx = await createInstrumentedTeachingFixture(); await mount(fx)
      const pending = fx.hold('course'); select(host, 'classroom-course', fx.secondCourseId)
      await until(() => fx.calls.some(item => item.method === 'course' && item.args[0] === fx.secondCourseId), 'second course pending')
      // Keep the selector usable by asking React to return through the same
      // classroom from the existing metadata while the older read is pending.
      const back = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === 'Мої групи')
      ensure(back, 'Can leave a pending subject'); back.click(); await wait(50)
      const firstGroup = [...host.querySelectorAll<HTMLButtonElement>('.teaching-classroom-card')].find(item => item.textContent?.includes(fx.groups[0].group_name))
      ensure(firstGroup, 'Group remains available'); firstGroup.click()
      await until(() => host.querySelector<HTMLSelectElement>('[name="classroom-course"]')?.value === fx.courseId, 'original subject reopened')
      pending.resolve(fx.snapshot(fx.secondCourseId)); await wait(100)
      ensure(host.querySelector<HTMLSelectElement>('[name="classroom-course"]')?.value === fx.courseId, 'Late response cannot replace current course')
      ensure(host.querySelector<HTMLSelectElement>('[name="classroom-course"]')?.selectedOptions[0]?.textContent?.startsWith('Synthetic mathematics'), 'Selected course detail stays on mathematics')
      return fx.counts()
    })
    await scenario('optimized: switching account discards an earlier pending snapshot', async () => {
      const old = await createInstrumentedTeachingFixture('old'), next = await createInstrumentedTeachingFixture('new')
      const pending = old.hold('course')
      await unmount(); root = createRoot(host)
      root.render(<TeachingWorkspace repository={old.repository} userId={old.userId} fullName="Synthetic Old" initialCourseId={old.courseId} />)
      await until(() => old.count('course') === 1, 'old account request pending')
      root.render(<TeachingWorkspace repository={next.repository} userId={next.userId} fullName="Synthetic New" initialCourseId={next.courseId} />)
      await until(() => Boolean(host.querySelector('[name="classroom-course"]')) && host.textContent?.includes('Synthetic mathematics new') === true, 'new account visible')
      pending.resolve(old.snapshot(old.courseId)); await wait(100)
      ensure(!host.textContent?.includes('Synthetic mathematics old'), 'Previous account data never reappears')
      return { old: old.counts(), new: next.counts() }
    })
    await scenario('optimized: focus preserves an open material editor and unsaved text', async () => {
      const fx = await createInstrumentedTeachingFixture(); await mount(fx); button(host, 'Мої матеріали')
      await until(() => fx.count('materialLibrary') === 1 && !host.querySelector('.material-library-loading'), 'library loaded')
      button(host, 'Додати матеріал')
      await until(() => Boolean(host.querySelector('dialog [name="library-material-title"]')), 'material editor ready')
      const input = host.querySelector<HTMLInputElement>('dialog [name="library-material-title"]')!
      setText(input, 'Synthetic unsaved draft'); await wait(50); fx.clear()
      document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); await wait(100)
      ensure(fx.rpcCount() === 0, 'No refresh starts during a material editor')
      ensure(host.querySelector<HTMLInputElement>('dialog [name="library-material-title"]')?.value === 'Synthetic unsaved draft', 'Unsaved material title stays intact')
      return { rpc: fx.rpcCount(), draftPreserved: true }
    })
    await scenario('optimized: a failed refresh keeps current group data and retry recovers', async () => {
      const fx = await createInstrumentedTeachingFixture(); await mount(fx)
      fx.fail('workspace'); button(host, 'Оновити викладання')
      await until(() => Boolean(host.querySelector('[role="alert"]')), 'refresh error displayed')
      ensure(host.querySelector<HTMLSelectElement>('[name="classroom-group"]')?.value === fx.groups[0].group_id, 'Existing group remains rendered')
      button(host, 'Оновити викладання')
      await until(() => !host.querySelector('[role="alert"]'), 'retry recovered')
      return { selectedGroupPreserved: true, recovered: true }
    })
  } finally {
    await unmount()
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor)
    else delete (document as unknown as Record<string, unknown>).visibilityState
    document.title = initialDocumentTitle
    host.dataset.teachingBehavioralTests = results.every(result => result.passed) ? 'passed' : 'failed'
    if (!container) host.remove()
  }
  return { results, comparisons }
}
