export type AssignmentDeadlineMode = 'fixed' | 'free'

// Existing publications/drafts infer their mode from the saved due date. No date
// or final closing time is changed merely by opening an editor.
export function assignmentDeadlineMode(deadline: string, saved?: AssignmentDeadlineMode): AssignmentDeadlineMode {
  return saved === 'fixed' || saved === 'free' ? saved : deadline ? 'fixed' : 'free'
}

export function validateAssignmentDeadline(mode: AssignmentDeadlineMode, deadline: string, publishing: boolean) {
  if (mode === 'free' && deadline) throw new Error('Оберіть визначений термін або приберіть дату здачі.')
  if (publishing && mode === 'fixed' && !deadline) throw new Error('Оберіть дату й час здачі або «Вільний термін здачі».')
}

export function assignmentDeadlineLabel(due: string | null | undefined, format: (date: string, withTime: boolean) => string) {
  return due ? `Здати до ${format(due, true)}` : 'Вільний термін здачі'
}
