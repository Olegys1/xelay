# Verified previews for all branches

This package replaces the per-branch hook registry with a trusted-main publisher
for every same-repository working branch, including new branches without a PR.
Application code, dependencies, database and runtime resources are unchanged.
Activation and actual provider evidence must be recorded separately: checked-in
code alone is not proof that the credential exists or a live build succeeded.

## Mandatory security and exact source

Security checks runs on every branch push. It is the sole source of required
security-core, security-dependencies and security-secrets contexts. Same-repository
PRs use that exact-HEAD push evidence; a second PR-triggered copy is not started.
Cancelling a duplicate on the same SHA can itself block GitHub's required checks,
so removing the duplicate trigger is essential. None of the required jobs is
skipped to manufacture a green result. Manual and scheduled runs are separate.

Fork PRs retain separate secret-free checks in security-forks.yml with distinct
fork-security-* job names. They cannot replace the required own-repository push
proof or authorize Preview. Publication of fork changes requires an own-repository
working branch and the complete mandatory push checks.

The three required jobs remain security-core, security-dependencies and
security-secrets. Each checks out the exact source HEAD and verifies integration
with main. The existing core regressions, dependency audit and full-history
Gitleaks checks remain. The optional manual full-suite job is not mandatory and
must not be reported as run during ordinary CI.

Preview has its own opt-in XELAY_VERIFIED_PREVIEW_CI_GATE=github. Production
continues to use XELAY_VERIFIED_CI_GATE. Without the matching opt-in, the existing
complete gate runs. With it, missing, pending, failed, cancelled, skipped, stale,
wrong-workflow or changed evidence stops the build instead of repeating suites.

The branch verifier checks pinned repository/owner/workflow IDs and workflow
bytes, exact current branch SHA, current main as ancestor, latest push run,
its latest attempt, every mandatory job and step, and freshness.
It rechecks moving references and evidence; the actual Vercel source is hashed
before and after these reads. A PR hint is diagnostic, not authorization. No PR
or registry entry is required. The new branch-head-ci receipt cannot be confused
with old PR-only or Production receipts. Reads are bounded to 32 requests and
25 seconds, without polling.

GitHub can expose different update times for a run and its attempt. Each resource
is therefore read twice and must remain stable against its own first snapshot;
their source, run/attempt IDs, creation/start times and successful checks still
have to match. No timestamp tolerance or weakened job proof is used. The later
stable completion timestamp is used for deployment deduplication.

## Automatic post-CI request

deploy-preview-verified.yml runs only immutable main code. Both jobs check out
github.sha from the trusted workflow_run context; neither executes branch code,
installs dependencies nor downloads artifacts. The resolver has read-only GitHub
permissions and no Vercel credential. Only the final step in the protected
main-only preview-release environment receives XELAY_PREVIEW_PROJECT_TOKEN.

The publisher validates the event, repeats exact CI proof, reads authenticated
deployment history and rechecks CI and main/HEAD immediately before one bounded
POST to the fixed Vercel deployments endpoint. The request contains only the
pinned Xelay project and exact GitHub repository ID, branch and SHA. Omitting
target requests Preview. Production target, project settings, files, environment
overrides and latest-commit substitution are never sent. The response must prove
the same project, Preview target and exact source; reduced receipts are resolved
only by a validated deployment ID. Credentials and hook values never enter logs,
repository content, branch CI or the Vercel build environment.

An existing matching READY deployment suppresses another request. An active
deployment suppresses it only if created after CI completed: an early Git build
may have already observed pending CI. A failed post-CI deployment requires a fresh
security event. Pagination, bodies, reads and total execution have finite bounds.
An uncertain POST is reported as unknown and is not automatically retried.
GitHub and Vercel cannot be made atomic; these checks reduce races but do not
claim unconditional exactly-once delivery.

## Activation

1. Publish this workflow/policy only after all three required checks succeed.
   Preserve required-check protection on main and the existing Production path.
2. Use a Vercel token scoped to the single Xelay project, never All Projects,
   a whole team or Full Account. Verify the selected scope in Vercel: the vcp_
   prefix alone proves no scope. The provider grants project-wide read/write,
   not deployment-only access, so creating this credential requires explicit
   action-time approval. Give it a finite expiry and document the date.
3. Save it only as XELAY_PREVIEW_PROJECT_TOKEN in the existing main-only
   preview-release GitHub environment. Do not add it to repository-wide secrets,
   Preview application variables, files or reports. Retained old hook scripts and
   registry are dormant compatibility fixtures, not the active publisher.
4. Integrate main into working branches without discarding their work, then let
   their own complete CI run. New branches created from current main need no
   registration. Historical branch source is not rewritten by a Vercel flag.
5. Verify a new unregistered branch without PR and a same-repository PR: pending
   CI blocks the early build; successful checks automatically create a Ready
   Preview; logs confirm no repeated suites. Record exact source/run/deployment
   identities and inspect that the source proof remains enforced.

The first Git-triggered Vercel build can start before CI and stop quickly. Install
and the application build still run on the verified follow-up; this removes
repeat security suites, not all build cost. Expired credentials, provider
outages or exhausted API limits stop automation visibly. No site rendering,
function limits, caching, machine size or student/teacher permissions are changed.
