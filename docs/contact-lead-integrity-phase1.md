# Contact / Lead Integrity - Phase 1

Status: **DEPLOYMENT-PREPARED / AWAITING AUTHORIZED PRODUCTION DEPLOYMENT**

Implementation and deployment hardening are locally verified. This is not production verification, deployment approval, or confirmation that manual CRM QA is complete. Authorized environment inventory, backup, index preparation, deployment and smoke QA remain prerequisites.

Scope: integrity and linking only. There is no new duplicate detection UI, Customer Merge, Lead Merge, merge button, automatic merging, or dependent-history reassignment. Phase 2 requires separate approval.

Stage 41B remains **IMPLEMENTED, AWAITING MANUAL / PROVIDER QA**. Call Recording remains **IMPLEMENTED, SECURITY FIXES VERIFIED, AWAITING MANUAL / PROVIDER / LEGAL QA**. Neither feature was activated or functionally redesigned by this phase.

## Identity Architecture

- `Lead.customerId` references a Customer in the same organization. Multiple legitimate Leads can reference one Customer.
- `Customer.sourceLeadId` remains first-Lead provenance. It is not the complete relationship or proof that other Leads are duplicates.
- `Lead.customerLink` records status, reason, candidate IDs, verification time and retry time. Consumers must check status rather than treating any existing reference as a currently verified identity.
- Email identity is trimmed and lowercased. Phone identity is validated using `libphonenumber-js/max`, converted to full E.164, and preserves an extension. National-format input defaults to US. Last-ten-digit matching and name similarity are not identity proof.
- Raw Lead contact information is retained. Phone-only and email-only intake are supported; no placeholder email is generated.
- Exactly one compatible, active Customer matching a normalized contact can be reused. Conflicting nonempty email/phone values, multiple matching Customers, inactive Customers, and disagreeing existing relationships are not guessed away.
- Vendor/proxy sender addresses are excluded from customer identity where the intake identifies them as such. Historical ADF/central-ingestion sender-equals-contact cases are conservatively excluded too.
- An organization lease serializes supported Customer identity writes. A unique creation key, guarded transaction append, contact snapshot comparison and retry worker make normal synchronization rerunnable and recoverable.
- The physical unique organization index on the lock collection is checked before identity writes. Missing index preparation fails closed; intake is retained with retry state rather than using an unsafe unlocked lookup.

### Relationship States

| State | Meaning |
| --- | --- |
| `pending` | New or edited contact awaits verification. |
| `linked` | A compatible organization-scoped Customer was found or created. |
| `unresolved` | Missing/invalid contact, excluded Demo/vendor-only identity, or no existing historical Customer. |
| `ambiguous` | More than one Customer matches the normalized contact evidence. |
| `conflict` | Contacts, existing provenance, inactive Customer or reference scope disagree. |
| `retry` | Synchronization could not finish safely because of infrastructure, concurrency or write failure. |

A conflicting but same-organization historical `customerId` is retained as a reference with `conflict` status, not silently reassigned. A missing or foreign-organization reference is cleared and reported as a conflict.

## Intake Coverage

| Intake | Phase 1 behavior |
| --- | --- |
| Manual Add Lead | First name plus email or phone is accepted; persistence triggers identity synchronization. |
| ADF / third-party | Existing atomic ingestion is retained; actual customer contacts are used, not a vendor sender identity. |
| Gmail / email | Existing deduplication remains; the system user is resolved within the organization and untrusted sender contacts are excluded. |
| SMS | Full normalized, organization-scoped contact lookup is used; new Leads synchronize through persistence hooks. A verified Customer can be attached to the first message. |
| Inbound call | Immediate Lead creation/linking remains; CallLog can use the verified Customer. IVR selection, recording and call lifecycle are unchanged. |
| Webchat | Existing Lead creation runs through the shared persistence synchronization. |
| Public booking | Existing booking claim and appointment creation remain; the created Lead uses shared synchronization. |
| Website vehicle inquiry | Existing Lead persistence uses shared synchronization. |

New/contact-changing `save` and supported `findOneAndUpdate` operations invoke the resolver. Status, note or location-only edits do not trigger contact relinking. Raw collection writes, `insertMany` and `bulkWrite` are not covered by these hooks; any future import must explicitly use reconciliation.

## Edits And Existing Activity

- Lead contact edits revalidate the relationship. Contradictory edits produce a conflict rather than moving the Lead or overwriting another Customer's contacts.
- Customer edits use a restricted field allowlist, check contact collisions, refresh normalized identity and revalidate linked Leads. Deactivation also revalidates linked Leads.
- Hard deletion of a Customer referenced by a Lead is rejected.
- One guarded Lead transaction is appended to the Customer, with first/last-contact statistics updated idempotently. Existing `sourceLeadId` is preserved.
- Only an empty `Conversation.customerId` for the exact same organization and Lead may be filled. Existing nonempty conversation ownership is not moved.
- Existing notes, status/assignment histories, appointments, CommunicationMessages, calls, AI logs/tasks, webchat, campaigns, re-engagement records and ingestion claims are not merged or reparented.
- Source taxonomy, Lead location, list filtering, Coach your AI, pause/handoff and campaign behavior remain outside this change.

## Historical Reconciliation And Index Preparation

Historical reconciliation defaults to preview. Apply mode links only a uniquely compatible existing Customer; it does not create a Customer for a historical Lead with no match. Ambiguous/conflicting relationships are reported, not automatically selected.

The paginated report contains organization, dry-run flag, Lead IDs, statuses, reasons, candidate IDs and a next cursor. Repeat with the returned cursor until a page is empty. Re-running an applied page does not duplicate Lead transactions.

The existing authenticated backfill endpoint now requires the existing admin permission and returns this report. Apply must be explicit. The ordinary Customers-page sync endpoint processes runtime-marked pending/retry Leads only; opening Customers does not implicitly migrate untouched historical Leads. Existing total/synced/skipped/failed/alreadySynced response counters are preserved.

### Index Manifest And Startup Policy

The ten required definitions are shared by schemas, preparation and verification in `src/constants/customerIdentityIndexes.ts`. All keys below are ascending.

| Collection | Keys | Properties |
| --- | --- | --- |
| CustomerIdentityLock | organizationId | Unique, full index. |
| Customer | organizationId, identityCreationKey | Unique; partial: identityCreationKey has BSON type string. |
| Customer | organizationId, normalizedEmail | Nonunique, full index. |
| Customer | organizationId, normalizedPhone | Nonunique, full index. |
| Customer | organizationId, normalizedAlternatePhone | Nonunique, full index. |
| Lead | organizationId, customerId | Nonunique, full index. |
| Lead | organizationId, normalizedPhone | Nonunique, full index. |
| Lead | organizationId, normalizedEmail | Nonunique, full index. |
| Lead | customerLink.status, customerLink.nextRetryAt | Nonunique, full index. |
| Customer | organizationId, email | Unique, named customer_org_email_present_unique; partial: email has BSON type string and is greater than the empty string. |

Customer, Lead and CustomerIdentityLock explicitly disable both automatic index creation and automatic collection creation in every environment. Existing non-identity index definitions are retained, but these models no longer build them implicitly. Fresh environments require separately approved preparation of their pre-existing indexes too. Other models' existing startup behavior is unchanged.

Application startup performs read-only verification and logs readiness. It does not prepare indexes or stop the existing calling flow when identity indexes are unavailable. Every supported identity write is guarded by verification of all ten definitions and absence of the obsolete email constraint. Lead intake retains retry behavior if identity preparation is unavailable. Historical apply is rejected before writing when preparation is incomplete.

Verification checks ordered keys, uniqueness, exact partial filter, sparse/hidden/TTL flags and simple collation. An index still being built or in prepareUnique state is not ready. Equivalent correct definitions with historical names are accepted; reserved-name mismatches and incompatible additional unique constraints require operator review.

### Local-Only Runbook

Run from `suprah-backend`. Both commands connect only to `mongodb://127.0.0.1:27018/suprah_dev`, with autoIndex and autoCreate disabled. No environment files are edited.

Index-only preview, without an organization parameter or any database mutation:

```powershell
npx.cmd ts-node src/scripts/prepare-local-customer-identity-indexes.ts
```

After reviewing the local report, explicitly apply targeted index preparation:

```powershell
npx.cmd ts-node src/scripts/prepare-local-customer-identity-indexes.ts --apply
```

Only then preview a historical reconciliation page for an approved local fixture organization:

```powershell
npx.cmd ts-node src/scripts/reconcile-local-customer-links.ts --organization=ORG_OBJECT_ID
```

Apply a separately reviewed local reconciliation page, then continue using the returned cursor:

```powershell
npx.cmd ts-node src/scripts/reconcile-local-customer-links.ts --organization=ORG_OBJECT_ID --apply
npx.cmd ts-node src/scripts/reconcile-local-customer-links.ts --organization=ORG_OBJECT_ID --after=PREVIOUS_NEXT_CURSOR --apply
```

The old combined --prepare-indexes flag is rejected before connecting. Index preparation never invokes reconciliation, and reconciliation never creates/replaces indexes. Reconciliation preview remains read-only even if preparation is incomplete; apply requires completed preparation.

### Preparation Stages And Recovery

1. Inventory required and observed definitions, including missing/incorrect indexes and the recognized obsolete full email constraint.
2. Read-only data preflight: report duplicate included raw email/creation-key values, duplicate or invalid lock organizations, unsupported field types and non-simple collection collations. Samples are bounded; whitespace/empty-string values are reported as warnings and never silently rewritten.
3. Apply validates the preflight before performing any index change.
4. Create only missing manifest indexes, one at a time, verifying each immediately. Existing equivalent definitions are skipped. Missing namespaces may be created by explicit apply through their targeted index command, never by preview.
5. Verify all ten prerequisites, including the replacement email index.
6. Reverify prerequisites before removing only the specifically recognized obsolete full unique organization/email index.
7. Verify final readiness.

The preparation report includes a run ID, start time, dry-run flag, final readiness and each succeeded/failed step. The CLI also streams started/succeeded/failed events with the run ID, so operators can identify an interrupted step even if the process dies before its final report. Preserve this output in the approved operator log; report storage does not write maintenance state into the database.

Any step failure stops further work, returns structured failure output and causes a nonzero CLI exit. No automatic rollback or unrelated index drop occurs. Completed valid indexes remain. Rerunning re-inventories actual state and skips completed steps; conflicting definitions/data are never automatically removed or merged. In-progress builds must finish or receive explicit operator review before readiness can pass.

Missing/null/empty emails are excluded by the replacement partial filter. Whitespace-only nonempty strings are included; duplicates fail safely. Missing/null creation keys are excluded, but empty strings are included and must be unique within an organization. These existing business/security semantics were not changed. Normalized-contact indexes remain nonunique so historical duplicate people are reported by the identity resolver rather than rejected or guessed away.

Index preparation is collection-wide, not organization-scoped. Historical reconciliation remains organization-scoped. The local preflight timeout is bounded; a timeout stops apply rather than assuming data is clean.

### Authorized Deployment Checklist

No production access, inventory, migration or deployment has been performed. The provided CLI intentionally has no production mode; do not change its local safety guard to deploy.

1. Complete manual CRM QA and approve backup/restore, maintenance and rollback procedures.
2. An authorized operator must inventory actual index definitions, collection collation/types, MongoDB version/FCV/topology, duplicate-key risks and resource capacity. Validate coexistence of the old/replacement email indexes on the target version.
3. Use a controlled operator preparation based on the exact manifest. Ensure application auto-index policy is in place and pause affected identity writers; do not run mixed old/new identity writers.
4. Build/verify every prerequisite, then remove the recognized obsolete constraint only after all prerequisites succeed. Preserve unrelated ingestion, location, assignment, text/search and provenance indexes.
5. Deploy Phase 1, verify readiness, resume writers and smoke-test phone-only/email-only intake, tenant isolation and retry recovery.
6. Monitor duplicate-key failures, retry volume, DB load, replication and index-build completion. Index builds are not a zero-lock/zero-load operation.
7. Historical preview and separately approved paginated application follow index preparation. No historical backfill is needed to build these indexes.

Before new writes, rollback is simpler. After phone-only Customers or new links exist, do not blindly reinstall the old full email index or old binary: the index can fail on missing/null email, old Customer validation can reject new records, and the old lookup contains the tenant-scoping bug. Prefer a compatible rollback/fix retaining tenant isolation and new data. Any restore must preserve/account for activity written after the backup. There is no automatic migration undo or merge rollback in this phase.

### Immediately Before Coordinated Deployment

The operator must use separately authorized production tooling. Neither local CLI nor `prepareLocalCustomerIdentityIndexes` may be pointed at production, copied with its safety checks removed, or invoked as application startup migration.

1. Approve the release artifacts, backup/restore point, maintenance window and webhook/intake buffering procedure. Record the deployed versions and preserve index inventory and preflight output with a run identifier.
   The existing `main` push workflow builds and automatically deploys the API/FTP stack without an identity-index approval gate. Hold the production-triggering push/deploy until this sequence is authorized and the database gate is satisfied, or arrange an operator-controlled deployment hold. Preserve immutable rollback artifacts outside the workflow's image-pruning scope.
2. Inventory collection existence, MongoDB version/FCV/topology, simple collection/index collation, exact index definitions and ongoing index builds. Check duplicate included email and identityCreationKey values, missing/null/empty/whitespace values, invalid field types and duplicate/invalid organization lock keys. Reject conflicts; do not guess relationships or normalize historical records as part of preparation.
3. Quiesce all old identity writers, API/intake, Gmail/FTP workers and background identity/AI jobs under the approved maintenance procedure. Drain in-flight work. No old process may recreate the obsolete Customer index or keep running an older reply-dispatch path during cutover.
4. Through controlled targeted `createIndex` operations, build only missing indexes in `CUSTOMER_IDENTITY_INDEXES`, preserving their exact ordered keys, names, uniqueness and partial filters. Verify each completed step and preserve every unrelated index. Also verify the release's Lead ingestion/message-ID and IntakeClaim constraints, Location index, and required IVR/Recording/Session indexes; the ten-index identity manifest does not provision those.
5. Verify all ten prerequisite definitions against the release verifier. Only then drop the specifically recognized obsolete full unique `{ organizationId: 1, email: 1 }` constraint. Reverify that all prerequisites remain correct and no obsolete constraint remains. Stop on failure, keep successful steps, log the failing step and retry from fresh inventory; never run broad `syncIndexes` or automatic undo.
6. Install coordinated backend/frontend artifacts and dependencies, using actual production API environment values for the normal frontend build. Keep IVR/Recording policies disabled and their provider/legal activation gates unset. Confirm stored policy state and pending recovery/retention jobs through authorized inspection rather than assuming schema defaults override stored records.
7. Run the read-only `verifyCustomerIdentityIndexes()` from the deployed backend against the authorized connection and require `ready: true` before resuming writers. `/healthz` and `/readyz` alone do not establish identity readiness. If verification fails, keep the cutover closed; do not bypass write guards.
8. Resume intake/workers, test phone-only/email-only and repeat/concurrent linking, tenant isolation and retry recovery, then monitor index/duplicate errors, replication, DB load and queue/retry growth. Historical reconciliation is a later, separately authorized organization-scoped preview/apply operation, not a prerequisite backfill or an implicit deployment task.

Retain additive indexes and new relationship data when troubleshooting. Before rollback, assess new phone-only Customers, links and post-backup activity; do not automatically reinstall the old full unique email index or use the old tenant-unsafe identity resolver.

## Automated Verification

Results from deployment-hardening verification. All real-DB tests used only the approved local database, with external providers mocked:

| Check | Result |
| --- | --- |
| Backend TypeScript | Passed. |
| Frontend TypeScript, incremental disabled | Passed. |
| Selected mocked regression suites | 17 suites, 190 tests passed. |
| New identity real-DB suite | 30 tests passed with automatic indexing disabled. |
| New index migration real-DB suite | 47 tests passed from isolated pre-Phase-1 fixture states. |
| Stage 36 real-DB claim regressions | 3 tests passed. |
| Stage 41B real-DB regressions | 19 tests passed. |
| Call Recording real-DB regressions | 2 suites, 37 tests passed. |
| Total selected automated tests | 326 passed. |
| Focused frontend ESLint | Six existing `no-explicit-any` errors and one existing hook-dependency warning remain in `useCustomers.ts` / `useLeads.ts`. |
| Focused ESLint with existing `no-explicit-any` rule disabled | No errors; the existing hook warning remains. |
| Closeout whitespace check | Backend/frontend `git diff --check` passed; frontend emitted existing LF/CRLF warnings only. |

Real-DB verification used only `127.0.0.1:27018/suprah_dev`; provider calls were mocked. The identity suite exercises index preparation and reconciliation functions. The dedicated index CLI was also verified in read-only preview mode.

Tests cover tenant isolation, concurrent linking, repeated sync, multiple Leads per Customer, email-only/phone-only contacts, full-phone normalization, ambiguity/conflicts, safe contact edits, inactivity, stored-Lead API identity, historical preview/apply/rerun, provenance preservation, proxy exclusion, partial-write recovery and organization-scoped conversation updates. Existing Stage 36/41B/recording and selected AI, notes, source, location, booking and Gmail regressions are included. Mocked channel fixtures do not replace manual/provider intake QA.

Existing Jest forced-exit/open-handle and ts-jest deprecation warnings remain in applicable suites. No claim is made that the entire repository test suite or browser/PWA QA passed.

## Manual QA

Use only approved local fixtures and mocked/sandbox intake. Do not activate live IVR/recording or send live provider messages.

1. CRM -> Leads -> Add Lead: create a phone-only Lead, then an email-only Lead. Both should save without a fabricated second contact. Inspect the returned Lead/API state for `customerId` and `customerLink.status = linked`.
2. Add another legitimate Lead with differently formatted versions of the same valid full phone number. Verify the same Customer is reused and each Lead has its own single Customer transaction. Repeat sync; counts/transactions must not inflate.
3. Repeat with email case/whitespace variations. Add a Lead with both contacts matching the same Customer. Verify successful linking and non-destructive enrichment of missing contact fields.
4. In a separate local organization, use the same phone/email. Verify a different Customer is used and no cross-organization Lead, Customer or Conversation reference is assigned.
5. Seed local duplicate Customers or split email/phone evidence. Create the relevant Lead; verify `ambiguous`/`conflict`, recorded candidates/reason, and no new guessed relationship or moved activity. Similar names alone must not link.
6. Edit a linked Lead's contact to contradict its Customer. Verify conflict state and preserved existing history. Edit/deactivate the Customer; verify affected Leads revalidate. Try deleting a linked Customer; expect rejection.
7. Exercise ADF, Gmail, SMS, call, webchat, booking and website inquiry via local fixture/sandbox paths. Verify links and original source/location/assignment/appointments/messages. Vendor-only ADF email must not be treated as customer identity.
8. Simulate a resolver failure locally, then restore it. Verify the Lead still exists, shows retry state, and retries do not create extra Customers or transactions. Missing lock indexes must not allow unsafe unlocked synchronization.
9. Preview historical reconciliation as an admin. Verify no record changes, explicit conflict reporting, organization isolation and cursor pagination. Apply only reviewed local fixtures, rerun, and verify idempotency. Non-admin backfill requests must be denied.
10. Open Customers without explicitly applying historical reconciliation. Verify untouched historical Leads are not automatically backfilled.
11. Check desktop, tablet, narrow mobile and installed PWA Add Lead flows with either contact field. Verify validation, error handling and no layout overflow. The existing modal layout was retained; browser/PWA verification is still required.
12. Inspect representative notes, status/assignment history, appointments, messages, calls, AI/coaching history, campaigns and webchat before/after sync. IDs, ownership and content must remain unchanged except permitted empty Conversation Customer linking and Customer Lead transactions.

## Remaining Integrity Risks / Readiness

- A shared household phone or shared email is evidence, not guaranteed proof of one human. This phase never merges Lead records; later detection/review must retain staff confirmation and explain evidence.
- The lease plus guarded writes is not a multi-collection MongoDB transaction or a fully fenced distributed transaction. Long process pauses and writes that bypass the supported services remain concurrency risks; later merge work requires stronger transactional/concurrency design.
- Existing invalid contacts, duplicate Customers and contradictory provenance require explicit review. No UI for resolving these conflicts is included in Phase 1.
- Legacy Customer lookup scans unnormalized records within an organization under a timeout. Large historical datasets require measured rollout and normalization maintenance; timeout fails safely rather than choosing arbitrary early records.
- Existing appointment SMS confirmation/reschedule matching still contains last-ten-digit matching outside the Customer/Lead identity resolver. It was intentionally not redesigned here and must be assessed before merge-related reassignment work.
- Country-default assumptions, shared contacts, extensions and international inputs need representative business QA. Raw/bulk imports must opt into reconciliation explicitly.
- Missing/old indexes leave identity writes guarded/retrying until approved preparation completes. Local deployment preparation is verified; actual production readiness, data cleanliness and build performance remain unverified.

The foundation is implemented and suitable for separately approved Phase 2 research/detection-review work after manual QA and rollout/index decisions. It is **not approval or sufficient protection to enable Customer/Lead merging**. Merge transactions, rollback, dependent-reference migration and the review UI remain future scope.

## Files Changed In Phase 1

Backend (26 files including this document):

- `package.json`, `package-lock.json`: validated phone normalization dependency.
- `src/models/Customer.model.ts`, `src/models/lead.model.ts`, `src/models/CustomerIdentityLock.model.ts`: identity fields, linking state, persistence hooks and indexes.
- `src/utils/contactIdentity.ts`: shared full-phone/email normalization.
- `src/services/customerIdentity.service.ts`, `src/services/customerIdentityLock.service.ts`, `src/services/customerIdentityMaintenance.service.ts`: matching/linking, organization lease, historical reporting and local index preparation.
- `src/services/customer.service.ts`: safe Customer create/reuse/edit/delete and stored-Lead synchronization.
- `src/services/communication.service.ts`: organization-scoped full-phone lookup and verified Customer references in new SMS/call intake.
- `src/services/orgGmail.service.ts`: organization-scoped intake user and actual customer contact identity.
- `src/controllers/customer.controller.ts`, `src/controllers/lead.controller.ts`, `src/routes/customer.route.ts`: contact validation, relationship responses, runtime sync and admin historical reports.
- `src/server.ts`: bounded identity retry timer and shutdown cleanup.
- `src/scripts/reconcile-local-customer-links.ts`: fixed local-only preview/apply CLI.
- `jest.identity.config.js`, `tests/customerIdentity.local.setup.ts`, `tests/customerIdentity.realdb.test.ts`, `tests/unit/customerIdentity.test.ts`: identity verification and local-DB safety.
- `tests/unit/leadClaim.communication.test.ts`, `tests/unit/orgGmailSync.dedup.test.ts`: updated scoped mocks and intake regressions.
- `tests/ivr.realdb.test.ts`, `tests/leadClaim.realdb.test.ts`: cleanup of identity fixtures belonging to test organizations only; no parked feature behavior change.
- `docs/contact-lead-integrity-phase1.md`: scope/status, verification, local runbook, limitations and manual QA.

Frontend (4 files):

- `src/components/leads/AddLeadModal.tsx`: first name plus either email or phone validation and typed error handling.
- `src/types/lead.ts`, `src/hooks/useLeads.ts`: optional Customer relationship/link-state types.
- `src/hooks/useCustomers.ts`: reconciliation report/options types for the existing hook; no new duplicate/merge UI.

No tray changes, environment edits, manual service-worker regeneration, live provider calls, production DB access, or git state/history operations were performed for this phase.

## Deployment Hardening Files

This follow-up changes only 16 backend files; there are no frontend, tray, parked IVR or Call Recording functional changes:

- `src/constants/customerIdentityIndexes.ts`: shared exact manifest and no-auto-DDL model policy.
- `src/services/customerIdentityIndexes.service.ts`: read-only inventory, exact verification and write-readiness assertion.
- `src/services/customerIdentityMaintenance.service.ts`: staged targeted local-only preparation, data preflight and structured recovery output.
- `src/services/customerIdentityLock.service.ts`: complete readiness check before supported identity writes.
- `src/services/customerIdentity.service.ts`: historical apply requires preparation; no implicit migration.
- `src/models/Customer.model.ts`, `src/models/lead.model.ts`, `src/models/CustomerIdentityLock.model.ts`: explicit autoIndex/autoCreate policy and shared declarations.
- `src/config/db.ts`: read-only startup readiness logging; calling availability is preserved.
- `src/scripts/prepare-local-customer-identity-indexes.ts`: dedicated index-only preview/apply command.
- `src/scripts/reconcile-local-customer-links.ts`: separate historical command, combined preparation rejected, automatic DDL disabled.
- `tests/customerIdentity.local.setup.ts`: fixed local connection with automatic DDL disabled.
- `jest.identity-indexes.config.js`, `tests/customerIdentityIndexes.realdb.test.ts`: isolated realistic migration states, failures/restarts, zero-write preview and application gating.
- `tests/unit/customerIdentityIndexes.test.ts`: mocked/pure manifest and property verification tests.
- `docs/contact-lead-integrity-phase1.md`: final status, manifest, runbook, evidence and deployment limitations.
