import type { TeachingRepository } from './teaching'

/** Share pending reads within one mounted account. Settled data is never cached. */
export function createTeachingReadRepository(source: TeachingRepository, scope: string): TeachingRepository {
  if (!scope.trim()) throw new Error('A teaching account scope is required')
  const pending = new Map<string, Promise<unknown>>()

  function read<T>(method: string, args: unknown[], operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([scope, method, ...args])
    const existing = pending.get(key)
    if (existing) return existing as Promise<T>
    const promise = Promise.resolve().then(operation)
    pending.set(key, promise)
    const release = () => { if (pending.get(key) === promise) pending.delete(key) }
    // An explicit rejection handler releases failures without an unhandled finally promise.
    void promise.then(release, release)
    return promise
  }

  async function write<T>(operation: () => Promise<T>): Promise<T> {
    pending.clear()
    try { return await operation() }
    finally { pending.clear() }
  }

  return {
    ...source,
    workspace: () => read('workspace', [], () => source.workspace()),
    course: id => read('course', [id], () => source.course(id)),
    group: id => read('group', [id], () => source.group(id)),
    groupMaterials: id => read('groupMaterials', [id], () => source.groupMaterials(id)),
    groupAssignments: (id, date) => read('groupAssignments', [id, date], () => source.groupAssignments(id, date)),
    assignmentLessons: (courseId, groupId, date) => read('assignmentLessons', [courseId, groupId, date], () => source.assignmentLessons(courseId, groupId, date)),
    scheduledItems: groupId => read('scheduledItems', [groupId ?? null], () => source.scheduledItems(groupId)),
    teacherCalendar: (from, to) => read('teacherCalendar', [from, to], () => source.teacherCalendar(from, to)),
    gradeRequests: courseId => read('gradeRequests', [courseId ?? null], () => source.gradeRequests(courseId)),
    myMaterials: () => read('myMaterials', [], () => source.myMaterials()),
    materialLibrary: () => read('materialLibrary', [], () => source.materialLibrary()),
    groupContext: id => read('groupContext', [id], () => source.groupContext(id)),
    classroom: (itemId, groupId) => read('classroom', [itemId, groupId], () => source.classroom(itemId, groupId)),
    classroomSeminars: (courseId, groupId) => read('classroomSeminars', [courseId, groupId], () => source.classroomSeminars(courseId, groupId)),
    mutate: (action, payload) => write(() => source.mutate(action, payload)),
    classroomMutate: (action, payload) => write(() => source.classroomMutate(action, payload)),
    setCalendarLesson: (...args) => write(() => source.setCalendarLesson(...args)),
    requestGrade: (...args) => write(() => source.requestGrade(...args)),
    resolveGradeRequest: (...args) => write(() => source.resolveGradeRequest(...args)),
    withdrawMaterial: (...args) => write(() => source.withdrawMaterial(...args)),
    // Keep per-caller cancellation, progress callbacks and binary buffers independent.
    findColleague: source.findColleague.bind(source),
    upload: source.upload.bind(source),
    fileUrl: source.fileUrl.bind(source),
    materialFileInfo: source.materialFileInfo.bind(source),
    materialFileChunk: source.materialFileChunk.bind(source),
    uploadSubmission: source.uploadSubmission.bind(source),
    submissionFileUrl: source.submissionFileUrl.bind(source),
  }
}
