# Local performance checks

Run `node --test scripts/performance/home-feed.test.mjs scripts/security/header-notification-refresh.test.mjs` for refresh, cancellation, race, counter, and image-preview checks.

Run `node scripts/performance/preview.mjs --port 3004`, then open `http://127.0.0.1:3004/` for browser checks of the real App, Header, HomePage, QuestionCard, and routes.

This preview replaces the Supabase module with an in-memory fixture and intercepts `/api/*`. It has no production database or API access. The ordinary Vite build never imports these fixtures. The server binds only to the loopback interface.

Use the controls above the app to inspect request counts, simulate external changes, hide/resume the tab, disable Realtime, inject errors or a hanging request, and change the local account. Reloading resets all fixture data. Counts include independent application providers; they are not a measure of overlapping feed requests.

Browser checks before publication:

- Idle feed makes no five-second refreshes; images are queried only for displayed IDs.
- An event burst produces one debounced refresh.
- Publish a question with a photo; check one card, loaded photo, cleared form, and correct count.
- Cancel deletion, then delete an owned question; refresh and check it stays removed.
- Expand/collapse a long question and navigate to its detail page.
- Refresh with a draft; text and selected category stay intact.
- Simulate photo/question/transport errors; existing cards and photos stay visible and retry recovers.
- Hide the tab, create an external question, then resume; no hidden reads and missed changes appear on return.
- Create a notification, open the panel, and check the unread dot clears even with Realtime disabled.
- Change accounts during a slow request; old callbacks must not restore the old unread badge or ownership controls.
- Simulate a hanging read; refresh must settle with a retryable error after its timeout.
- Check mobile layout, image dimensions, and lazy-loaded route entry points.
