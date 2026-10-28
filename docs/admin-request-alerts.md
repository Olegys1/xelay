# Administrator request alerts

The existing private Telegram administrator bot reports both pending class-representative requests and pending teacher-verification requests. It sends aggregate counts and waiting time only, with separate links to the corresponding sections of `/admin`. Applicant names, contacts, notes, attachments and request IDs are never sent to Telegram.

`202610280001_admin_teacher_alerts.sql` adds a teacher-table trigger and a private aggregate helper. The representative-only administrator summary and its MFA rules remain unchanged. The service worker's existing claim/context/receipt functions use the combined pending queue. No additional client table grants or public RPC grants are introduced.

The existing notification worker invokes the bot independently of Resend and user email preferences. New pending requests make the shared queue due, including resubmissions after rejection. Already pending teachers are included once on installation. Multiple arrivals may coalesce into one message. Successful pending-queue reminders repeat hourly until reviewed. A live summary is checked immediately before sending, so an empty reviewed queue is skipped. A Telegram outage retries with bounded backoff; provider Retry-After, active leases and generation acknowledgements are preserved. Telegram does not offer a sendMessage idempotency key, so a lost receipt can cause a duplicate reminder.

Deploy the backwards-compatible worker first, then apply the migration. The worker accepts the legacy representative-only result until the migration is installed. The new migration is repeatable and fails closed if the expected delivery function anchors or existing permissions differ. The administrator-only teacher section has a stable `teacher-verification-requests` anchor for the bot button.

Validation uses `node --test scripts/admin-request-alerts.test.mjs scripts/security/admin-teacher-alerts-database.test.mjs` with fake Telegram/Supabase providers and an in-memory database. No applicant records or test notifications are created in production. This focused regression check is separate from the paused Darkmoon assessment.
