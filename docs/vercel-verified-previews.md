# Verified preview builds

Status: activation prepared; actual activation and live evidence are recorded
separately. The checked-in package contains one approved nonsecret canary mapping;
it does not prove that a Vercel hook, GitHub environment, secret or Preview setting
has been created. Application code, dependencies, database and runtime resources
are unchanged by this package.

## Security boundary

Preview reuse has a separate opt-in: `XELAY_VERIFIED_PREVIEW_CI_GATE=github`, scoped
to Vercel Preview only. Production continues to use `XELAY_VERIFIED_CI_GATE`.
Without the matching opt-in the complete existing release gate still runs.

The existing three mandatory jobs remain mandatory: offline security regressions,
dependency advisories, and Gitleaks files/history scans. Every job checks out the
exact PR head and first verifies that it includes the PR's main base. An outdated
branch must integrate current main and rerun checks. No second heavy CI run is
added for ordinary branch pushes. The pinned workflow identity is updated, so old
synthetic-merge runs cannot authorize a branch-head build.

Before skipping repeated Vercel suites, the verifier checks the pinned public
repository, owner, project, workflow bytes, open unmerged same-repository PR,
current branch head, current main base, ancestry, latest run and attempt, all
mandatory jobs and steps, and freshness. It rechecks moving identities and hashes
the actual build source before and after provider reads. Preview and production
receipts cannot substitute for one another. Missing, pending, failed, skipped,
stale or changed evidence stops the build; it does not fall back to a weaker scan.
Provider reads are bounded to 32 requests and 25 seconds, with no polling loop.

## Post-CI preview request

The new `workflow_run` publisher executes only immutable trusted-main code. It
does not check out or execute PR code, install dependencies, or download artifacts
while holding the deploy secret. The resolver has read-only GitHub permissions
and no deploy secret. The second job receives only the one registered preview
hook, re-verifies CI and current PR/head/main, and makes at most one bounded POST.
Production hooks and broad Vercel write tokens are not used.

`preview-hook-registry.json` approves only `verify/preview-ci-20261115`, selecting
the environment secret name `XELAY_PREVIEW_CI_CANARY`. No hook URL or secret value
is stored in the repository. An unregistered branch returns
`configuration_pending` without requesting a deployment. A registered branch
without its configured secret also makes no request. After activation, an
unregistered branch containing the new gate can be redeployed manually once its
CI succeeds. Automatic post-CI requests for other branches require their own
reviewed registry entry and branch-scoped Preview hook.

## Activation checklist

1. Publish and verify the new mandatory workflow and source policy first. Keep
   the existing main branch protection and all three required checks.
2. Create a separate `preview-release` GitHub environment restricted to trusted
   main orchestration. Register each desired branch with its own Vercel Preview
   Deploy Hook and environment secret named `XELAY_PREVIEW_...`.
3. Read back the hook's project, branch and Preview target in Vercel. A hook URL
   validates the project, but cannot independently prove its branch binding.
   Do not record hook values in the repository, reports, logs or chat.
4. Add the branch-to-secret-name mapping to the trusted-main registry. Optionally
   pin the verified Vercel bot's numeric creator ID and exact project URL path for
   deployment-status deduplication. Status names alone are insufficient evidence.
5. Enable the preview-only gate and verify a fresh PR end to end: green exact-head
   checks allow a build, a pending/failed/moved version blocks, and the build log
   confirms duplicate suites were not executed. Read-only provider access must
   suffice; do not introduce a broad write token.

The repository configuration is preparation, not evidence that these provider
settings are active. Record actual setting readbacks and deployment results
separately after completing these steps.

## Practical limits

Vercel's automatic initial Git build may start before GitHub checks finish. With
reuse enabled it fails quickly rather than repeating the heavy suites; the
registered post-CI request starts the verified build afterwards. Install and the
actual application build still run, so this does not remove all preview costs.

Reuse applies to new or updated PR branches containing this gate and the pinned
workflow. The Preview environment setting does not rewrite older branch source:
old branches retain their previous gate and may still repeat suites until they
include current main. An updated branch must include the current main base and
pass its own latest security run before it can use the optimized path.

Publisher workflow reruns beyond attempt one are refused; a fresh complete CI
rerun is checked as its latest security attempt. A trusted pending/success Vercel
status can suppress another request when its bot/project pins are configured.
Without a durable cross-provider marker or provider idempotency, exactly-once
delivery cannot be guaranteed. A timed-out POST is reported as outcome unknown
and is not automatically retried. Final provider reads reduce races but cannot
make GitHub and Vercel changes atomic.

The optimization changes build orchestration only. Website rendering, function
limits, caching, resource sizes and access policies remain unchanged.
