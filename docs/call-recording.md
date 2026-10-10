# Call Recording

Status: **IMPLEMENTED, SECURITY FIXES VERIFIED, AWAITING MANUAL / PROVIDER / LEGAL QA**

Recording is disabled by default and remains disabled. No live number was activated. Implementation and verification used mocked Telnyx/R2 and only MongoDB at `127.0.0.1:27018/suprah_dev`. Stage 41B remains IMPLEMENTED, AWAITING MANUAL / PROVIDER QA. Screen/video recording and the tray application are outside this change.

Parked by user decision: implementation, permissions redesign, security fixes and automated/local verification are complete. Manual, provider and legal QA remain outstanding; this is not production verification or activation approval. Preserve current work and make no further functional changes until the required QA and explicit approval to resume. Do not start screen/video recording or another feature.

## Behavior

- Policies are organization/number/direction-specific. Missing, disabled, invalid or unverified policies do not start recording.
- Enabling requires an actual administrator to acknowledge legal approval, provider verification, connection identity, disclosure ownership and consent policy. This is a configuration gate, not proof of legal compliance or provider support.
- Inbound: immediate Lead/Conversation/CallLog creation and IVR/group ringing/claiming remain intact. A claimed employee answer and matching bridge evidence are required before disclosure/capture. Customer IVR answer alone is insufficient. Customer and employee SIP connections may differ.
- Outbound: browser logging creates a server-issued random correlation token; only its hash is stored on the CallLog. WebRTC receives the token in clientState. Signed provider events must match the token, configured connection, customer/dealership numbers and bound control/session identity. Browser active state alone cannot issue recording commands.
- Outbound support is conditional on the existing SIP/WebRTC connection delivering usable Call Control events and supporting commands. This has NOT been provider-verified. Dialing was not redesigned. If staging cannot prove that capability, outbound recording remains blocked and its policy must stay disabled.
- Suprah-owned disclosure is spoken to both connected legs once, before recording begins. The speech state preserves existing correlation/IVR metadata and includes a separate recording notice reference. Notice callbacks cannot enter the legacy speech-ended hangup path.
- Provider-owned disclosure requires separate explicit verification. No existing operator announcement is assumed adequate. Consent can use an approved notice policy or require the connected rep to attest to customer consent after disclosure.
- Provider commands have unique IDs and bounded timeouts. Only acknowledged commands change recording to recording/paused. A failed pause becomes unknown, marks coverage incomplete, preserves manual pause, and attempts a provider stop. Calls continue normally.
- Manual pause is never automatically resumed by reconnect or subsequent bridge events. Resume is explicit and is rejected after policy disable. Pause and resume are independent of microphone mute and hold.
- Saved/error webhooks are durably queued before acknowledgement. Connection observations use an immediate path plus durable recovery, so a slow file import does not block another call's start/disclosure.
- Recording imports validate call session/leg/connection and coverage timestamps, deduplicate by provider recording ID, refresh provider metadata, and write MP3 to a private R2 key. Imported file size/checksum and provider identity are retained, but neither storage keys nor provider URLs are returned to the browser.
- Pending upload keys are registered before transfer so failed/partially verified uploads can be cleaned up. Missing saved webhooks are reconciled through provider recording lookup. Work/retries are bounded; authorized reviewers can retry a failed import.
- Retention defaults to six calendar months from the call's end, using UTC and end-of-month clamping. Each call snapshots its policy. Expired recordings become inaccessible immediately; cleanup retries removal from R2 and Telnyx and revokes shares. Audio retention does not silently delete audit history.
- Playback/download use short-lived HttpOnly media-session cookies and server streaming with byte-range support. Staff identity, current permission, organization, expiration and share revocation are rechecked at each fetch. No permanent public recording URL is exposed.
- Shares are internal Suprah routes, expire after at most seven days, and do not grant permission. Their recipients must authenticate and already have recording access. Existing buffered/downloaded bytes cannot be remotely revoked.
- Audit history includes viewing, playback/download requests and accesses, reviews, sharing/revocation, configuration/grant changes, disclosure/consent, controls, recovery requests and deletion. Actor IDs and identity kind are preserved; names are not hardcoded.

## Permissions

Recording permissions are explicit per staff identity: `view`, `download`, `share`, `review`, `control`, `delete`. Neither synthesized CRM admin status nor a real admin role automatically grants audio access. Configuration/grant administration verifies the actual active same-organization CRM/core staff record. Call controls additionally require connected-call ownership. Management and QA staff receive the required explicit grants through settings.

## Routes / UI

- CRM Settings -> Call Recording: `/crm/settings/call-recording`.
- Leads -> selected Lead -> Activity -> call entry -> Recording: permission-checked status, native playback, download, internal share, review/access history, deletion and failed-import recovery.
- Active-call bar: provider recording status and Pause/Resume, with separate consent confirmation if configured.
- Recording detail: `/crm/recordings/:id`.
- Authenticated share: `/crm/recordings/shared/:id`.

APIs under `/api/crm/communications`:

- `GET/POST /recording-settings`, `PUT /recording-settings/:id`, `PUT /recording-grants`.
- `GET /calls/:id/recording`, `POST /calls/:id/recording/control`.
- `GET/DELETE /recordings/:id`, `POST /recordings/:id/review`, `POST /recordings/:id/retry`.
- `POST /recordings/:id/shares`, `GET/DELETE /recording-shares/:id`.
- `POST /recordings/:id/media-session`, `GET /recordings/media/:id`.

Recording media/metadata bypass service-worker runtime caching, including cross-origin API paths and active-call recording status. Generated `public/sw.js` is produced through the normal frontend webpack build, not manually edited.

## Files In This Implementation

Backend (18 files, including this document):

1. `src/models/CallRecording.model.ts`: policies, recordings/files/pending uploads, explicit grants, audits, event recovery, shares and media sessions.
2. `src/models/communication.model.ts`: private outbound/connection correlation field.
3. `src/services/callRecordingAccess.service.ts`: actual staff verification, explicit grants and append-only audit writes.
4. `src/services/callRecordingStorage.service.ts`: private R2 import, upload verification, protected streaming and removal; no local/public fallback.
5. `src/services/callRecording.service.ts`: connection proof, disclosure, consent, recording/control lifecycle, imports, recovery and retention.
6. `src/services/telnyx.service.ts`: recording/disclosure commands, strict acknowledgement validation, recording lookup and deletion.
7. `src/services/communication.service.ts`: excludes correlated outbound SDK legs from inbound Lead creation.
8. `src/controllers/callRecording.controller.ts`: settings/permission, playback/download, review, share, retry and deletion APIs.
9. `src/controllers/communication.controller.ts`: verified webhook integration and server-issued outbound correlation; protects recording notice callbacks.
10. `src/routes/communication.routes.ts`: recording endpoints and authenticated media-session stream route.
11. `src/server.ts`: independent recording recovery/retention timer and shutdown cleanup.
12. `jest.recording.config.js`: isolated local recording DB suite.
13. `tests/callRecording.realdb.test.ts`: local persistent lifecycle, access, correlation, import, sharing/revocation and cleanup tests.
14. `tests/unit/callRecording.test.ts`: disabled defaults, calendar retention, configuration gates and URL/evidence validation.
15. `tests/unit/callRecordingLifecycle.test.ts`: mocked lifecycle, manual pause, provider failures, disclosure and IVR evidence.
16. `tests/unit/callRecordingWebhook.test.ts`: signature/durable webhook handling and legacy/IVR compatibility.
17. `tests/unit/telnyxRecording.test.ts`: mocked provider commands and malformed/error response handling.
18. `docs/call-recording.md`: implementation status, limitations and QA/activation checklist.

Frontend (11 files):

1. `src/hooks/useCallRecordingApi.ts`: authenticated recording API and identity-scoped types/query support.
2. `src/hooks/useTelnyxRTC.ts`: server CallLog ID and outbound clientState correlation, without changing dialing.
3. `src/components/communications/CallRecordingControls.tsx`: active-call status/consent/pause/resume.
4. `src/components/communications/CallRecordingPlayer.tsx`: playback/download/share/review/history/delete/retry UI.
5. `src/components/communications/IncomingCallCenter.tsx`: recording controls in responsive active-call bar.
6. `src/components/conversation-workspace/ActivityTimeline.tsx`: recording action on call activity entries.
7. `src/app/(dashboard)/crm/settings/call-recording/page.tsx`: number policies and feature-specific staff grants.
8. `src/app/(dashboard)/crm/settings/page.tsx`: Call Recording settings navigation.
9. `src/app/(dashboard)/crm/recordings/[id]/page.tsx`: authenticated recording detail page.
10. `src/app/(dashboard)/crm/recordings/shared/[id]/page.tsx`: authenticated internal share page.
11. `src/sw.ts`: private recording API/media cache bypass and scoped removal of old recording cache entries; generated worker rebuilt through the normal build.

## Automated Verification

Final result: 91 mocked unit/regression tests, 15 recording local-DB tests and 19 Stage 41B local-DB tests passed. Both repository typechecks passed. Scoped lint passed for new recording code and clean affected settings/activity files. All four responsive preview viewports passed, including native audio control bounds. Git whitespace checks passed; existing unrelated dirty work was preserved.

Run from backend:

```text
npx jest --config jest.unit.config.js --runInBand --runTestsByPath tests/unit/callRecording.test.ts tests/unit/callRecordingLifecycle.test.ts tests/unit/callRecordingWebhook.test.ts tests/unit/telnyxRecording.test.ts tests/unit/ivr.service.test.ts tests/unit/callRoutingConfig.test.ts tests/unit/telnyxIvr.test.ts tests/unit/leadClaim.communication.test.ts tests/unit/communicationTimeline.controller.test.ts tests/unit/intakeClaim.dedup.test.ts
npx jest --config jest.recording.config.js --runInBand
npx jest --config jest.ivr.config.js --runInBand
npx tsc --noEmit
```

Run frontend typecheck and scoped ESLint. Existing lint debt in `useTelnyxRTC.ts`, `IncomingCallCenter.tsx` and `src/sw.ts` was not refactored. New recording components/pages and clean affected settings/activity files pass scoped lint.

Playwright checks use an isolated localhost preview importing actual components/styles, mocked authentication/APIs, and screenshots at 1440, 768, 390 and 320 pixels. They verify disabled/six-month defaults, no overflow, pause/resume, review controls and native audio control bounds. They do NOT prove actual provider capture/audio content, cross-site cookie support or production PWA playback.

## Manual QA

1. Open `/crm/settings/call-recording` as an actual admin. Add an inbound draft policy for a STAGING/test number. Check disabled default and retention 6. Save while disabled; reload and verify persistence. Repeat for outbound. Do not configure or enable a live dealership number.
2. Try enabling with legal/provider/connection/disclosure/consent fields incomplete. Confirm validation rejects it. Confirm employees cannot administer policies even if another CRM screen synthesizes an admin role.
3. Grant a test QA user view/download/share/review, and a test rep control. Keep an unrelated user ungranted. Test same-org, foreign-org, expired/deactivated-account and removed-grant access. No role alone should reveal audio.
4. Once explicitly approved for provider QA, verify the isolated test number's connection and recording capability. Decide disclosure owner and exact legal text/consent mode before enabling its STAGING policy.
5. Inbound: exercise IVR digits 0-4, invalid input, route timeout, Reception fallback, unauthorized claim and recovery. Confirm Lead creation is immediate; Orem/Lehi location metadata stays correct; recording does not begin during menu/ringing/queue. Answer with an authorized rep and confirm both legs connect before one disclosure and recording.
6. Outbound: place a STAGING call normally. Inspect the signed webhook/clientState and bound server session/control IDs. Browser active alone must not capture. Wrong token, number, connection or missing provider evidence must not start recording. If the existing SIP connection cannot supply/control those calls, leave outbound disabled and report that blocker instead of changing dialing.
7. During a connected test call, Pause Recording. Confirm the provider accepts pause; speak a clearly identifiable test phrase. Reconnect/hold/transfer as supported and confirm no automatic resume. Resume explicitly; speak a different phrase. Verify the paused phrase is absent from the actual saved audio, not merely hidden by UI.
8. End a call. Open `/crm/leads`, select its Lead, open Activity, then Recording on its call entry. Verify correct direction/call association, both voices, play/seek, segment selection, download, expiration, review and actor audit entries.
9. Create an internal share; open signed out, with an ungranted user, with another organization and with an authorized reviewer. Only the authenticated authorized same-org reviewer may play. Revoke the share and remove a grant; subsequent media requests must fail.
10. Simulate notice failure, provider start/pause/resume failure, duplicate/missing saved events, temporarily unavailable file and R2 upload failure in staging/mocks. The call must remain usable; coverage/status must not falsely report success. Restore storage and use Retry import with reviewer permission. Verify pending objects can still be deleted.
11. Test retention on local fixtures only: month-end/leap-year boundaries, expired access, share revocation and retrying failed R2/provider deletion. Test explicit deletion and its audit entry; active-call deletion must be rejected.
12. Repeat settings/player/control workflows on desktop/tablet/mobile and installed PWA. Check touch controls, scrolling, seeking, download/share behavior, offline denial, expired media sessions and service-worker cache contents. No audio or authenticated recording API response should be cached for offline replay.

## Before Production Activation

1. Keep live policies disabled until Stage 41B provider/manual QA and recording provider/legal QA are separately approved.
2. Obtain legal/business signoff on jurisdictions, approved disclosure wording/languages, ownership (avoid duplicate operator notices), notice versus affirmative consent, sensitive information handling, retention, permitted downloads/sharing and audit retention. This implementation does not determine legal compliance.
3. Verify inbound Call Control application, SIP employee legs, answer/bridge event ordering and signed webhooks in Telnyx. Verify the existing outbound SIP/WebRTC connection forwards correlation and supports recording commands without changing dialing. An unsupported outbound connection is an activation blocker.
4. Disable any provider auto-recording that would capture IVR/preconnect or produce duplicate recordings/notices. Do not assume Suprah disabled settings disable a provider's independent recording configuration.
5. Configure a genuinely private R2 bucket with no public access/domain, scoped credentials, and correct backend configuration. Confirm imports, HEAD verification, authenticated range streaming/download and deletion using staging. Provider source copies remain until deletion/retention cleanup; their provider retention must also be confirmed.
6. Verify HTTPS/CORS and HttpOnly media cookies on the actual frontend/API domains. Cross-site browser cookie restrictions can block playback; use a same-site API deployment/proxy if required. Deploy the normal PWA worker build; do not manually edit generated `public/sw.js`.
7. Create/verify database indexes, enable recovery worker monitoring, alerts for failed imports/cleanup and unknown recording controls, and validate process restart recovery. Webhook recovery payloads expire after 30 days; audit history has no automatic retention policy yet.
8. Grant only approved staff identities. Back up metadata and document operational escalation for incomplete coverage and unknown pause. Capture verified audio artifacts and signoff for inbound/outbound separately.
9. Enable only the approved org/number/direction policy through the admin UI after explicit activation authorization. Monitor initial calls and have a rollback procedure; disabling a policy prevents future starts/resumes, while a current recording retains its call policy snapshot.

## Limits / Outstanding Verification

- No live/provider/storage/legal verification was performed. Actual speech sequencing, recording gaps, transfer coverage and outbound SIP capability remain staging QA requirements.
- Imports currently support MP3 and a 128 MB per-file bound. Oversized files fail visibly rather than exhausting server memory. Provider lookup is bounded to 50 records per session; unusually segmented calls require further provider-scale verification.
- Media sessions last 15 minutes. Browser playback may require reopening playback after expiration. Download audit records issuance/access, not proof that a person listened to every second or saved the whole file.
- Audio retention is configurable; audit-history retention, legal holds, transcription and screen/video recording are not implemented in this stage.
- Temporary provider outages can delay imports/deletion. Access expires independently of cleanup success. Private bucket lifecycle rules and operational monitoring should provide defense in depth.
- Existing lint errors in legacy RTC/call-center/service-worker code remain; no unrelated cleanup or git operations were performed.

Provider references: [Call commands](https://developers.telnyx.com/api-reference/call-commands/recording-stop), [official Telnyx SDK command definitions](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/calls/actions.ts), [official webhook definitions](https://github.com/team-telnyx/telnyx-node/blob/master/src/resources/webhooks.ts).

## Recording Permissions UX Refinement

Status: IMPLEMENTED - Awaiting user manual QA. Recording and IVR activation remain unchanged and disabled by default.

The original settings matrix saved a grant on each checkbox click, disabled every employee's permission inputs during that request, and then awaited a full settings refetch. The replacement lists only active directory identities with a nonempty existing grant, supports search and access-level filtering, and uses one Grant/Edit dialog with local selections until Save access. Save makes one existing grant PUT and updates the org/auth-scoped React Query cache after success, without a mandatory settings refetch. Failed saves preserve the dialog and selections; duplicate submissions and closing while saving are blocked. Removing access requires confirmation and saves an empty permission set through the same endpoint.

Presets are UI labels for exact existing permission sets, not roles or new backend capabilities:

| Access level | Existing permission keys |
| --- | --- |
| Viewer | view |
| QA/Reviewer | view, review, download, share |
| Full Access | view, review, download, share, control, delete |
| Custom | Any other existing combination |

Custom does not force view on. Existing control-only grants remain valid. The Manager preset was removed during manual QA; existing five-permission grants retain all permissions and now display as Custom. Actual employee CRM roles are unchanged. Control still requires the connected employee's own call; presets do not allow controlling somebody else's call. Review retains the existing reviewed/audit behavior and import retry capability, not annotation or QA scoring. Delete is marked Sensitive. Share still requires view as enforced by the existing backend; custom grants do not bypass that requirement.

The settings directory response now includes actual CRM role/department/avatar and core User role/personalInfo.department/avatar. An active core identity with an explicit recording grant remains visible even when its email matches a CRM identity; the two identity kinds remain separate and grants are never moved or merged. Inactive/offboarded identities remain excluded under the existing rules. No schema, authorization, call lifecycle, storage, retention, provider or IVR behavior changed.

Files for this refinement:

- Frontend `src/app/(dashboard)/crm/settings/call-recording/page.tsx`
- Frontend `src/components/communications/RecordingPermissionsSection.tsx` (new)
- Frontend `src/lib/recording-access.ts` (new)
- Frontend `tests/recording-access.test.mjs` (new)
- Frontend `tests/recording-permissions.browser.mjs` (new)
- Backend `src/controllers/callRecording.controller.ts` (directory response only)
- Backend `tests/callRecording.realdb.test.ts`
- Backend `docs/call-recording.md`

Verification commands:

```text
Frontend: node --test tests/recording-access.test.mjs
Frontend: npx tsc --noEmit
Frontend: npx eslint "src/lib/recording-access.ts" "src/components/communications/RecordingPermissionsSection.tsx" "src/app/(dashboard)/crm/settings/call-recording/page.tsx"
Backend: npx tsc --noEmit
Backend: npx jest --config jest.recording.config.js --runInBand
Backend: npx jest --config jest.ivr.config.js --runInBand
```

The browser test requires Playwright and an isolated localhost preview using the actual page/components with mocked authentication. Set PLAYWRIGHT_MODULE to the Playwright package directory if outside frontend dependencies, RECORDING_PREVIEW_URL if not using port 3011, and optionally RECORDING_SCREENSHOTS. Run `node tests/recording-permissions.browser.mjs`. Its API interception mocks every recording settings/grant request and hides only Next.js development overlays. It checks grant/edit/custom/removal, failure/retry, no checkbox mutations, one save PUT, no settings refetch, filtering, identity selection, dialog/selector bounds, scrolling, footer visibility, and disabled/six-month policy defaults at 1440, 768, 390 and 320 pixels. This does not replace installed-PWA/device QA.

Automated results for this refinement: frontend and backend typechecks passed; scoped ESLint for all three frontend application files and both test scripts passed; 6 frontend helper tests, 61 focused mocked recording/IVR tests, 19 recording local-DB tests and 19 IVR local-DB regressions passed. Playwright passed the full permission workflow at all four widths with no horizontal overflow. Real-DB verification used only `127.0.0.1:27018/suprah_dev`; Telnyx/R2 were mocked. No live/provider/PWA-install verification was performed.

Manual QA for this refinement:

1. Open CRM -> Settings -> Call Recording (`/crm/settings/call-recording`) as a verified administrator. Confirm only staff with a nonempty recording grant appear, with real identity details, correct inferred badges and count; number policies remain unchanged.
2. Search by name, email, actual role and department. Try each Access Level, including Custom. Clear filters and verify the complete authorized list returns.
3. Grant Access: search for an ungranted staff member, select each preset, then Custom. Check/uncheck permissions without saving; confirm no grant request is sent. Cancel and confirm no change. Delete should be marked Sensitive, with no forced Listen checkbox.
4. Save a test grant. Confirm Saving disables repeat submission and closing, then the list updates immediately and success is shown. Reload to verify persistence. Confirm one grant PUT rather than one request per checkbox.
5. Edit every preset and a control-only Custom grant. Confirm exact inference, restored selections and cancel behavior. Save a different preset and reopen to confirm the new level.
6. Simulate a failed Save in local/staging. Confirm selections remain and retry works. Test Remove access cancellation, failure/retry and successful removal; reload to confirm permissions are empty.
7. Use an ungranted or revoked staff account to attempt recording view/media playback, download, share, review, controls and deletion directly. Verify denial, including an existing media URL and a foreign-organization recording. Preset labels must not change backend ownership or administrative rights.
8. Repeat on desktop/tablet/mobile/installed PWA, including 320px width, long names, searchable selector, dots menu, Custom scrolling, keyboard focus and Save/Cancel visibility. No horizontal overflow. Actual installed PWA and provider playback remain manual QA items; do not enable any live number for this UI check.

### Manual QA Follow-up: Picker Scrolling and Custom Collapse

The user picker scroll failure was reproduced with 50 selectable mocked employees: wheel input did not change the list scroll position. The non-modal body-portalled picker was outside the parent dialog's scroll-lock boundary. The picker now uses Radix's modal popover behavior for its own scroll/focus boundary, with a viewport-bounded list and fixed search area. Other popovers and shared UI components are unchanged.

Custom originally only selected a radio value, so clicking an already selected radio could not collapse anything. It now has a separate accessible expand/collapse button, independent of the selected access level and permission selections. Closing/reopening the Individual Permissions area does not reset edits or save anything.

Follow-up verification covers a long employee list with real wheel up/down input, mobile touch swipes, Escape closing only the picker, repeated Custom click/keyboard toggles with retained selections, and absence of the Manager preset/filter while its prior grants remain Custom. Recheck these in the installed PWA as well. No backend implementation, permission grant, call behavior or activation setting changed in this follow-up.

Follow-up results: frontend typecheck, scoped lint and all 6 helper tests passed. Mocked Playwright workflows passed at 1440, 768, 390 and 320px, including wheel up/down on all viewports and touch up/down on mobile/narrow viewports. No database or live provider/storage access was needed. Manual re-test: Grant Access -> open employee picker -> scroll both ways; select Custom -> change a permission -> collapse/reopen repeatedly -> confirm selection remains; verify no Manager option/filter and previous five-permission users display Custom.

## Pre-activation Media Session and PWA Security Fixes

Status: IMPLEMENTED - Locally verified; awaiting actual-domain and installed-PWA manual QA. Overall recording/provider/legal and Stage 41B statuses remain unchanged. No live policy was enabled.

The old media endpoint authorized its separate 15-minute media cookie without checking the login that created it. Media now requires both that cookie and a live originating login, and binds authentication kind/session, authenticated user, recording principal and organization. CRM browser/password, biometric, SSO and token-renewal flows use the existing Session store and CRM JWT verification. Main-account media uses the existing refresh cookie/session. Refresh rotation keeps a stable login family; logout revokes that family, including delayed refresh results. CRM logout removes associated media sessions; SSO media also checks its parent main login. Existing permission, active-user, organization, expiration and share checks still run on every media fetch. Old unbound media sessions are denied; legacy CRM tokens require renewed authentication before playback. This is not a new recording permission system.

Logout stops/removes loaded audio immediately. Successful sign-out/navigation waits for server revocation; a failed/offline logout is not reported as completed and must be retried online. Account changes unmount the old player, and late media-session responses cannot reopen playback or initiate downloads after client invalidation. Already delivered/downloaded bytes cannot be remotely revoked.

The source recording bypass had not reached the generated worker, allowing cross-origin media to fall through to generic caching. The normal `npm run build` now regenerates `public/sw.js`. Recording media, metadata, settings/grants/shares and active-call recording APIs use NetworkOnly on either origin. Activation and logout remove old recording entries from all cache names, including audio caches, without removing unrelated static entries. Backend recording routes also mark responses, including errors, private/no-store. Offline recording access is unavailable; normal static caching remains available.

### Changed Files In This Fix

Backend:
- `src/middleware/crmAuth.middleware.ts`: tracked CRM login issuance/renewal/verification/revocation and authenticated token context.
- `src/models/Session.model.ts`: additive CRM identity, login family, parent family and revocation fields in the existing auth store.
- `src/services/auth.service.ts`: stable refresh families, family-wide logout and delayed-refresh revocation guards.
- `src/controllers/auth.controller.ts`: main logout revocation and same-org, active-session CRM SSO issuance.
- `src/controllers/crm.controller.ts`: tracked password login/renewal and CRM logout revocation.
- `src/controllers/crm-biometric.controller.ts`: tracked biometric login token issuance.
- `src/services/recordingMediaAuth.service.ts`: current-cookie login verification, identity binding and logout media revocation.
- `src/models/CallRecording.model.ts`: additive originating-authentication fields on media sessions.
- `src/controllers/callRecording.controller.ts`: bind media creation and revalidate its current originating login before streaming.
- `src/routes/communication.routes.ts`: no-store recording headers before authentication and media processing.
- `tests/recordingMediaAuth.realdb.test.ts`: actual JWT/session/local-DB media security tests with mocked storage/providers.
- `tests/callRecording.realdb.test.ts`: existing media tests updated to authenticate through real CRM middleware.
- `jest.recording.config.js`: includes the new isolated local-DB suite.
- `docs/call-recording.md`: this security/QA record; no stage activation status changed.

Frontend:
- `src/components/communications/CallRecordingPlayer.tsx`: identity-keyed player, audio cleanup and late-response invalidation.
- `src/components/layout/CrmHeader.tsx`: immediate privacy cleanup and acknowledged CRM logout with retry feedback.
- `src/providers/AuthProvider.tsx`: acknowledged main logout with failure feedback before clearing login/navigation.
- `src/lib/recording-network.ts`: shared recording endpoint classifier used by the worker and tests.
- `src/sw.ts`: recording NetworkOnly coverage and scoped legacy-cache purge.
- `public/sw.js`: generated by the normal webpack/Serwist build, never manually patched.
- `tests/recording-network.test.mjs`: endpoint coverage and unrelated-resource exclusions.
- `tests/recording-worker.browser.mjs`: real generated worker, mocked local HTTP authentication/media, online/offline/cache migration/logout/account-switch checks.
- `tests/recording-player.browser.mjs`: actual player on the isolated mock-auth preview, logout/late-response/account-switch and four-width layout checks.

### Verification and Remaining QA

Local recording suites: 37 tests passed, including 18 new media/login security cases and 19 existing lifecycle/access tests. Stage 41B local-DB regressions: 19 passed. Mocked recording/inbound-call/IVR and existing CRM/tray compatibility suites: 214 passed. Frontend helper/generated-worker tests: 9 passed. Actual player checks passed at 1440, 768, 390 and 320px. Both typechecks and the normal frontend build passed. Focused new/clean-file lint passed; existing `any`-type lint debt in AuthProvider and the worker remains, without unrelated refactoring.

Use only `127.0.0.1:27018/suprah_dev` and mock providers/storage for automated DB checks. Deploy with the normal environment-specific frontend build. The worker retains the existing non-disruptive waiting/activation lifecycle: close all old controlled tabs/PWA windows and reopen before testing the new active worker; then confirm old recording entries are absent. Verify actual HTTPS/CORS/cookie-domain behavior, online play/seek/download, reload, logout -> old URL denial, A -> logout -> B -> old URL denial, grant removal, deactivation and offline denial in the installed PWA. Check static resources still work offline. Provider capture and disclosure/legal approval remain separate blockers; no Telnyx/R2 live verification was performed.
