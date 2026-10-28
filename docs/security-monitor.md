# Security monitoring prepared locally

Status: a reviewable local implementation. No production SQL, environment settings, repository settings, Telegram messages, paid services or deployments are activated by these files. The Google Play registration is a separate task.

## Components

- `docs/security-ci.md` describes automatic change checks, required pull-request checks and the production build gate.
- `supabase/setup/security_monitor_20261028.sql` installs private aggregate state, detection policies and durable delivery leases. It intentionally lives outside automatically applied migrations.
- `server/securityMonitor.ts` reads fixed, bounded log aggregates and delivers sanitized alerts through the existing private administrator Telegram bot.
- `server/securityMonitorPolicy.ts` owns the allowlisted Ukrainian message text.
- `server/notificationRetry.ts` starts the optional monitor only after authorizing the existing recurring worker, independently of mail configuration.
- `scripts/preview-security-monitor.mjs` demonstrates fictional scenarios and the actual message formatter without live services.

No new Vercel function or Vercel paid cron is required. The existing Supabase notification cron already invokes the authenticated retry worker. The monitor has an independent default-off flag and database polling lease, so repeated minute invocations do not query logs every minute.

## What is observed

The collector queries Supabase's current Management API endpoint, `/v1/projects/{ref}/analytics/endpoints/logs`, using ClickHouse SQL against `logs`. The removed `logs.all` endpoint and old BigQuery queries are not used.

One fixed aggregate query reads API Gateway, Auth and Storage observations in a complete UTC five-minute window, with one minute allowed for ingestion. API Gateway and Auth observations can overlap; they are evaluated separately and are never added as a count of unique requests. There is no query parameter accepting caller-provided SQL, paths, identities or destinations.

Default detection policies:

| Signal | Minimum events and proportion | Meaning |
| --- | --- | --- |
| Auth error responses | 30 and 50% in a window | Includes authentication and session-refresh failures; not proof of password guessing. |
| API server errors | 15 and 10% | A service-health issue requiring investigation, not an automatically confirmed attack. |
| API access denials | 50 and 30% | HTTP 401/403 responses requiring investigation. |
| Storage access denials | 20 and 40% | HTTP 401/403 responses for files. |
| API volume anomaly | At least 3,000 and over five times baseline | Requires six contiguous prior observed windows; no volume alert during cold-start baseline collection. |
| Degraded log coverage | Three consecutive degraded polls | Missing configuration, inaccessible logs or partially unknown HTTP statuses must not appear as verified safety. |
| Protection drift | One protected table missing or RLS disabled | Database configuration requires review. Enabled RLS alone does not prove every policy is correct. |
| Administrator MFA | One administrator without a verified factor | Configuration requires review; identifiers are not included in Telegram. |
| Administrator-role change | A change fact in a five-minute window | A potentially legitimate administrative operation to verify. |

Unknown status values remain explicit. Partial coverage retains measurements from other fully known sources, raises a coverage warning after repeated degradation and never converts unreadable observations into successful responses. Zero captured events means no events were recorded in the selected window, not that no threats exist.

The initial protection baseline includes fixed required tables and every currently RLS-enabled regular or partitioned table in `public`. It therefore includes deployed academic grades, submissions, memberships and materials when present. Re-running setup adds newly protected tables and retains earlier entries. After an intentionally approved table rename or removal, an operator must explicitly review and update the private baseline; silently forgetting a disappeared table would defeat drift detection.

## Delivery, privacy and failure handling

Only the trusted backend database role can poll, submit observations or claim/acknowledge delivery. Browser accounts cannot submit fabricated incidents, read the private queue or bypass this using editable JWT metadata. Tables have RLS and no client grants; helpers use a fixed empty search path.

Telegram receives allowlisted event names, severity, aggregate counts, thresholds and normalized UTC time windows. It receives no names, emails, IP addresses, request URLs, tokens, grades, submitted work, files, provider errors or raw log records. A destination must be the existing numeric private group/supergroup and pass a live `getChat` check; public usernames/channels are rejected. Content protection is requested, but cannot prevent every recipient from copying information.

An incident's coherent measurement/time snapshot is retained while cooldown coalesces repeated signals. Same-kind alerts have a 30-minute cooldown; global delivery attempts are capped at six per hour. There is one live delivery lease, bounded retry attempts and provider Retry-After handling. Telegram has no send-message idempotency key: a lost receipt after a successful send can still produce a duplicate. Exactly-once delivery is not claimed.

Metrics are retained for seven days, incidents for 30 days and delivery-attempt counters for an hour. All are aggregate data. Cleanup follows the fixed polling cadence. No automatic bans, account restrictions, permission changes, removal of student data, key rotations or rollback actions are performed by this monitor.

## Configuration for a later approved rollout

Existing server settings are reused:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY (or existing SUPABASE_SERVICE_ROLE alias)
ADMIN_ALERT_TELEGRAM_ENABLED
ADMIN_ALERT_TELEGRAM_BOT_TOKEN
ADMIN_ALERT_TELEGRAM_CHAT_ID
```

New settings, never put into client bundles, Git or screenshots:

```text
SECURITY_MONITOR_ENABLED=false
SECURITY_MONITOR_SUPABASE_LOGS_TOKEN=<project-scoped read-only logs token>
SECURITY_MONITOR_PROJECT_REF=<optional exact match for the canonical Supabase URL>
```

For logs use only a fine-grained token scoped to this project with `analytics_logs_read` (or equivalent authorized `analytics:read` scope). A Data API service-role key is not a Management API logs token. This preparation does not create credentials. Creating persistent read access requires the user's explicit approval at rollout time.

The project reference is derived from the canonical `https://<project-ref>.supabase.co` server URL. An explicitly configured different reference, or a custom domain that cannot establish that binding, disables log collection rather than reading another project's logs. Database checks remain independent. For this version use the project's canonical server URL.

Both `SECURITY_MONITOR_ENABLED` and the existing Telegram flag must be true to run. With flags off there are no monitor provider calls. Missing logs access is reported as not configured, not healthy. Log-provider 401/403/402/429 and malformed responses produce bounded retry/backoff; a payment-required response pauses log reads instead of upgrading a plan or creating a paid fallback. The module's run deadline is bounded within the existing 53-second worker budget; a monitoring failure cannot break existing email delivery.

The normal cadence is at most one aggregate logs request per five minutes (288 per day). No paid log drains, new monitoring SaaS, external LLM or dedicated server are used. Existing Supabase/Vercel usage quotas still apply; free/unlimited operation of the underlying platforms is not promised. GitHub private-repository runner minutes also require the $0 paid-usage budget check described in `security-ci.md` before activation.

## Safe activation order

1. Review the local diff and dependency-repair candidates. Reconcile the eight unrelated pre-existing modified files rather than publishing them wholesale. Retain the original failing and repaired audit reports.
2. Check GitHub's included Actions allowance and configure the intended $0 paid-usage limit before activating workflows. Prepare required PR checks and prevent direct/bypassed production-branch pushes.
3. Apply the clean Vercel build-command change after approval. Confirm dashboard overrides do not bypass `node scripts/security-ci/release-gate.mjs && npm run build`.
4. Deploy backwards-compatible default-off server code after approval, then explicitly apply the reviewed SQL setup. Do not change existing client grants or weaken MFA.
5. Create/configure only the approved project-scoped log-read credential. Reuse the existing private bot destination and notification-worker secret/cron; do not print or copy actual credential values into a runbook.
6. Enable the monitor flag after SQL and configuration are ready. Check actual coverage, UTC windows, expected table baseline, lease progress and worker heartbeat. Synthetic local results are not proof of provider-side readiness.
7. Send a single deliberate production verification alert only with the user's approval of that message/destination. Verify the receipt and subsequent silence/cooldown rather than generating repeated live attacks or student activity.

Rollback starts by disabling `SECURITY_MONITOR_ENABLED`; this leaves existing mail/request notifications running. The private queue/history can be retained for investigation. Removing the optional trigger/functions/schema is a separate reviewed operation; deletion of history is never part of an automatic rollback.

## Limits and response procedure

This is bounded detection and notification, not a complete security audit, antivirus or autonomous incident response. Successful unauthorized access caused by an incorrect policy can look like HTTP 200; tests and code review remain necessary. This version does not identify individual attackers, detect all data extraction, scan uploaded malware, inspect Android-device compromise or automatically collect billing usage.

The monitor evaluates its latest complete observation window. Historical windows missed while the worker was entirely offline are not automatically backfilled. When Supabase cron, the database, Vercel or Telegram itself is unavailable, same-stack delivery can also be delayed or impossible. There is no independent external uptime watchdog configured by this task.

On an alert, inspect restricted logs, compare with expected activity and the latest release, then classify it as a bug, configuration mistake or suspected abuse. Any blocking, session/key revocation or rollback should be a scoped operator decision. Shared university networks make automatic IP bans especially prone to affecting legitimate students.

## Primary references

- [Supabase logs API and read scope](https://supabase.com/docs/reference/api/v1-get-project-logs)
- [Bounded ClickHouse log queries](https://supabase.com/docs/guides/observability/advanced-log-filtering)
- [Source field reference](https://supabase.com/docs/guides/observability/log-field-reference)
- [Detection and incomplete observations](https://supabase.com/docs/guides/observability/detecting)
- [Storage log status field](https://supabase.com/docs/guides/storage/debugging/logs)
- [Logs usage and quotas](https://supabase.com/docs/guides/platform/manage-your-usage/logs)
- [Vercel Firewall](https://vercel.com/docs/vercel-firewall)
