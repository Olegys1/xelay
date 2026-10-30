/** Explicitly unlisted test groups. Names and representative names are not identities.
 * This controls list presentation only; it never grants or revokes group access. */
export const HIDDEN_TEST_STUDY_GROUP_IDS = [
  '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4',
  '445fcadc-95e2-4f8c-bfb3-6d0998030a01',
] as const

const hiddenTestGroupIds = new Set<string>(HIDDEN_TEST_STUDY_GROUP_IDS)

// Only these two verified platform accounts can see the test groups in lists.
// This is a display exception, never a group-membership or permission grant.
export const TEST_STUDY_GROUP_VIEWER_IDS = [
  '04f587f8-1604-4f53-aabc-d1699c938b1d',
  'b6d61792-89c5-48af-ad52-73806352ae61',
] as const
const testGroupViewerIds = new Set<string>(TEST_STUDY_GROUP_VIEWER_IDS)

export function canListTestStudyGroups(viewerId: unknown): boolean {
  return typeof viewerId === 'string' && testGroupViewerIds.has(viewerId.trim().toLowerCase())
}

export function isStudyGroupListed(groupId: unknown, viewerId?: string | null): boolean {
  // Keep malformed input visible to the caller's existing validation.
  return typeof groupId !== 'string' || !hiddenTestGroupIds.has(groupId.trim().toLowerCase()) || canListTestStudyGroups(viewerId)
}
