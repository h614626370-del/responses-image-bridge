# Verification Record

Date: 2026-09-17. Runtime: Node.js 24.0.0 on Windows.

## Automated Tests

`node --test`: 31 passed, 0 failed (updated 2026-09-17).

- Responses rewriting, image tool preservation, early SSE comment heartbeats,
  stable response/item IDs and ordered terminal events.
- 30 simultaneous mock clients, bounded upstream concurrency and no retry.
- Authentication, non-stream clients, failure/incomplete propagation, missing
  images, unexpected SSE, body/result size limits, queue overflow and deadlines.
- Client disconnection, queued cancellation and direct connections despite obsolete proxy configuration.
- Independent management sessions, CSRF checks, login throttling and body limits.
- Encrypted credentials, masked settings, restart restoration, atomic validation,
  runtime config snapshots and concurrency updates.
- Pause/cancel, history export/search and absence of image/prompt/client key data
  in persisted request metadata.
- Mock sub2api read-only GET requests, x-api-key authentication and field filtering.
- Base64 image-to-image multipart edits, client key forwarding, one-image Responses
  replay, strict rejection of unsupported inputs, text-only fallback, no retry.
- Twelve-hour metadata retention, pruning and phase timeline without original
  prompts, images or credentials.

## Browser Checks

Playwright Chromium at 1440 x 960 and 390 x 844:

- Wrong-password feedback, login, logout and protected session behavior.
- Empty request monitor, status metrics, refresh and export download.
- Model settings save and restore to gpt-5.6-luna.
- Pause and resume, including confirmation.
- Missing sub2api administrator key feedback.
- Mobile monitoring/settings layout: no document-level horizontal overflow.
- Desktop and mobile screenshots visually reviewed.
- Isolated browser-only fixtures: populated requests, detail modal, usage lookup,
  request cancellation and completed-status filtering.
- Direct-edit setting toggled and restored, recent log auto-polled after a local
  validation failure, route filter/detail checked, mobile request-ID detail opened.
- No page JavaScript errors observed in the primary desktop session.

Screenshots in ignored `output/admin-*.png`; fixtures were not persisted as real
request history and did not contact a paid image endpoint.

## Still Unverified

- Actual Beixiong client parsing, image deduplication and heartbeat timeout behavior.
- Real kkflow image edit via the new direct route; prior Responses smoke ended in
  upstream HTTP 504 without an image.
- Live sub2api admin connection and request-ID correlation with actual usage.
- Docker build/runtime and public HTTPS deployment.
- Production-scale memory pressure, sustained load and process recovery.

No claim of full Beixiong compatibility or guaranteed upstream reliability.
