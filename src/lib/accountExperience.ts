import type { XelayUser } from '../types'

export type AccountExperienceProfile = Pick<XelayUser,
  'accountType' | 'isTeacher' | 'teacherVerificationStatus' | 'isPlatformAdmin'>

/** Presentation only: teacher intent never grants teaching permissions. */
export function isTeacherExperience(profile: AccountExperienceProfile | null | undefined): boolean {
  return Boolean(profile && (profile.accountType === 'teacher' || profile.isTeacher === true
    || profile.teacherVerificationStatus && profile.teacherVerificationStatus !== 'none'))
}

export function isStudentAnnouncementAudience(profile: AccountExperienceProfile | null | undefined): boolean {
  // A rejected/revoked teacher request still must not restart student promotions.
  // Ordinary student sections and permissions are independent of this UI choice.
  return Boolean(profile && !isTeacherExperience(profile) && profile.isPlatformAdmin !== true)
}
