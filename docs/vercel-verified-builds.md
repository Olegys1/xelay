# Verified production builds

This package removes repeated security execution from an explicitly activated
production path. It does not remove any security suite, audit, Gitleaks scan,
offline guard, per-suite deadline, dependency lock or production runtime setting.

## Default and activation boundary

The default `release-gate.mjs` path still runs secrets, dependency audit and the
complete core suite. Preview and local builds retain that path. An arbitrary
`SKIP_SECURITY` or `XELAY_SECURITY_CI_BUILD` value has no authority.

`XELAY_VERIFIED_CI_GATE=github` selects a separate production verifier. The value
alone never allows a build. In this mode a production source build is rejected
unless all of the following are proven:

- Vercel's project, Git provider, owner, repository and main-branch identity match
  the pinned Xelay project and repository.
- The actual checkout HEAD equals the complete Vercel commit SHA. Commit and
  tree objects are hashed, then regular build inputs are compared with their
  committed blob hashes before and after provider reads. Index flags, Git
  replacements, ignored dotenv files and extra public assets cannot stand in
  for a matching source tree. Symlinks and unknown inputs fail closed; only the
  exact root dependency, output and local-report directories are excluded.
- GitHub's current main ref equals this SHA, the trusted security workflow file
  has its reviewed blob hash, and the latest push-to-main run and attempt belong
  to that same repository, workflow and SHA.
- The workflow and all three mandatory jobs completed with `success`; their
  required install/scan/audit/test steps also completed successfully. Missing,
  duplicated, skipped, failed, stale or future-dated evidence is rejected.
- All GitHub responses are complete, bounded and obtained from the fixed HTTPS
  GitHub API without redirects. Provider error bodies and credentials are never
  printed. A read-only token is optional for rate-limit reliability because the
  current repository is public; it is not an alternative proof.

Failure in this production mode exits promptly. It never changes to a weaker
local scan, reuses a PR merge check for another commit, or polls GitHub while a
paid Vercel machine waits. The existing working deployment remains in place.

Hosted Vite builds create `.vercel/project.json` and a static-build diagnostics
manifest before the application build. These are validated metadata, not an
ignored directory: project identity and all four build settings must match the
pinned project and hash-verified `vercel.json`. The static-build directory may
only be empty or contain the closed-schema `package-manifest.json` written by
Vercel. Metadata is bounded, read without following links and included in the
source receipt with a final stability check. Tracked `.vercel` paths, extra
files, dotenv files, output payloads, caches and builder dependencies are refused.

An optional `XELAY_SOURCE_PROOF_DIAGNOSTIC=1` probe runs only in Vercel preview.
It reports bounded structural metadata and fixed comparisons without values;
both success and refusal are always followed by the complete preview gate.
It grants no production permission. Release refusals print only allowlisted
internal codes; uncertain hook requests still never retry automatically.

## Start the build after CI

`deploy-verified.yml` listens to completed `Security checks` runs. Its job rejects
PRs, forks, foreign repositories and non-main/non-push runs before checking out
source. Checkout uses the exact tested SHA and does not persist credentials.
There is no package installation or artifact download in this publisher job.

The publisher revalidates the same CI evidence and current main before making
one request to the scoped Xelay Deploy Hook. Its hook credential is available
only to this publisher step, not to PRs or security tests. An absent hook is
reported as `configuration_pending` and sends nothing. A hook response means
only that a build was requested; it is not a publication receipt. If the POST was
attempted but its response is lost or invalid, the result is
`request_outcome_unknown`, not a claim that nothing was requested. It never
automatically retries that ambiguous request.

The hook builds main. If main moves in a race, the Vercel verifier checks the
actual newly selected SHA and will reject it until its own checks are green.

## Future production activation — not performed by local development

1. Review the local tests and the exact security workflow pin. Keep the current
   source gate enabled during the transition.
2. In the `production-release` GitHub environment, configure
   `XELAY_VERIFIED_DEPLOY_HOOK`, scoped to this Vercel project and main. Review environment protection
   and who can rerun the publisher. Do not add a broad Vercel account token.
3. Publish the reviewed package with the default full gate still active. Verify
   the publisher requests a build only after the exact main commit's security
   run succeeds. No hook URL should enter a report, source file or console log.
4. Only after that canary, set `XELAY_VERIFIED_CI_GATE=github` for Vercel production
   only. A least-privilege token with GitHub Actions read and Contents read may be added for reliability
   if anonymous rate limits are insufficient; never expose it to preview builds.
5. Verify actual deployment refusals for pending/failed/skipped checks and a
   mismatched SHA, then verify a successful exact-SHA deployment and the public
   platform. Local mock tests cannot prove live provider behavior or resource
   savings. Compare CPU minutes over comparable deployments after activation.

No live setting, secret, hook or deployment is created by these files. Ordinary
source builds are covered; an owner using a prebuilt upload, an overridden build
command, force promotion or an instant rollback is outside a source build
script's authority, just as it was with the old source gate. A future independent
Vercel deployment policy can add defense against alternate publication routes.

## Rollback

Remove the production mode setting or set it to `full` to restore the original
complete gate. Do not disable security jobs, turn off the monitor, reduce build
resources, restrict concurrent users or change application cache behavior.
The optimized path fails closed on GitHub outages/rate limits, which can delay
new releases but does not alter the already served site.
