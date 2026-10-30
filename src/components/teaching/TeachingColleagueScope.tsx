import type { TeachingGroup, TeachingPermission } from '../../lib/teaching'
import { TEACHING_PERMISSIONS } from '../../lib/teaching'
import { teachingPermissionDescriptions, type TeachingGroupScope } from '../../lib/teachingColleagues'
import { teachingGroupDirectoryLabel } from '../../lib/teachingGroupDirectory'
import { isStudyGroupListed } from '../../lib/studyGroupVisibility'

export function TeachingColleagueScope({ groups, scope, onScope, permissions, onPermissions, disabled = false }: {
  groups: TeachingGroup[]; scope: TeachingGroupScope; onScope(value: TeachingGroupScope): void;
  permissions: TeachingPermission[]; onPermissions(value: TeachingPermission[]): void; disabled?: boolean
}) {
  const accepted = groups.filter(group => group.status === 'accepted' && isStudyGroupListed(group.group_id))
  return <>
    <fieldset className="space-y-3 rounded-xl border border-border p-4" disabled={disabled}><legend className="px-1 text-sm font-semibold">Групи для спільного викладання</legend>
      <button type="button" className="text-xs font-medium text-primary underline underline-offset-4" onClick={() => onScope({ group_scope: 'selected', group_ids: [...scope.group_ids.filter(id => !isStudyGroupListed(id)), ...accepted.map(group => group.group_id)] })}>Обрати всі поточні групи</button>
      <div className="space-y-2">{accepted.map(group => <label className="teaching-check items-start" key={group.group_id}><input type="checkbox" className="mt-1 shrink-0" checked={scope.group_ids.includes(group.group_id)} onChange={event => onScope({ group_scope: 'selected', group_ids: event.target.checked ? [...scope.group_ids, group.group_id] : scope.group_ids.filter(id => id !== group.group_id) })} /><span className="min-w-0 break-words text-xs leading-5">{teachingGroupDirectoryLabel({ ...group, id: group.group_id })}</span></label>)}{!accepted.length && <p className="teaching-note">Спочатку підключіть і підтвердьте навчальну групу.</p>}<p className="text-xs leading-5 text-muted-foreground">Нові групи предмета не додаватимуться до цього доступу автоматично.</p></div>
    </fieldset>
    <fieldset className="space-y-3" disabled={disabled}><legend className="mb-2 text-sm font-semibold">Що може колега в цих групах</legend>{TEACHING_PERMISSIONS.map(permission => <label className="teaching-check items-start" key={permission.id}><input className="mt-1 shrink-0" type="checkbox" checked={permissions.includes(permission.id)} onChange={event => onPermissions(event.target.checked ? [...permissions, permission.id] : permissions.filter(id => id !== permission.id))} /><span><strong className="block text-sm font-medium">{permission.label}</strong><span className="mt-1 block text-xs leading-5 text-muted-foreground">{teachingPermissionDescriptions[permission.id]}</span></span></label>)}</fieldset>
    <p className="teaching-note">Спільне викладання не передає авторських прав. Керувати предметом, групами та запрошеннями може власник предмета. Внутрішні запитання студентів і розподіл на команди залишаються закритими.</p>
  </>
}
