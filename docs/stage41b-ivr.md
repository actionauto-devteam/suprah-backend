# Stage 41B: Admin-Configurable IVR Call Routing

Work date: Friday, October 2, 2026, America/Denver.

Status: **IMPLEMENTED, AWAITING MANUAL / PROVIDER QA**

Automated verification is complete. This stage is not fully completed or production-verified; staging/live-call verification is pending Telnyx/provider configuration. No live dealership configuration was enabled. No production database or live Telnyx calls were used. Stage 41A, Stage 38 location filtering, Stage 40, Alex coaching, and unrelated working-tree changes were preserved.

Parked pending manual/provider QA. Preserve the current implementation and disabled configuration defaults; make no further functional changes until the required QA and explicit approval to resume. This status is not production activation approval.

## Behavior

The admin entry point is CRM Settings > Call Routing, at `/crm/settings/call-routing`. Group membership remains managed at `/crm/settings/lead-groups`.

Configurations are organization-owned and matched to a normalized inbound number. They default to disabled. Admins can manage the configuration name, inbound/public main numbers, greeting/menu, unique digits, labels, group destinations, route types, optional location/language metadata, ring timeout, menu retries, Reception group, and optional all-organization fallback. Active groups must belong to the configuration's organization. Disabled configurations retain number-to-organization identity without enabling IVR.

| Default digit | Destination | Lead location |
| --- | --- | --- |
| 0 Spanish | Configured Reception group | Unchanged; language request stored separately |
| 1 Orem | Configured Orem group | Orem |
| 2 Lehi | Configured Lehi group | Lehi |
| 3 Service | Configured Service group | Unchanged |
| 4 Title/Licensing | Configured Titles/Licensing group | Unchanged |

The Service number can be recorded as a pending external destination. This version does not execute external PSTN transfers. External Main/current ingress/other configured ingress destinations are rejected. Reception is always an internal route, avoiding transfer back to the incoming IVR line. Employee names and account IDs are not hardcoded.

Lead creation/linking still occurs before DTMF. The configuration is snapshotted into CallLog so edits affect subsequent calls; live group membership is checked during ringing recovery and claims. Main User and linked CRM identities are resolved within the organization.

Valid IVR calls are not announced to reps before route selection. Customer-leg answer events remain distinct from employee-leg answers. Menu and hold speech completion do not hang up the call. Ringing delivery targets user/CRM socket rooms, `/calls/ringing` applies eligibility checks, and claims use eligibility plus atomic status/revision checks. Previous recipients' toasts are dismissed when fallback changes the target.

Invalid/no input replays the menu once by default, then rings Reception. Unavailable or unanswered selected groups also fall back to Reception. Unanswered Reception uses the existing missed-call copy and automated SMS path, retaining its opt-out and duplicate protections. All-organization fallback is disabled by default and is only used after Reception when enabled. Caller abandonment is canceled rather than reported as an employee-completed call.

Disabled, missing, invalid, and failed initial answer/gather configurations retain legacy organization-wide ringing. Failed initialization is audited as a legacy fallback, even when normal IVR all-organization fallback is disabled. Persistent deadlines and revision checks support recovery every five seconds and on ringing retrieval. Duplicate inbound reservation and gather correlation protect against duplicate delivery. Stale agent legs are excluded and pending legs are canceled during fallback.

CallLog stores selected digit/label, route type/language/location, current target, recipient identities, notified identities, retry count, deadlines, revision, and transition reasons/timestamps. Call popups show the selected option and Reception fallback where applicable.

## Files Changed

Backend:

- `src/models/CallRoutingConfig.model.ts` (new configuration/state types and inbound reservation)
- `src/models/communication.model.ts` (IVR status/state and recovery index)
- `src/services/callRoutingConfig.service.ts` (new validation, number resolution, and group identity resolution)
- `src/services/ivr.service.ts` (new routing/retry/fallback/recovery state machine)
- `src/services/communication.service.ts` (inbound, claims, answer/hangup/speech integration)
- `src/services/telnyx.service.ts` (bounded answer/gather/speech commands)
- `src/controllers/callRoutingConfig.controller.ts` (new admin configuration API)
- `src/controllers/communication.controller.ts` (targeted ringing recovery and gather webhook dispatch)
- `src/routes/communication.routes.ts` (configuration routes)
- `src/server.ts` (persistent-deadline recovery worker)
- `jest.ivr.config.js` (isolated local-DB test configuration)
- `tests/ivr.local.setup.ts` (local-only database guard/setup)
- `tests/ivr.realdb.test.ts` (real MongoDB integration verification)
- `tests/unit/callRoutingConfig.test.ts` (configuration validation)
- `tests/unit/ivr.service.test.ts` (mocked routing behavior)
- `tests/unit/telnyxIvr.test.ts` (mocked provider request contracts)
- `tests/unit/leadClaim.communication.test.ts` (existing test's new routing dependency mocks)
- `docs/stage41b-ivr.md` (this implementation/QA record)

Frontend:

- `src/app/(dashboard)/crm/settings/call-routing/page.tsx` (new admin page)
- `src/app/(dashboard)/crm/settings/page.tsx` (admin navigation entry)
- `src/lib/communicationStore.ts` (IVR status/metadata and toast dismissal on route change)
- `src/components/communications/IncomingCallCenter.tsx` (selected route metadata)

No dependency, environment, campaign, source/date filter, recording, or Alex implementation files were changed for this stage. Temporary browser/MongoDB tools were kept outside the repositories.

## Automated Verification

- Backend and frontend `npx.cmd tsc --noEmit`: passed.
- Focused settings/page lint: passed.
- Lint of the existing incoming-call component/store remains blocked by eight pre-existing issues (`Date.now()` during render and existing `any` types). Those unrelated lines were left unchanged.
- Nine focused mocked unit/regression suites: 93 tests passed. The combined existing suites require Jest's `--forceExit` because of retained asynchronous handles.
- Real MongoDB integration: 19 tests passed, using only `mongodb://127.0.0.1:27018/suprah_dev`; provider calls were mocked and live fetch rejected. Fixtures were organization-scoped. The usual local DB was offline, so verification used an isolated temporary MongoDB data directory on the approved address.
- Playwright: actual settings component tested with project CSS and mocked auth/APIs at widths 1440, 768, 390, and 320 pixels. Create, edit, save, repeated-save update, default-disabled switches, and horizontal viewport fit passed. This was an isolated component harness; full-shell and installed-PWA testing remain manual.
- Git whitespace checks: passed. Git inspection was read-only.

## Provider Activation Requirements

1. Establish whether public Main `(801) 766-6137` is Telnyx-controlled or forwards to a different ingress. The local configured company number does not match Main or Service.
2. Verify that the actual ingress uses a Telnyx Call Control application and Suprah's signed `/api/webhooks/telnyx` endpoint. Check signing key, voice/SIP setup, and provider forwarding that might bypass Suprah.
3. Verify answer/gather/transfer webhook behavior, hold audio, caller abandonment, and SIP leg failure ordering on a dedicated staging/test number before changing live Main.
4. Configure organization Lead Groups and available browser softphones. Group membership does not prove that a user's browser is registered or can receive audio.
5. Ensure configuration/reservation unique indexes and the CallLog deadline index exist during deployment if production auto-indexing is disabled.
6. Keep external Service transfer disabled until its ownership/forwarding behavior is established. Supporting active external transfer will need provider-verified handling and approval.

Telnyx references: [Gather using speak](https://developers.telnyx.com/api-reference/call-commands/gather-using-speak), [Transfer call](https://developers.telnyx.com/api-reference/call-commands/transfer-call).

## Manual QA

Use the normal local CRM for configuration QA. Use a dedicated staging/test number for real calling only after its provider configuration has been reviewed. Do not enable IVR on live Main during this QA.

1. Open CRM Settings > Call Routing. Confirm admins can access configuration and regular staff cannot manage it. Open Lead Groups and create/select Reception, Orem, Lehi, Service, and Titles/Licensing with test members.
2. Click New configuration. Confirm IVR enabled and all-organization fallback start off. Enter the actual test ingress, keep the public Main number identified, select Reception, and select groups for options 1-4. Confirm option 0 follows Reception.
3. Save disabled. Reload and edit the record. Save again and confirm it updates one configuration rather than creating duplicates. Test invalid numbers, repeated digits, out-of-range timeouts/retries, and enabling with missing groups. Confirm Main/ingress external destinations are rejected and a pending Service number never activates transfer.
4. On desktop, tablet, mobile, and the installed PWA, check form controls, native dropdowns, scrolling, keyboard entry, save/error states, and long labels. Confirm no horizontal overflow and usable touch targets. Saving requires connectivity; offline failure must not display success.
5. With the test configuration enabled and test reps logged in, start a call from a new number. Confirm a linked Lead appears immediately, but no rep gets a call toast while the menu is playing. Check that IVR answer has not marked the call employee-answered.
6. Test digits 0-4 separately. Confirm only the selected group rings; Spanish rings Reception. Confirm Orem/Lehi set the linked Lead's location and work with the existing location filter. Spanish, Service, and Titles must leave an existing location unchanged. Check the selected-option label in the toast.
7. Keep an outsider logged in. Refresh/open the Inbound Calls area while another group is ringing. Confirm no incoming toast/recovered ringing call and that a direct claim is rejected. Change/remove group membership and confirm recovery/claims re-check eligibility. Test two group members answering together: only one should win.
8. Enter an invalid digit, then no digit on the replay. Confirm exactly one replay and then Reception. Also test no input twice. End the call during the menu and confirm it does not become a completed employee call.
9. Leave a selected group unanswered. Confirm its toast disappears and Reception rings. Leave Reception unanswered; confirm the missed announcement, final missed status, and a single opt-out-aware text-back. Repeat with all-org fallback enabled: selected group, then Reception, then all-org, then missed.
10. Answer normally. Confirm menu/hold speech endings do not disconnect the call; only an employee-leg answer marks it live. Test rejected/unregistered softphones and failed agent legs, then inspect fallback and late event handling.
11. Replay inbound/gather/answer/hangup test webhooks in staging. Confirm one CallLog/Lead, one route selection per menu attempt, and no duplicate text-back. Restart the staging backend during ringing and confirm persisted deadlines recover the route.
12. Disable IVR and repeat a test inbound call. Confirm the existing org-wide first-to-answer behavior and missed-call handling still work. Review CallLog routing history for selected digit, target, fallback reasons, and terminal outcome.

## Limits

External transfer is intentionally inactive. Live provider audio and installed-PWA behavior have not been tested. Existing call history remains organization-visible; incoming ringing notifications/recovery/claims are targeted. Browser softphones require an online, registered session; an installed PWA alone does not provide background/offline ringing guarantees. Text-back retains the existing claim-before-send behavior rather than adding a delivery outbox in this stage.
