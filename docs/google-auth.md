# Google sign-in for Xelay

## Production activation — 22 October 2026

- Migration `202610220001_google_registration.sql` applied successfully to Xelay mvp (`baohfpadxvhqhhjjqtil`); SQL Editor receipt `3d3c0d43-c7d7-4f32-9980-91554e285e9f`.
- Google Cloud project `Xelay Auth` (`big-guild-512418-a0`), Web OAuth client `Xelay Web`; audience is External / In production. No billing account or trial was connected.
- Google provider enabled in Supabase. Nonce checks stay enabled and email remains required. The client secret was transferred directly to the provider configuration and is not stored in this repository.
- Existing email confirmation/recovery redirects retained. Added only `https://www.xelay.ink/auth/callback?xelay_oauth=google&attempt=*` and the matching apex-domain callback.
- Vercel Production public Config flag `VITE_GOOGLE_AUTH_ENABLED=true` saved before publication.
- Static TypeScript check and independent code review completed. Real Google account sign-in and new-profile completion have not been performed as part of this change.

## Activation order

Keep `VITE_GOOGLE_AUTH_ENABLED` absent or `false` until all server prerequisites are ready. The button is hidden by default. No Google client secret belongs in a Vite variable, repository, browser bundle, or this document.

1. Apply the Google provisional-registration migration. Verify `xelay_google_registration_status()` and `xelay_complete_google_registration(...)` exist with the intended grants and pending-user restrictions.
2. Configure a Google Web application OAuth client and the Google provider in Supabase. The Google redirect URI for this project is `https://baohfpadxvhqhhjjqtil.supabase.co/auth/v1/callback`. Store the client secret only in the Supabase provider configuration. [Supabase Google setup](https://supabase.com/docs/guides/auth/social-login/auth-google)
3. Add Supabase application redirect allowlist entries restricted to the production origins and `/auth/callback`, including its `xelay_oauth=google&attempt=<UUID>` query. A narrowly scoped glob can allow the generated UUID. Keep the existing email-confirmation and recovery URLs. Add a local loopback URL only for the actual development port in use. Do not add a whole-domain or arbitrary Vercel preview wildcard. [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls)
4. Integrate `GoogleRegistrationGate` inside `AdminSecurityGate`, around ordinary platform content. The OAuth callback already includes its own registration gate. The admin MFA gate and its server enforcement remain required after Google login.
5. Enable the public flag only after provider, redirects, migration, and gate are deployed together. This flag controls feature availability; server rules enforce access.

## Browser flow

`authGoogle.ts` uses an isolated PKCE client. It retains only the code verifier in this tab's `sessionStorage`, under a separate key. Session persistence and automatic URL detection for the existing email client remain unchanged. PKCE requires the same browser context for the verifier and callback. [Supabase PKCE](https://supabase.com/docs/guides/auth/sessions/pkce-flow)

The callback is explicitly marked and captured before `authEmail.ts` parses links. The code, errors, and any credential parameters are removed from the address bar immediately. A same-origin, 15-minute attempt marker is required; exchange is single use even under React StrictMode. The application checks the verified Auth user and Google identity before transferring a Supabase access/refresh pair to the main client. Provider tokens are not retained by the isolated client. A different active Xelay session is preserved and produces an account-change message.

Only `openid email profile` is requested. Google Drive, Classroom, contacts, and offline access are outside this login flow. The visible button is Ukrainian and uses Google's official color mark. [Google OAuth scope guidance](https://developers.google.com/identity/protocols/oauth2/web-server), [Google branding](https://developers.google.com/identity/branding-guidelines)

## Identity and completion

Supabase performs automatic identity linking for verified same-email identities. The frontend never looks up a public profile by email or creates a second Auth user manually. Manual linking does not need to be enabled. [Supabase identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)

`xelay_google_registration_status()` returns `{ "required": boolean }`. Pending users see the existing complete registration form with their verified Google email locked. It asks for account type, name, username (or generated unique handle), academic affiliation, student course/program or teacher department, country, and explicit current privacy consent. It does not request another password or email confirmation.

`xelay_complete_google_registration(p_profile, p_policy_version, p_consent_version, p_consent)` returns `{ "completed": true }`. The profile contains `expected_user_id`, which must match `auth.uid()`. All academic fields and username are validated by the server; existing profiles are preserved; retries are idempotent. The server records consent with its clock and can create a pending teacher request. Neither editable metadata nor the account-type selector grants verified-teacher or administrator rights.

The global gate fails closed on an unavailable registration check and offers retry/sign-out. User changes invalidate in-flight profile/status responses. A completion timeout does not trigger automatic replay; a deliberate retry uses the same idempotent server operation.

## Readiness review

Before enabling the flag, review: existing email/password account with the same verified Google email; new student; new teacher with pending verification only; consent refusal and version changes; cancellation; missing/expired verifier; replayed code; another active account; denied profile/status request; restart during pending registration; email signup/confirmation/recovery; administrator MFA after OAuth. No live completion should be reported as verified until an authorized end-to-end check has been performed.
