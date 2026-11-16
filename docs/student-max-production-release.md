# Student subscription / Max production release

User authorization:2026-11-16. Student prices confirmed: Start149, Plus399, Max999UAH per calendar month. Only Max receives an included model allowance, up to6USD per UTC calendar month. No automatic renewal or automatic overage payment. Existing Participant paid time and gifts/lifetime benefits remain; they do not become unlimited model allowance.

## Release sequence

1. Run mandatory security core, isolated application build, secret preflight and exact-commit CI checks. Keep the production and preview deployment gates mandatory.
2. Apply `202611160100_student_max_workspace.sql`, then `202611160110_student_plan_billing.sql` to the intended Xelay project. Each file has an explicit transaction and drift/prerequisite guards; inspect a failure instead of repeatedly running the bundle. Do not apply registration/KNU-only changes or another pending PR.
3. Deploy the checked commit. The new backend and public sales remain disabled unless their server-only switches are enabled. Existing payment callbacks and legacy100UAH pending orders remain supported.
4. In the existing production project set `STUDENT_MAX_ENABLED=true`, `STUDENT_MAX_AI_ENABLED=true`, `STUDENT_MAX_MODEL=gpt-6.1-sol`; use the existing server-only `OPENAI_API_KEY`, never a `VITE_*` credential or a student's key. Verify one authorized Max account can generate before enabling public sales with `STUDENT_PLANS_ENABLED=true`.
5. On a separate test account verify `/learning`: chosen own material → generated quiz → selected answer → refresh → restored answer → submit → feedback → mistake review → opt-in contextual hint/action. Verify source attribution, own history isolation and expiry read/export. Actual teacher tests/grades must not be edited.
6. Verify exact signed checkout prices for all tiers without completing an unintended payment. A return URL alone must not activate access or show confirmed payment. Verified own approved live orders can show the tier-specific animation, including a lifetime Participant owner buying finite Max.

Production activation and real-site verification require authorized Supabase/Vercel access. A local model connection or a passing synthetic test is not proof of production configuration. Record the applied migration versions, deployment commit and live checks separately; do not mark them complete from this checklist alone.

## Access and data boundaries

`/api/student-learning` is the sole new authenticated server function, with allowlisted status/history/generate/progress actions. It verifies the real Supabase user/session, immutable server billing identity and current grant. Student role/cost/model fields supplied by a browser are not authority. Same-origin writes, bounded JSON, input/output moderation, strict artifacts/literal citations, rechecks and atomic quota settlement remain required. A single user has a persistent cap plus bounded generation concurrency/rate. In-process throttling is supplementary; the database enforces distributed generation limits.

The private schema holds grants/periods, source choices, reservations, runs and revisioned progress. Model costs and request fingerprints are idempotent per owner/request. Unknown costs remain conservatively accounted for. A revoked session or stale context cannot store/show an accepted generation. Only explicitly supplied own notes/excerpts are processed; the endpoint cannot retrieve teacher tests, keys or protected originals by a URL. No teacher grading mutation is used by this release.

The UI isolates local tools, PDF databases, draft/outbox and hints by owner. New production workspaces start without synthetic questions, cards, marks or projects. Answer saves use server revisions and a local pending queue; incompatible updates from another tab are preserved for export instead of silently overwritten. New activity is gated after expiry, while own reading/export remains available. Device-labelled tools remain local; generated sessions/answers are server-backed.

«Авто» selects a concrete artifact from the visible request; manual selection remains possible. Side hints are opt-in typed aggregate events, not whole-screen scraping or hidden model calls. They can be paused/dismissed/snoozed, and local reminders operate only while the studio is open. The old global helper is suppressed on `/learning` to avoid overlapping launchers.

## Billing identity and time

Historical editable profile metadata cannot prove the original registration type. Such records are not guessed or mass-migrated. The first verified new student purchase may establish an immutable declared student billing choice; a service-only audited assignment can resolve an intended account. Adding teaching capabilities does not subsequently change that identity. Known teacher accounts retain the legacy Participant purchase path until separate teacher tariffs are introduced.

New orders snapshot plan/amount. Only a verified live approval applies a paid grant; test/pending/refunded/voided orders cannot grant Max. Higher-tier purchases preserve lower-tier remaining time in audited period segments. Same/lower-tier purchases queue without discarding paid time. Calendar-month calculations use Kyiv time; model quota resets use UTC and are labelled separately. Refunds revoke the matching grant and retain model costs already incurred. Legacy premium capabilities must remain available for every active paid private period, including calendar carryover beyond the old core expiry.

Do not treat model-schema validity, a literal quotation or a generated answer key as a guarantee of factual correctness. Voice/OCR/podcasts and superiority over another product are outside this release.
