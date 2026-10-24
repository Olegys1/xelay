# Teaching academic expansion — local review

The user reviewed the local implementation and approved production connection and publication on 24 October 2026. All three server migrations were then applied atomically to Supabase Xelay mvp. Frontend publication is carried by this scoped release commit.

## Local review

Run `node scripts/preview-teaching.mjs --port 3045` and open `http://127.0.0.1:3045/.teaching-preview.local/index.html`.

The preview uses fictional identities and local repositories. Its server configuration points Supabase to an unused loopback endpoint, so it cannot edit production groups, accounts or messages.

- **Профіль і контакти** uses the real academic profile editor. Saved local contact permissions update both the public-profile projection and the group-directory example.
- **Погодження строку** uses the real administrative period control against the same fictional profile. A postgraduate flag does not assign an automatic expiry.
- **Завдання та журнал** opens the existing teaching workspace. Group 1 inherits course rules; group 2 demonstrates an override. Assignment and journal editors support presets and independent semantic work types. See `teaching-grading-presets-local.md` for the retained formula and server contracts.
- **Зв’язок у групі** uses the actual directory component. Its local conversation displays the academic student identity; demonstration messages stay in memory.

## Profile and privacy

`teacher_academic_profiles` is a private RPC-only record. Teacher position and postgraduate study are independent. A teacher requests an optional end date; a separate administrative action approves it. The administrative panel exposes a counted **Строки** queue for pending period changes, including already approved teachers. Both administrative review commands bind the expected administrator identity. An approved end date is inclusive in Kyiv. Existing verification and history remain readable after expiry; new teaching actions, uploads, scheduled publication and academic-only messaging require current access. Authors can still withdraw their own materials.

Contact email is separate from authentication email. Email, phone and Telegram each have independent group and public visibility flags, all false by default. Public profiles receive only the explicitly public projection. A group projection additionally checks actual membership and accepted teaching links. Contact values never enter public authentication metadata.

Optional details entered during an email signup without a session remain in UID-bound session storage for up to 24 hours. After that same confirmed user completes registration, the authenticated private save consumes the draft. Logout clears it; a draft is never transferred to another account. The authenticated save also validates its expected user on the server.

## Academic conversations

Opening a conversation requires the actual student, accepted group membership, an accepted course/group link and a verified teacher with current access to that course. It neither accepts a friendship nor sends a message. The private provenance record supplies the student's current name, group, program, year/level, faculty and relevant course to the conversation participants.

Every academic-only send revalidates the relationship. Existing friendship conversations retain their normal authorization. The original message rate limits, immutable retry identity and attachment/reply rules are preserved. Removing the academic relationship stops new academic-only sends while keeping existing conversation history accessible to its participants.

## Applied database changes

Applied together in one transaction after approval, in this order:

1. `202610240002_teacher_academic_profile.sql`
2. `202610240003_academic_contacts.sql`
3. `202610240004_grading_templates_and_work_types.sql`

Each migration is transactional and preserves the existing authorization paths. Exact function-body patches abort on an unexpected deployed definition rather than replacing a changed security contract. The existing student roster-confirmation action remains authorized as a student action.

## Review record

The integrated TypeScript check and whitespace check passed. A separate static code review covered consent projections, academic-message authorization, approved expiry, actor binding, effective group grading and request replay. Fixes include preserving student roster confirmation and making classification part of canonical versioned mutations before receipt storage.

Production installation receipt: `77a5f3c5-cd72-446e-937a-a7ae6cca5cb8`. The read-only preflight confirmed every exact patch anchor. Comparison fragments and function definitions normalize CR symmetrically to handle Windows clipboard line endings without weakening the checks.

The postflight confirmed all 23 new function contracts, unchanged existing function ACLs, RLS and no client table grants on all three private tables, six false contact-visibility defaults, and all installation markers. All baseline row counts and raw/published grade aggregates were unchanged: five grade records, draft sum 7.5 and published sum 6.5. The new private tables were empty. Period-request notifications require a verified teacher and deduplicate per teacher/Kyiv day; expired verified teachers can still request renewal.

No automated tests or local production build were run. Catalog checks confirm installation and retained data, not a live end-to-end run that changes real grades, contacts or student messages. The deployment service builds the scoped release. Existing paused assistant and iOS work is outside this batch.
