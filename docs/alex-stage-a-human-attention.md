# Alex Stage A - Human Attention

Status: **COMPLETED / LOCALLY VERIFIED / MANUALLY VERIFIED**

Manual verification recorded on 2026-10-03: the user confirmed that Stage A was manually tested and its behavior is working correctly. This documentation-only status update makes no additional functional changes and does not start inventory implementation.

This stage implements silent escalation for AI identity concerns and explicit requests for a human. It does not introduce inventory lookup, shopping qualification, autonomous booking, Contact/Lead Phase 2, or changes to the parked IVR and Call Recording behavior. No production database or live provider calls were used. Existing uncommitted work remains preserved.

## Behavior

- SMS and webchat use the same semantic classifier. Phrase examples exist only in tests; production does not match a list of identity keywords.
- Inbound messages register a pending check and advance a response version before persistence. Older Alex turns cannot dispatch while that check is pending or after their version is superseded.
- Classification runs before the generation lock, coaching, and response caps. Being busy, temporarily auto-paused, or capped does not prevent customer concerns from reaching staff.
- Identity concerns and human requests cause no Alex acknowledgment, generated response, or fallback response. They create a durable manual pause, a scoped AI Agent Task, an audit log, and a customer-waiting notification with a direct Lead link.
- One pause episode has one persisted task ID. Duplicate messages, concurrent concerns, and delivery retries reuse it. Completing or dismissing the task does not resume Alex.
- Authorized staff resume clears the human-attention pause/pending state and increments the response version. Earlier generations cannot return after resume. Resume does not resend old customer messages.
- Active assigned representatives are preferred, then the configured active Lead Group, then active organization admins/managers. Foreign/inactive group members are excluded. A linked active CRM identity is preferred for notification delivery without duplicating the main identity's alert.
- Notifications use deterministic document IDs derived from organization, recipient, notification type, and episode key. A task notification lease coordinates delivery; interrupted delivery is retry-safe. Existing notification preferences remain respected.
- Organization-scoped duplicate SMS webhooks recover interrupted handoff delivery and abandoned pending checks without inserting another message or generating an Alex reply.
- Ambiguous, malformed, unavailable, or timed-out classifiers fail closed: Alex stays silent and a human-attention check-unavailable task is created. Database failures keep the pending send barrier intact where persistence remains available.
- Atomic dispatch authorization enforces organization, current response version, no pending checks, no manual/human pause, and no active auto-pause. Only one dispatch is authorized per version.
- Webchat drafts are hidden until dispatch authorization; visitor polling, staff messages, Lead activity, history, and reply counts exclude pending drafts. Rejected drafts are removed.
- Newest ordinary messages may wait briefly for an older generation lease to finish; stale turns cannot send, and an older worker cannot clear a newer worker's lease.
- SMS opt-outs and exact transactional appointment commands retain their existing behavior. Freeform reschedule capture cannot swallow an identity concern. Transactional appointment messages are distinct from an Alex conversation reply.
- Existing coaching and hard outbound protections are unchanged in priority. Prompts no longer instruct Alex to impersonate a human or conceal automation.

## Scope And Recovery

Pause scope is the SMS conversation or webchat session, not every channel associated with a customer. This stage does not change Lead Source, location, assignment, or identity linking.

No new index migration is needed: episode, task, audit, and notification idempotency use existing MongoDB document IDs. Historical documents receive new gate fields when an inbound message begins; no historical backfill runs.

The new send barrier is effective after code deployment across every backend process handling these channels. Drain/replace older workers during deployment; an older worker does not enforce the new guards.

Provider delivery already committed before escalation cannot be recalled. Gemini generation may finish after escalation, but its stale output is discarded. The atomic dispatch authorization is the commitment boundary; this stage does not claim an atomic transaction between MongoDB and Telnyx.

If there are no configured active recipients, the durable pause/task remain, delivery failure is logged, and notifications can be retried through subsequent checks. There is no new background notification recovery worker. Existing notification preferences and push/browser delivery can also prevent an immediate visible alert; the task remains reviewable in CRM.

After an interrupted generation/publication or a database outage, verify the task and pause before explicitly resuming. Hidden webchat drafts never become customer-visible automatically. Staff resume clears abandoned pending checks. An SMS provider error retains the existing failed-message behavior.

## Verification

Automated checks mock Gemini, Telnyx, and push delivery. All real-DB checks use only `mongodb://127.0.0.1:27018/suprah_dev`, with test-owned organization cleanup and no production configuration changes.

- Focused mocked tests: semantic classifier output contracts/failures, core send/fallback suppression, coaching, caps, auto-pause, authenticated resume, notes/notifications, intake, appointments, IVR, and recording regressions.
- Stage A local DB: silent escalation, source references, assigned/group/admin and linked-CRM delivery, concurrent/repeated message idempotency, failed delivery retry, task resolve/dismiss without resume, stale generation suppression, atomic single-dispatch, hidden-draft polling/activity, normal replies, queued newest turns, opt-outs, and transactional appointment confirmation.
- Existing local IVR and recording/security suites are rerun without activation.
- Backend and frontend typechecks run without emitted files; no frontend/service-worker build or regeneration is needed because frontend code is unchanged.

Mocked language fixtures verify classifier integration and routing contracts, not the real model's linguistic accuracy. The user has now confirmed successful manual testing of Stage A behavior. This does not assert a production deployment or coverage of every language, device, or provider failure scenario.

Results: **299 tests passed**: 199 focused mocked tests across 19 suites, 44 Stage A local-DB tests, 19 existing IVR local-DB tests, and 37 existing recording/security local-DB tests. Backend and frontend no-emit typechecks passed. Git whitespace checks passed for affected tracked files. Jest reports the existing ts-jest isolatedModules deprecation and transient timeout/open-handle warnings; the test processes exited successfully.

## Files

- Models: `src/models/aiHumanAttention.ts`, `src/models/communication.model.ts`, `src/models/WebChatSession.model.ts`, `src/models/WebChatMessage.model.ts`, `src/models/AiAgentTask.model.ts`.
- Services: `src/services/aiHumanAttention.service.ts`, `src/services/aiAgent.service.ts`, `src/services/communication.service.ts`, `src/services/notification.service.ts`.
- Controllers: `src/controllers/communication.controller.ts`, `src/controllers/webchat.controller.ts`.
- Utilities: `src/utils/aiReplySuppressed.ts`, `src/utils/leadNote.ts`.
- Tests/configuration: `tests/unit/aiHumanAttention.test.ts`, `tests/unit/aiAgent.test.ts`, `tests/unit/aiPauseResume.controller.test.ts`, `tests/unit/leadClaim.communication.test.ts`, `tests/aiHumanAttention.realdb.test.ts`, `tests/aiHumanAttention.local.setup.ts`, `jest.attention.config.js`.
- Documentation: `docs/alex-stage-a-human-attention.md`.

## Manual QA

The user has confirmed successful manual QA. The scenarios below remain as the regression checklist; individual scenario results were not supplied.

1. Use an approved test organization/channel with Alex enabled. Open CRM Leads at `/crm/leads`, assign a test Lead to an active representative, and send a normal message to confirm existing replies work.
2. In fresh or explicitly resumed SMS and webchat conversations, try direct and indirect identity concerns, paraphrases, and explicit requests for a salesperson/person. Expect no Alex customer response, a persistent paused status, one AI Agent Task, and a customer-waiting alert.
3. Open the alert. It must navigate to `/crm/leads?leadId=<id>` and identify the appropriate conversation/channel. Check assigned-rep delivery, a valid configured fallback group, and admin fallback when assignment/group is unavailable.
4. Repeat the concern while paused. Expect no additional task or repeated notification for the same episode. Confirm normal follow-up messages do not restart Alex.
5. Resolve or dismiss the task, send a real staff reply, refresh the page/PWA, and wait beyond the configured auto-pause window. Alex must remain paused.
6. Use the existing conversation Resume control as authorized staff. Send a new ordinary message; Alex can respond. Earlier drafts/messages must not be replayed.
7. Discuss unrelated AI vehicle features, a job building bots, or another automated service. Expect ordinary conversation behavior, not an identity handoff. Test multilingual natural wording in approved model/channel QA.
8. Send a normal question followed immediately by an identity concern while the first reply is still generating. Inspect logs and customer history: the stale draft/fallback must not dispatch. A reply already committed before the second message arrived is outside cancellation scope.
9. Confirm STOP remains an opt-out, and an existing appointment YES confirmation still works without resuming a human-paused Alex conversation. Check an identity concern during freeform reschedule capture still escalates.
10. On desktop, tablet, mobile, and installed PWA, check paused status, notification navigation, task actions, and explicit Resume. No frontend layouts or permission controls were redesigned.
11. Test another organization and an inactive/foreign assignment/member; neither should receive this customer's handoff or control this pause. Confirm failed classifier and notification delivery do not produce an Alex response.

Contact/Lead Phase 1 remains **DEPLOYMENT-PREPARED / AWAITING AUTHORIZED PRODUCTION DEPLOYMENT**. Stage 41B remains **IMPLEMENTED, AWAITING MANUAL / PROVIDER QA**. Call Recording remains **IMPLEMENTED, SECURITY FIXES VERIFIED, AWAITING MANUAL / PROVIDER / LEGAL QA**, disabled. No next stage is started.
