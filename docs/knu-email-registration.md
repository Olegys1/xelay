# KNU email registration and existing-account verification

This change is prepared locally. It does not enable a live Auth hook, send mail,
create production credentials, change billing or migrate any production account.

## Behavior

- New Auth users require an exact ASCII `@knu.ua` address. The domain rule applies
  to password, OAuth and direct Auth API creation. A server trigger protects the
  Auth row in addition to the Before User Created hook and the form validation.
- Email ownership must be confirmed by Supabase Auth. A matching suffix alone
  does not prove ownership. Teacher/headman permissions keep their own checks.
- Every Auth UUID present at migration time is captured in a private, fixed
  legacy list, including incomplete Google profiles. Existing email/password,
  recovery and Google login keep their current canonical address and identity.
- Legacy users can verify a secondary KNU address inside their existing profile.
  This does not create an Auth user, change the login address, merge accounts,
  alter a group, overwrite grades or grant a role.
- The secondary address and challenges are private. The public profile and
  student lists do not expose them. Only an authenticated owner sees the status.
- Address verification is initiated only by pressing the send-code button.
  Codes expire after ten minutes, are bound to user/address/challenge, have five
  persistent attempts, and are consumed once. Only an HMAC digest is stored.
  A separate server secret is required; no provider secret or token is sent to
  the browser. Persistent send limits remain in PostgreSQL across invocations.
- New company-account registration is subject to the same institutional rule.
  Self-declared account metadata is not an exception. An external-employer
  invitation policy, if needed later, requires a separately reviewed design.

## Mandatory activation checks

Do not enable the feature based only on SQL fixtures or a successful local demo.
The local PostgreSQL fixture does not run GoTrue or deliver actual email.

1. Check Supabase Auth **Confirm email is ON**. New email/password signups must
   have no session until a real confirmation link is accepted. This is a release
   blocker: Auth autoconfirm can make a `confirmed_at` field appear without a
   mailbox challenge. Also verify the actual Google identity-verification flow.
2. Review the fixed legacy snapshot and existing confirmed KNU-address conflicts
   before applying `202611030002_knu_email_registration.sql`. Its transaction
   locks Auth inserts while capturing the snapshot and installing the guard.
   Reapplying it or refreshing the legacy list is intentionally rejected.
3. Configure the PostgreSQL Before User Created hook as
   `public.xelay_before_user_created_knu`. Retain the existing Auth privacy,
   registration, Google profile-completion and SMTP settings. Do not disable
   confirmation, remove an identity, edit Auth emails or broaden client grants.
4. Prepare a distinct random server `KNU_EMAIL_CODE_SECRET` of at least 32 bytes,
   outside the repository. Reuse the existing approved Supabase and Resend
   configuration. Verify `XELAY_PUBLIC_URL` matches the canonical browser origin.
5. Set server `KNU_EMAIL_AUTH_CONFIRMATION_REVIEWED=true` only after step 1,
   then `KNU_EMAIL_VERIFICATION_ENABLED=true`. Missing flags, key material or
   configuration return a private 503 without sending a message. The profile card
   is independently gated by `VITE_KNU_EMAIL_VERIFICATION_ENABLED=true`.
6. In an authorized isolated environment test new KNU confirmation, rejected
   personal-email signup through the direct API and OAuth, existing personal
   login/recovery and incomplete Google profile completion. Test secondary
   request/verify/resend, expired and wrong codes, unavailable mail delivery and
   an address already owned by another confirmed account. Check real GoTrue
   errors do not expose registry membership or unverified account reservations.
7. Only after those checks publish the coordinated frontend/server release.
   Existing users should not be logged out, renamed or forced into a new account.

The extra confirmation-review flag records an operator check; it does not itself
read or enforce the managed Auth configuration. Production must be rechecked if
that configuration changes. The signup trigger stays installed independently of
the secondary-mail endpoint flags; disabling the endpoint is not a rollback of
the signup rule. Existing accounts can continue to log in with their old email.

## Local demonstration

`node scripts/preview-knu-email.mjs --port 3083` uses the actual registration
modal and profile verification component with synthetic adapters. It does not
load dotenv files or construct a production Supabase client. `/api/` calls are
blocked, and the email-code example uses `123456` with invented addresses.
Local success confirms UI behavior, not access to a real KNU mailbox or working
Supabase Auth/SMTP configuration.
