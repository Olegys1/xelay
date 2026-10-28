# Security change checks and release gate

This is a local implementation prepared for review. Creating these files does not enable GitHub Actions, change repository settings, modify Vercel, install a monitor, send a Telegram message, or deploy anything.

## Commands

Use Node 24 and the dependencies already installed from this repository's lockfile. No command below installs packages.

```sh
node scripts/security-ci/run.mjs --core --list
node scripts/security-ci/run.mjs --core
node scripts/security-ci/scan-secrets.mjs --offline
node scripts/security-ci/audit.mjs
node scripts/security-ci/release-gate.mjs
```

The audit is the only command in this list that contacts a service: npm's public advisory registry at `https://registry.npmjs.org/`. It uses `npm audit --package-lock-only --ignore-scripts`, with an isolated package root, empty user/global npm configuration, no provider credentials, no proxy configuration, and no package lifecycle scripts. It includes runtime and development dependencies. High/critical findings and unavailable/malformed audit responses fail the check; moderate/low counts remain visible. An audit cannot detect vulnerabilities absent from the advisory database or guarantee safety of a third-party tarball.

For the larger optional check:

```sh
node scripts/security-ci/run.mjs --full --list
node scripts/security-ci/run.mjs --full --build
```

Full mode includes an explicit isolated production build because two historical suites inspect `dist/index.html`. It then runs every direct `scripts/security/*.test.mjs` file in the selected inventory, one at a time. It is intentionally not the default on this busy development machine. Core mode covers synthetic Auth/OAuth sessions, registration denial, administrator MFA, PostgreSQL RLS/message and storage boundaries, quotas, server authorization, payment API behavior, runner isolation, and the new monitor suites. These are useful regressions, not complete application, browser, Android/iOS, provider, or penetration coverage.

## Local isolation and file selection

The runner reads membership from `git ls-tree HEAD`, then copies current tracked files plus the explicit security-task additions in `policy.mjs` into a disposable snapshot. It does not discover arbitrary untracked tests, migrations, assistant work, artifacts, dotenv files, or service credentials. A tracked non-example dotenv file fails closed. Symlink inputs also fail closed. No Git metadata means failure, never a silent skipped check.

This checkout started with eight unrelated modified paths: `package.json`, `package-lock.json`, `vercel.json`, `src/App.tsx`, `tsconfig.json`, `api/groups/recognize-timetable.ts`, `ios/README.md`, and `src/components/teaching/LocalTeachingGradesPreview.tsx`. The local snapshot reads their HEAD contents, preserving those edits without validating or shipping them as part of this security task. This exception is an explicit list, not a dirty-file wildcard; a clean CI checkout naturally matches HEAD. To validate later intentional changes to these paths before committing, first reconcile this local exception rather than assuming this task's run tested those edits.

Test snapshots sit under the already-ignored `.security-ci.local/` directory so they can resolve existing `node_modules` without copying dependencies or creating privileged Windows junctions. Each test file gets its own Node process, a 768 MB JavaScript heap limit, a 150-second parent deadline, a 120-second test deadline, and a newly constructed environment. Provider tokens, deployment secrets, developer home, npm settings, `NODE_OPTIONS`, and proxies are not inherited. A preload guard rejects real HTTP/fetch/socket/DNS requests and subprocess execution before contact. This is accident prevention for trusted synthetic tests, not an operating-system sandbox for malicious code. The optional build permits installed esbuild subprocesses and has a separate 1,536 MB heap/180-second limit.

## Secret checks

The local offline preflight checks private-key headers, common provider-token formats, legacy Supabase service-role JWTs, credential-bearing database URLs, and long literal provider secrets. It reports file, line, and rule only; values are withheld. It has three exact, already-existing invalid test-literal exceptions and no directory/rule wildcard exclusions. Its detection is deliberately narrower than a maintained secret scanner.

The workflow adds the official, MIT-licensed Gitleaks CLI v8.30.1. Its Linux x64 archive is downloaded from the official release and checked against the pinned SHA256 **before** extraction. This uses the CLI directly and does not require a Gitleaks Action organization license or a new secret. `scan-secrets.mjs --gitleaks` requires the existing CLI on PATH and runs both the selected snapshot scan and fetched Git-history scan. It enables complete redaction and ignores inline `gitleaks:allow` comments. Raw scanner output is withheld; a failure remains a failure, with investigation done through a private local scan. The local machine has not downloaded or installed this scanner as part of preparation.

Sources for the immutable pins: [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1), [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0), [Gitleaks v8.30.1 assets/digests](https://github.com/gitleaks/gitleaks/releases/expanded_assets/v8.30.1), and [Gitleaks CLI usage](https://github.com/gitleaks/gitleaks/blob/v8.30.1/README.md).

## Workflow activation and cost controls

The prepared workflow runs core/dependency/secret checks on pull requests and pushes to `main`, without duplicate pushes to every feature branch. A weekly scheduled run checks dependencies and secrets; a manual dispatch can additionally run the full suite. Read-only `contents` permissions, non-persisted checkout credentials, immutable official-action commits, cancellation of superseded runs, job deadlines, and standard Ubuntu runners are specified. It does not use `pull_request_target`, provider secrets, automatic PR comments, external messages, paid scanning services, caches, or uploaded report artifacts. Dependabot configuration requests bounded weekly npm and GitHub Actions update PRs once activated; it does not merge them.

Private repository runner minutes have a plan-specific included allowance and can incur charges above it. Before any future push that activates this workflow, check the repository owner's current allowance and configure an Actions budget that stops paid usage at the intended limit (including $0 if required). No billing settings were changed here, and unlimited free execution is not promised. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) and [budgets and stopping usage](https://docs.github.com/en/billing/concepts/budgets-and-alerts).

## Checks versus a deployment gate

Passing or merely starting Actions does not itself stop Vercel from deploying a direct `main` push. Before activation, configure a protected production branch/ruleset that requires the observed `security-core`, `security-dependencies`, and `security-secrets` checks, disallows bypass/direct pushes and force pushes, and permits merging only the tested revision. Confirm the exact names in GitHub after the first run; the workflow is named `Security checks`. Those are repository settings, not effects of adding this YAML.

The proposed Vercel build command is:

```sh
node scripts/security-ci/release-gate.mjs && npm run build
```

The gate fails the build on offline secret findings, a failed/unavailable dependency audit, or a core regression. It does not replace the full Gitleaks required PR check, and it does not wait for Actions by polling. The production build starts only after the gate exits successfully. This task does not alter the pre-existing dirty `vercel.json`; the separate reviewable publish template must apply this command before a future authorized deployment. Confirm that Vercel's dashboard build-command override does not bypass it.

Vercel documents a depth-10 shallow Git clone for Git-triggered builds; HEAD metadata is sufficient for inventory membership. CLI uploads may omit `.git` and will therefore be rejected by this gate. Use a Git-connected build with metadata or a separately designed verified-manifest flow; never change metadata failure into success. See [Vercel build configuration](https://vercel.com/docs/builds/configure-a-build) and [build triggers and ignored files](https://vercel.com/docs/builds).

The gate covers tested code and known dependencies at build time. Runtime observation is a separate feature and requires a reviewed installation/configuration; this document does not establish that live threats are currently being monitored.

## Local validation on 2026-10-28

The initial curated run using existing dependencies passed **15/15 files, 139/139 Node-reported tests** in 21.4 seconds. Its original receipt remains at `artifacts/security-monitor-local/receipts/core-final.json`. Earlier validation correctly failed two stale Auth harnesses (13/15 files passed); their imports were repaired and four real OAuth/registration cases were added, preserving the original scenarios. Counts include parent tests and subtests as reported by Node.

The separate clean candidate installed its locked dependencies with lifecycle scripts disabled, leaving the root dependency installation and eight pre-existing modified files untouched. The final run with those actual new dependencies passed **15/15 files, 141/141 tests** sequentially in 23.67 seconds; two later monitor cases explain the increase from 139. One production build using the installed **Vite 8.1.6** completed with a 256 MiB heap and 796.7 MiB peak RSS below the 1,024 MiB cap. Free physical RAM was 2,399 MiB before the build and reached a sampled minimum of 1,638 MiB.

Post-build checks verified **32 offline asset hashes**, worker/shell agreement, public guide copies, absence of the private meeting plan and unrelated assistant/demo sources, all 31 frozen task inputs, and preservation of the eight unrelated root files. The updated toolchain emits `/assets/link.js` separately, increasing the prior offline count from 31 to 32 with no logical assets removed. The initial verifier's exact-31 assumption failed after compilation; that receipt was preserved and the existing output was verified without a second build. The full bundler API module list was not retained after the assertion; the final receipt records source-path and output checks instead. See `artifacts/security-monitor-local/receipts/candidate-install.json`, `candidate-core.json`, `candidate-production-build.json`, and `candidate-build-initial-count-check-fail.json`.

The clean HEAD dependency audit failed on **1 critical, 2 high, and 2 moderate** package findings. The candidate in `artifacts/security-monitor-local/dependency-fix/` changes only the direct Vite version and the affected transitive lockfile resolution; its registry audit passes with zero findings. The installed/tested/built candidate has not replaced the dirty root package files or been committed, pushed, or deployed. The gate therefore still rejects the current HEAD dependency baseline until the reviewed fix is adopted.

Full mode lists **155 files**; its additional 140 test files were not run. The prepared maintained Gitleaks CLI/history check was not executed locally, and no GitHub workflow, billing setting, production monitor, or runtime configuration was activated by these validations.
