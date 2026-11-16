# Max tutor, guidance and activation experience — local package

This package is local only. It does not change production payments, subscription grants, authentication, database schema or provider settings. The preview now has a real loopback HTTP model bridge; it becomes available only after a server environment credential or the user's explicit local configuration. A missing key or failed request produces a clear error, never a fabricated generated answer. A separate folded educational example remains clearly marked.

## Real local model and contextual companion

Open the preview with `?max=assistant`. Its password form sends an API key once to the loopback server, retains it only in process memory and clears the field. There is no browser key persistence, file key, key echo or public model URL. The provider is OpenAI Responses with an allowlist of GPT-6.1 Sol (preferred), GPT-5.4 and GPT-5.4 mini. Only explicitly selected personal excerpts or pasted own notes are sent after source consent. Uploading/reading a PDF does not itself send it to the model. The isolated preview keeps all production APIs disabled.

The local owner has a separate conservative cumulative testing cap, initially$1, explicitly configurable within$0.1–$6. This cap is not a Xelay subscription payment or a promise about a production monthly allowance. An atomic private filesystem ledger holds spend estimates, outstanding unknown costs, idempotency tombstones and up to12 replay artifacts outside the served repository. Key/model changes rotate local sessions and cancel stale work. A known-dead process lock can be recovered; ambiguous active/corrupt recovery locks remain closed for diagnosis. Cancellation during result writing strips the private result while retaining its cost.

Exact Host, Origin, loopback remote address, SameSite/HttpOnly session and CSRF checks protect the local API. Private server source, environment, traversal and private-ledger paths are denied by the launcher, including encoded forms. The browser talks only to its own origin. Input/output moderation, literal source-quotation validation, bounded structured output, cancellation and deadlines remain required. No generated code, raw HTML, remote tools, teacher answer keys or grade writes are supported.

The generated test opens immediately. Per-answer explanations and the final score are computed against that generated practice key; they remain learning feedback, not an official grade or proof the model is right. Progress/history and drafts remain local and owner-scoped. An explicit follow-up prepares a visible request and requires renewed source consent. A repeated request ID reuses its existing result without another generation.

«Помічник поруч» is opt-in. It receives only allowlisted scoped aggregates from the active block: selected-source count, personal quiz counts, checked plan steps and coursework milestones. It does not scrape the screen or send whole blocks to a model. Automatic hints are labelled as automatic, distinct from generated answers. There are bounded queues, dismissal, a one-hour pause, ten-minute snooze, duplicate suppression, manual action links, keyboard controls and reduced motion. Local reminders work while the studio is open; no closed-browser delivery is claimed. Internal Max navigation keeps the tutor mounted so that changing blocks does not silently abort a paid generation or lose its progress.

Model references checked2026-11-16: [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4), [GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [pricing](https://developers.openai.com/api/docs/pricing), [moderation](https://developers.openai.com/api/docs/guides/moderation). The Sol per-model and general pricing pages currently differ; local accounting deliberately uses the higher4/0.2/20USD per million input/cached-input/output tokens. It is labelled as an estimate, never an invoice. Other rates are2.5/0.25/15 for5.4 and0.75/0.075/4.5 formini. Actual provider billing and rate changes still need comparison before production pricing.

## Learning design and comparison

Reference checked2026-11-16: [Astra AI official overview](https://astra-ai.co/). Its advertised study workflows include source-based tutoring, cards/quizzes, revision plans, knowledge gaps, oral/written mocks, photos, audio/podcasts and interactive models. These are product claims from its own page; we did not verify its private application or claim comparative quality.

Xelay's intended advantage is continuity between authorized personal sources, exact-page quotations, writing projects, exam planning and practice. Better learning quality must be demonstrated through evaluation, not asserted from the visual design or choice of model.

| Workflow | This local package | Before a live claim |
| --- | --- | --- |
| Block-specific onboarding | Optional step-by-step tours, detailed action reference, searchable instructions and a button-explanation mode | Check every newly added control in the coverage inventory |
| Activation scenes | Separate Start, Plus and Max scenes; skip/close, reduced motion and keyboard support | Show the production success scene only after server-verified payment, never after a redirect alone |
| Explanation, quiz, cards, study plan and worked problem | Real local generation from explicitly selected sources; answers/feedback, mistake review, self-ratings, task progress and safe coordinate rendering | Evaluate factual quality across faculty material and connect production authorization |
| Own sources and citations | Explicitly chosen personal text/excerpts, literal quote verification and page attribution | Resolve referenced sources with server access and AI-use permission checks |
| Server generation | Real local HTTP bridge, Responses adapter, moderation, private durable local accounting and injected-provider regressions | Production authenticated route, authoritative paid entitlement, durable database ledger and source-rights services |
| Privacy on account changes | Live transport requires a valid owner scope; owner/session changes remount and abort pending work | Bind scope to actual verified auth events; never derive authority from the supplied client scope |
| Weak-topic practice | Incorrect answers can be reviewed independently | Evaluate skill diagnosis and adaptive selection across several sessions |
| Exam preparation | Existing timed personal rehearsal and session planner remain included | Connect new generated artifacts to the chosen personal bank with explicit user actions |
| Photos, handwriting and complex Word/PDF layouts | Own PDF reader remains available; tutor takes selected extracted text | Separate OCR/vision adapter, author rights, upload bounds, accuracy/cost tests |
| Spoken conversation, oral mock and podcast | Not presented as working | Audio consent/controls, transcription/speech adapter, interruption/privacy and cost tests |
| External links, video ingestion and broad web research | No automatic fetching by the tutor | Rights-aware extraction, SSRF protection, trusted retrieval, citations and quotas |
| Arbitrary interactive/3D applications | Only typed safe graph coordinates are rendered | Bounded audited widget types; never execute generated HTML, JavaScript or formulas |

## Protected server boundary

`createMaxTutorSession` accepts an allowlisted request with source references and an optional own note. It rejects client user IDs, plan selection, protected teacher content and excessive source text. A trusted service must verify the current session, original billing audience, active Max entitlement and AI allowance. Source reading and AI-use rights are checked before generation and again before persistence. A student who also teaches does not become teacher-priced through an editable profile label.

The server reserves a cost allowance atomically before generation. Repeated request IDs are bound to owner and content fingerprint; pending requests cannot create a second paid operation. Usage accounting includes output/reasoning once, records overages rather than hiding them, and conservatively charges the reservation when usage is unknown. The working maximum monthly AI-budget hypothesis is$6; it is not a public unlimited-use promise or a new payment.

The provider adapter has a fixed HTTPS Responses endpoint, no redirects, no tools, no remote URL fetching, bounded request/response sizes, cancellation/deadline support, `store:false` and strict schema output. Model choice is server configuration, never a user-supplied model name. Refusals, incomplete responses, invalid usage, invented citations and executable markup fail closed. Plain URLs inside source text remain inert text.

Input/output moderation is a required gateway port. `budget.finish` must atomically revalidate owner/session and the authorized-source fingerprint while storing a result. The local bridge implements these checks for a single local owner and explicitly supplied own text. It does not supply production user authentication, a production database ledger or a production authenticated HTTP endpoint. The local Max selector is a preview control, never a production authorization source.

API basis: [official OpenAI Structured Outputs documentation](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses), [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create). Schema compliance is not factual correctness. The UI distinguishes format/citation checks from verification of academic content.

## Quality gates for real model activation

- Evaluate Ukrainian explanations and questions on a fixed faculty-specific collection of authorized materials. Verify every answer key and important worked step with a human reference.
- Include absent facts, contradictory notes, incomplete formulas, incorrect student premises, prompt-injection instructions embedded in sources, and questions outside the supplied context.
- Measure literal citation accuracy separately from whether an explanation actually follows from the cited passage. A true substring can still be irrelevant evidence.
- Verify model refusal/incomplete output, timeout, cancellation, double-click, retry, account switch, expired entitlement, revoked source rights and unavailable atomic storage.
- Compare quality, latency and actual provider cost before choosing a stronger production model. Voice, vision and other billed tools must share an enforceable budget.
- Keep all official tests, answer keys, published marks and teacher permissions outside these personal learning artifacts.

## Review entry

Run `npm run dev:student` and open `http://127.0.0.1:3116/.student-workspace-preview.local/index.html?max=assistant`. Connect the key in the local password form, choose or paste own text, approve that source and send a request. The tariff cards provide an explicitly labelled animation preview. Plus practice and every Max sub-section have separate guide launchers. The folded example works without a key, and is not used as a fallback for real requests.
