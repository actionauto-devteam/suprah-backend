# Suprah notifications and Meet audit — November 12–14, 2026

Local implementation and verification across the frontend and backend repositories. This is not a deployment or a claim that every device or external integration has been tested.

## November 14 release review

The user subsequently authorized integrating both repositories on their existing `main` branches, deploying the fixes, and publishing the release in Updates. The earlier hold sections below are historical snapshots. Deployment and publication receipts are recorded separately after the release completes.

- Pulled 29 frontend and four backend commits before release. The notification drawer conflict retains the co-developers' account-specific destinations, staff-only inbox controls, and the accessibility changes. The later calendar-controller conflict preserves their new appointment-history imports and actor helper alongside the OAuth return/cookie changes. Customer/driver notification routing and staff-only Meet alerts are preserved.
- Local disconnection and leaving now differ from a server-ended meeting. Staff and guests can prepare their devices and rejoin a live room; the summary/distribution screen belongs to an ended room. A pending join no longer posts an empty attendee ID that could remove the same person's other device sessions.
- Concurrent attendee joins merge into the current persisted roster with admission revalidation and bounded optimistic retries. Failed commits release their newly issued media attendee. Host ending closes admission atomically before waiting for AWS cleanup; late joins cannot resurrect an ended or deleted room. Unrelated room settings and the latest participant history are retained.
- Guest passes remain scoped to their meeting and organization. An unauthenticated code collision across organizations is rejected rather than resolving to an arbitrary room. A non-unique code index supports this bounded lookup alongside the existing organization/code unique index.
- Google token-save errors are caught, provider list requests have a 15-second timeout, and temporary quota failures leave the calendar connected. Google's documented 403 quota responses are handled separately from insufficient permissions: [Google Calendar error handling](https://developers.google.com/workspace/calendar/api/guides/errors).
- Production preflight was read-only, with automatic index/schema creation disabled. All 66 existing `Daily Online Web Dev & CRM QA Sync` session IDs were recorded for retention checks. No production meeting cleanup was executed. The cleanup UI requires a reviewed selection and rechecks every eligibility condition at deletion time.
- Final backend production build and the frontend TypeScript check pass. The six isolated MongoDB integration suites pass all 31 tests, including ten concurrent attendees, separate device sessions, host ending, deleted/ended room protection, calendar persistence, cleanup protection, and linked notification delivery. The database tests cannot connect to production or send real provider messages.
- All 337 frontend Node tests and the SupraSpace regression script chain pass. Current-source browser fixtures pass desktop and phone host re-entry, late callback isolation, Mini Meet continuity, and selected cleanup checks. The notification/report/calendar fixtures pass phone portrait/landscape and desktop, light/dark rendering, drawer scrolling/focus/close controls, partial report retry, summary-only reports, and calendar defaults. These use mocked APIs/media rather than authenticated AWS calls.
- Changed frontend source has no added ESLint findings compared with integrated HEAD. Existing hook/service-worker lint debt remains; the global lint command is not claimed clean. No dependency manifests, lockfiles, environment files, or unrelated co-developer files were changed.
- Release content is versioned in `docs/releases/2026-11-14-meet-calendar-notifications.json`. Its publication follows verified backend and frontend deployments. Real-device push delivery, real meeting media, Google OAuth, and SMTP inbox delivery remain live acceptance checks described below.
- Current backups, test logs, isolated database, and release receipts: `C:\Users\Romswel\.codex\tmp\suprah-meet-release-20261113T205447Z\`.

### Local memory interruption

The final full unit run and Next production build overlapped and exhausted the workstation's available memory; the user reported a Windows crash. Neither repository had been pushed or deployed. The recovered work has no unresolved merges and has another file/patch backup. Heavy validation and release are held until sufficient RAM is available; later checks must run individually with a RAM preflight.

Before the interruption, the backend production build, separate frontend TypeScript check, frontend tests, database tests, and browser fixtures passed. The earlier complete backend unit run passed all 284 suites and 3,448 assertions but exited nonzero because existing Gmail/call test fixtures left notification work running after teardown. Those fixtures now mock the unrelated notification dependencies; a clean rerun remains required. The interrupted final Next build is not a passing build and remains required before release.

The remaining validation runs in the existing cloud build services. The backend workflow now requires the full unit suite and nine selected integration suites against a disposable MongoDB service before it can build/publish images or deploy. The test setup accepts only a credential-free loopback test URI, disables schedulers/Redis, blocks external sockets/fetch, and retains the existing production-database guard tests. The selected integration suites include the co-developers' new appointment-history and lead-store/composer checks. Production TypeScript is compiled by the existing Docker image build; a failed test or image build cannot reach the deploy job. Frontend compilation, typechecking and prerendering run in the existing Vercel production-build gate. Deployment receipts and public health checks must pass before the Updates post is published.

## November 14 earlier follow-up: host entry and unused schedules

- Confirmed a client-state defect matching the host report: the layout-owned Meet hook retained its previous `ended` phase and meeting after leaving the room. The next room required `idle` to show preparation or join, so the host could see an earlier call's summary while invitees could still enter the new server room.
- Completed and failed sessions now reset after leaving their own room. Opening another call waits for prior media/presence cleanup and preserves that call's device choices. Opening a different room does not reload CRM. An active call remains available through Mini Meet when navigating away.
- The provider identifies its exact room path. Moving directly from an ended room to another room releases the old session too. Old SDK callbacks, heartbeat responses, pending joins, recording/caption requests, and device operations are guarded against modifying a later call. Device teardown continues even if one camera cleanup operation fails.
- Added a reviewed cleanup dialog for unused native schedules titled exactly `Instant meeting`. It previews individual codes and dates, supports selection, and removes only the selected IDs. Staff can manage their own drafts; admins/managers can manage team drafts within their organization. The server rechecks title, status, ownership/tenant, participants, calendar linkage, and media/history at deletion time.
- `Daily Online Web Dev & CRM QA Sync` is excluded by that exact-title selector. Tests also attempt forged selections containing its ID and confirm it is kept, along with active calls, completed calls, recordings, calendar-linked rooms, and other organizations' records.
- No cleanup was executed on production records. All new work is combined with the prior held notification, calendar and Meet changes. No commit, push, deployment or production data mutation was performed.
- Current frontend base observed at the start of this follow-up: `a71f3885`; backend base: `5c812c9`. Existing work and the co-developer commits already present in the workspace were preserved. The November 12–13 base IDs and test evidence below describe the previous validation snapshot.
- Current verification: 183 tests across 21 focused backend suites passed; nine local MongoDB integration tests passed across calendar synchronization and cleanup. Actual room, hook, provider and cleanup components passed browser checks at 1440×900 and 390×844 with mocked APIs and Chime: host enters the next call, no old summary/reload, late SDK stop ignored, only selected cleanup IDs sent, and daily series preserved. This is not an authenticated AWS/Chime call test.
- All 302 frontend Node tests passed on the current integrated source. Mini Meet retains the active session while navigating to the lobby and returning on both desktop and phone widths. The new cleanup component, lobby, and revised session provider lint clean; the shared Meet hook retains its 11 pre-existing lint errors with no added findings in the comparison against HEAD.
- Both final production builds passed. The frontend passed compilation, TypeScript, page-data collection and prerendering; the separate TypeScript check passed too. The SupraSpace regression script chain also passed. No dependency manifests, lockfiles or environment files were changed for this follow-up. The follow-up test MongoDB used its own data directory on loopback port 27019 and was stopped after the tests; the user's existing MongoDB process was left alone.
- While the deployment is held, a full refresh of the affected room tab before retrying can clear this stale client state in the current live version. This does not reopen a meeting that has actually ended on the server.
- Follow-up backup, logs and browser evidence: `C:\Users\Romswel\.codex\tmp\suprah-host-rejoin-20261113T172122Z\`.

## Confirmed notification defects and changes

| Finding | Change |
| --- | --- |
| Reading a notification sent a silent Web Push dismissal. Safari requires visible notifications for delivered pushes and can revoke permission otherwise. | Read dismissals now use connected sockets and local notification dismissal. Old queued dismissal jobs are discarded before sending; the service worker safely displays legacy messages from older servers. |
| CRM delivery deleted subscriptions after five failures, including timeouts, rate limits, server errors, and configuration failures. | Only provider-confirmed 404/410 endpoints are deleted. Other failures retain subscriptions and record failure counts. |
| General push did not recover a missing browser subscription with permission already granted; CRM recovery ran mainly at mount. | Both paths recover on resume, reconnect, and periodic foreground checks. Concurrent hook instances share subscription creation. An explicit device opt-out persists and prevents automatic re-enabling. |
| Main-account registration removed its current endpoint before inserting it again. A failed request could leave it missing. | Registration updates the current endpoint in place and conditionally inserts only missing subscriptions. |
| Legacy push silently reported success without delivering when Redis was disabled. | It now uses direct delivery and reports transport failures. |
| General notifications did not immediately reconcile after socket reconnect. | Reconnection fetches current notification state. |
| Mobile notification exit controls could meet unsafe screen edges; text and preference controls were small. | The shared drawer now respects safe areas and dynamic viewport height, provides a 44px close target, preserves inner scrolling, and restores focus. Preference groups have readable text and accessible labels. |
| Arrival/tracker alerts were grouped too broadly. | Added independent arrival, geofence, offline, and place-visit controls. Existing idle-alert controls remain available. |

Push transports have bounded request timeouts. Service-worker renewal records successful verification only after authenticated registration requests succeed.

The latest co-developer notification work is retained: account filtering, socket rebinding, CRM conversation notifications, and linked main/CRM identity targeting. Cross-identity push deduplication now suppresses a second delivery only after the first provider request succeeds; transient failures remain retryable.

Apple's relevant requirements: [Sending web push notifications](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers) and [Web Push for iOS and iPadOS](https://webkit.org/blog/13878/).

## Calendar and Meet

- Creating a meeting in Suprah Calendar creates a private Suprah Meet room by default. The explicit opt-out is stored and respected.
- The room uses the calendar's owner and valid participants from the same organization. Calendar title, participants, rescheduling, cancellations, deletions, and bulk actions synchronize with pending rooms.
- Rescheduling an upcoming session retains its room code and resets reminders. Reusing an old calendar item for a later session preserves the earlier call and creates a new room.
- Daily-window meetings create separate sessions with Mountain time/DST handling and selected-date support. Recurring meeting spans are capped at 120 days.
- New calendar rooms use eight-digit codes so recurring imports do not exhaust the 9,000 four-digit codes used by manual meetings. Existing codes remain valid; pasted codes, invite links, and SupraSpace links recognize both formats.
- A calendar change is saved before its room is synchronized. A durable pending flag allows recovery after a room-write failure without returning a misleading failed-calendar-save response. The calendar editor displays pending synchronization.
- Upcoming legacy Suprah Calendar meetings without rooms are recovered when the Meet lobby loads. Failed recovery of one item does not hide the meeting list.
- Linked schedules are edited/cancelled in their owning calendar, with a calendar link in the Meet lobby. Live calls and recording history are preserved.
- Connected personal CRM Google calendars are checked periodically, including while the browser is closed. A serial bounded sweep processes up to 10 eligible accounts per minute with a soft 20-second budget; the target interval per account is five minutes, subject to backlog and provider availability. Failed accounts enter a cooldown so they cannot block the queue. A renewable database lease prevents manual/background and multi-process overlap for the same account.
- Google imports previously produced appointment records only. Owned timed meetings on the connected account's primary calendar now also materialize private Suprah rooms with matching active CRM participants, including events that already contain a Google Meet conference. Expanded recurring occurrences each receive their own Suprah session. All-day items, availability blocks, and meetings organized by someone else are excluded from room creation. Cancellations remove pending source rooms. One full sync upgrades accounts whose old tokens predate this integration.
- Google connect/sync controls are available in the Meet lobby. Reconnection preserves refresh tokens, uses expiring signed state bound to an HTTP-only cookie, and returns to the originating page.
- Pagination no longer silently truncates at five pages. Recurrence expansion remains enabled for incremental sync. Failed room synchronization does not advance the Google sync token.
- Incremental meeting edits also update rooms when their dates move outside the appointment import window. Bulk and Google imports defer invitations to the existing bounded notification worker.

Google's original events, conference links, external invitations, and attendees are not rewritten. A Suprah room is a separate call; creating a mirror does not move an existing Google Meet/Zoom call or its external guests into Suprah. Share the Suprah link with external participants when meeting in Suprah. Outbound creation of Google events from native Suprah Calendar schedules is not implemented by this change.

## Meeting report email

- Dedicated Meet SMTP remains supported, with the shared SMTP sender as a fallback. SMTP operations have timeouts and messages include plain text plus escaped HTML.
- A recipient is marked sent only after SMTP accepts it. This does not prove inbox delivery.
- Recipient addresses are normalized and deduplicated. Concurrent send requests have a persisted claim; partial retries skip recipients already accepted unless resend is explicit.
- The send claim returns the current recipient history atomically, so a stale pre-claim read cannot resend an already accepted recipient. Invalid multi-address rows are rejected. The report request allows time for bounded batches of SMTP sends.
- An all-failed attempt no longer records a misleading successful-send timestamp. Counts include successful recipients only.
- A ready summary can be sent without an available video. Sending waits while AI generation is in progress.
- Polling preserves recipient choices, including deselecting everyone. Errors and failed-recipient retries remain visible and usable.
- Report URLs use the configured app origin and bind tokens to the exact meeting and organization. Older code-only report links are accepted only when their recipient/code identify one stored report. Guest token requests use their organization scope. The hardcoded development signing fallback was removed while preserving configured legacy signing secrets.

## Reviewed without a newly reproduced defect

- Driver verification currently separates required and optional documents; submission guards use the required list. No automatic popup for missing optional documents was found in the current reviewed paths.
- The current driver assignment flow already persists a `driver_assigned` notification through its load lifecycle outbox. The meeting notes alone do not establish which historical version, account, or load missed delivery. Transport and reconnect fixes above help delivery; an authenticated assignment still needs a live check.
- Static notification fallback destinations were compared with current frontend pages and matched existing routes. Existing contextual SupraSpace, project-task, and driver-load routing was retained. A specific failing persisted notification is still needed to reproduce any remaining historical 404.
- Existing notification settings links already call the drawer close handler. Browser checks confirmed that the shared shell's Preferences action closes it.

## November 12–13 verification snapshot

- The final integrated frontend production build passed compilation, TypeScript, page-data collection, and prerendering. The separate TypeScript check (`tsc --noEmit`) also passed. The build used a 6 GB Node heap and `NEXT_PUBLIC_API_URL=https://api.suprah-app.com` only in the build process; environment files were not edited. These checks do not prove authenticated production behavior.
- The final integrated backend production TypeScript build passed with a 4 GB Node heap.
- The comprehensive backend unit run passed 281 suites and 3,419 tests. Following the final OAuth/input and out-of-window Google edit fixes, all 27 tests in four focused suites passed. The full unit run blocks non-local provider connections; no real mail or push was sent.
- Four integration suites passed 19 tests against a new isolated loopback MongoDB instance on port 27018. The calendar suite was rerun after the final code-range change: all four tests passed, including actual room persistence/rescheduling, concurrent creation, same-organization participants, cancellation/history retention, and database lease ownership. Existing linked-identity push and appointment notification integration suites also passed.
- All 278 frontend Node tests and the separate SupraSpace regression script chain passed. Three stale recording-access expectations were aligned with the co-developers' current permission policy; product recording permissions were preserved.
- ESLint comparison against the integrated HEAD found no new messages in changed source files. All changed files except `src/sw.ts` lint clean. That service worker has 35 existing `no-explicit-any` errors, reduced from 37 in HEAD; the broad lint command therefore still exits nonzero.
- Frontend dependencies were reinstalled from the current lockfile and direct installed versions matched it, including the co-developers' MapLibre worker version. Package manifests and lockfiles have no task changes.
- Browser fixtures compiled the actual current components and application CSS with mocked API data. Checks passed at 390×844, 844×390, and 1440×900: reachable close button, scrolling, Preferences dismissal, focus restoration, partial email retry, preserved deselection during polling, summary-only reporting, and calendar default selection. Light/dark screenshots were captured.
- Local browser evidence and scripts: `C:\Users\Romswel\.codex\tmp\suprah-notification-qa\`.
- Both repositories pass `git diff --check` with no unresolved merge entries. No production database migration, real email, push send, Google-account change, task commit, push, or deployment was performed during verification.

## Earlier local hold and integration handoff

- At this earlier snapshot, the user's instruction was to finish local scanning/fixes and hold all pushes and deployments until after the daily huddle. The fixes remained uncommitted on the existing `main` branches; no branch was created. The subsequent release authorization is recorded above.
- Reviewed frontend base: `4f1d12ab6c16dfdbc4b8ab32701f4e6dd81d67ca`. Reviewed backend base: `9a9c45d322fa099463ba6d78f486082907e93418`. These are the latest snapshots integrated during this work; co-developers may publish further changes afterward.
- Both rounds of co-developer integration used backups/stashes and fast-forward updates. The OAuth conflict preserves their HMAC state helper. Existing shipment-event filtering, mobile calendar filters, recording access policy, socket rebinding, and notification identity handling remain in place.
- Backups and verification logs: `C:\Users\Romswel\.codex\tmp\suprah-release-20261112T142934Z\`. Both repositories retain their named checkpoint stashes. Earlier unrelated package-lock edits are preserved there and in the checkpoints; they were not overlaid onto newer upstream dependency versions.
- A complete held-work snapshot is stored under `held-local-20261112T162220Z` in that backup directory (24 frontend and 30 backend changed files). The isolated MongoDB instance was stopped after verification; no test database service remains running.
- Before any later release, fetch and inspect both remotes again, integrate new commits without discarding these local changes, and rerun affected checks. These results validate the reviewed snapshots and do not establish the safety of future co-developer changes or a completed deployment.

## Remaining live verification

1. On a physical iPhone installed to the Home Screen, enable notifications once, close the app, send an authorized test notification, reopen the app, and repeat after a network change and the next day. Check browser permission, subscription registration, and notification click destination separately. Repeat on Android and desktop.
2. Assign a real load/task between test accounts and open its notification in the appropriate portal. Inspect any specific historical 404 notification with its stored metadata and recipient role.
3. Connect a test Google account through the deployed callback, schedule/edit/cancel an owned timed meeting, and verify the matching Suprah room and participant visibility after sync. Confirm calendar credentials, redirect URI, refresh-token access, and tenant identity.
4. With an approved SMTP test recipient, send a report, verify the actual inbox, open its personal recording/summary link, and check expiration and failed-recipient retry. Confirm sender configuration and domain deliverability.
5. Exercise an authenticated host, internal participant, external guest, phone portrait/landscape, and Mini Meet during a real Chime call. Test media permissions, reconnect, backgrounding, recording, and AI processing. Automated component checks do not prove these external-service/device paths.

No browser implementation can force continuous iOS background execution or guarantee OS delivery. Supported background Web Push needs a valid subscription, permission, an installed Home Screen app on iOS, and working server/push configuration.
