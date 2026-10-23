# Saved timetable and homework

Local implementation only; nothing has been deployed. The feature does not
require database migrations, server permission changes or mobile-store publication.

## Student experience

Opening an accepted study group while online starts a bounded download of the
next 14 Kyiv calendar days. The group panel also has an explicit refresh button,
the saved timestamp, and a separate app-shell readiness indicator. The standalone
`/offline` view opens saved lessons, full group homework, published teacher
assignments, active long-term homework and the group's timetable photo. It does
not mount the normal authentication/profile/admin flow.

Homework files and external Drive/YouTube links are not downloaded. Only safe
resource labels and filenames are retained to explain what requires a connection.
There are no submission, grade, booking or schedule-write controls in the saved
view. All shown information is explicitly the last saved copy, not live data.

## Storage and access

- Snapshots expire after 14 days, with at most 10 groups and 3 MiB per group.
- Only an authenticated normal user can capture data, using existing membership
  checks and user-scoped queries; membership is rechecked after capture.
- An allowlisted DTO excludes roles, tokens, grades, student work and signed URLs.
- Timetable images are downloaded through existing authorized access, bounded,
  decoded and reduced to a raster preview. Signed URLs are never persisted.
- A per-owner storage receipt and session generation reject delayed writes after
  logout or account switch. Confirmed access denial removes the relevant group.
- Logout creates a durable deny marker before physical IndexedDB deletion; other
  tabs react to the marker. Ambiguous failed initial-session refresh does not
  delete downloads. A later successful login reconciles and rotates blocked state.
- Users can remove a group copy from the saved view. Browser storage eviction or
  manual site-data removal can also remove downloads.

## Public app shell

The existing notification worker also handles versioned public application code.
It never caches API/auth requests, callbacks, private images or student data.
Future production builds emit a release manifest with SHA256 integrity checks.
An incomplete install cannot replace the previous working release. Security
headers are retained in offline HTML, and old code needed by open pages is pinned.
An available update requires an explicit action before activation and page reload.

If an approved group/home navigation fails, the worker opens `/offline`, including
when Wi-Fi stays connected but the external connection fails. The saved reader
does not mistake a locally stored receipt for server authorization.

## Local demonstration

Run `node scripts/preview-offline-study.mjs --port 3043`. This launches Vite only;
it does not run a production build. Open:

`http://127.0.0.1:3043/.offline-study-preview.local/index.html`

The preview uses clearly labelled fictional data on this separate local origin
and a nonworking placeholder backend. It does not connect to real Xelay groups.
Choose **Підготувати офлайн-перегляд** to preserve the loaded local module graph,
then **Відкрити збережене**. This explicit development facility is loopback/DEV
only. Production uses the complete versioned release manifest instead.

Cold opening after stopping the local server demonstrates the saved reader and
device storage. It does not substitute for release checks on real Android/iPhone
devices or validation of the future production asset manifest.

## Local review receipt (23 October 2026)

- TypeScript no-emit check and whitespace diff check passed.
- Prepared the fictional snapshot on port 3043, stopped Vite, then navigated to
  `/offline` as a new document. The reader booted from the saved app shell.
- Switched dates and read complete group homework and a teacher assignment with
  the local server stopped. No production group data was modified.
- Restarted the local preview for review. No production build or automated test
  suite was run; real-device and release-manifest checks remain before release.
