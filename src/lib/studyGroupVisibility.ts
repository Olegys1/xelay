/** Explicitly unlisted test groups. Names and representative names are not identities.
 * This controls list presentation only; it never grants or revokes group access. */
export const HIDDEN_TEST_STUDY_GROUP_IDS = [
  '437c96ae-19d1-4bed-ae69-0b83ae9ec1b4',
  '445fcadc-95e2-4f8c-bfb3-6d0998030a01',
] as const

const hiddenTestGroupIds = new Set<string>(HIDDEN_TEST_STUDY_GROUP_IDS)

export function isStudyGroupListed(groupId: unknown): boolean {
  // Keep malformed input visible to the caller's existing validation.
  return typeof groupId !== 'string' || !hiddenTestGroupIds.has(groupId.trim().toLowerCase())
}
