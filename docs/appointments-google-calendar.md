# Appointments & Google Calendar Integration

This document covers all uncommitted changes on the `push-notif` branch related to appointment management, CRM user Google Calendar OAuth, and the bi-directional sync engine.

---

## 1. Overview

### What was added

Two major features were implemented together:

1. **CRM User personal Google Calendar integration** — each CRM user can independently connect their own Google account, grant calendar access, and have their appointments synced in both directions.
2. **Enhanced appointment management** — full CRUD lifecycle for appointments, customer bookings, guest RSVP via email token, and activity/notification side-effects at every step.

### Data flow

```
CRM User                    Backend                         Google Calendar
   │                           │                                    │
   │── GET /crm-calendar/auth ─▶│ generate OAuth URL                 │
   │◀─ { url } ───────────────│                                    │
   │── redirect to Google ─────────────────────────────────────────▶│
   │◀─ redirect /callback ─────────────────────────────────────────│
   │                           │── store encrypted tokens in CrmUser │
   │                           │── syncCrmUserCalendar() ───────────▶│ (background)
   │                           │◀─ events ─────────────────────────│
   │                           │── bulkWrite → Appointment docs      │
   │                           │                                    │
   │── create appointment ────▶│── syncAppointmentToGoogleCalendar ─▶│ (outbound)
   │                           │── send invitation emails            │
   │                           │── notify participants               │
   │                           │── transition lead status            │
   │                           │                                    │
   │                  webhook ─▶│── processWebhookNotification()     │
   │                   (200 OK)│   (background, non-blocking)        │
```

---

## 2. Data Model — `CrmUser` Changes

**File:** [src/models/CrmUser.model.ts](../src/models/CrmUser.model.ts)

### New field: `googleCalendar`

A new optional nested object was added to both the `ICrmUser` TypeScript interface and the Mongoose schema:

```ts
googleCalendar?: {
  calendarConnected: boolean;   // default: false
  gmailAddress?:     string;    // Google account email after OAuth
  accessToken?:      string;    // AES-encrypted access token
  refreshToken?:     string;    // AES-encrypted refresh token
  expiryDate?:       number;    // Token expiry as Unix timestamp (ms)
  lastSyncAt?:       Date;      // Timestamp of most recent sync
  syncToken?:        string;    // Google incremental sync token
}
```

All sensitive token fields are encrypted at rest via `encrypt()` / `decrypt()` from `src/utils/crypto.ts` — they are never stored in plaintext.

### Full schema reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `organizationId` | ObjectId → Organization | — | Optional for legacy records |
| `fullName` | String | — | Required, trimmed |
| `username` | String | — | Required; unique per org (compound index) |
| `email` | String | — | Required, unique globally, lowercase |
| `password` | String | — | `select: false` — never returned by default; bcrypt-hashed on save |
| `avatar` | String | `null` | Optional |
| `role` | `'employee' \| 'manager' \| 'admin'` | `'employee'` | |
| `isActive` | Boolean | `true` | |
| `lastLoginAt` | Date | `null` | |
| `resetOtp` | String | — | `select: false` |
| `resetOtpExpiry` | Date | — | `select: false` |
| `googleCalendar` | Object | — | See above; added in this branch |
| `createdAt` | Date | auto | Mongoose timestamps |
| `updatedAt` | Date | auto | Mongoose timestamps |

### Indexes

```ts
// Username unique per organization
CrmUserSchema.index({ organizationId: 1, username: 1 }, { unique: true });
```

### Methods

**Static — `isUsernameTaken(username, organizationId, excludeId?)`**
Checks if a username is already in use within the given organization. Pass `excludeId` to skip a specific document (used during updates).

**Instance — `isPasswordMatch(password: string): Promise<boolean>`**
Compares a plaintext password against the stored bcrypt hash.

**Pre-save hook**
Automatically hashes `password` with bcrypt (12 salt rounds) when the field is modified before saving.

---

## 3. CRM Calendar Routes & Controller

### Routes

**File:** [src/routes/crmCalendar.routes.ts](../src/routes/crmCalendar.routes.ts)

| Method | Path | Auth | Handler |
|---|---|---|---|
| `GET` | `/callback` | None (public) | `crmCalendarController.callback` |
| `GET` | `/auth` | `crmAuth()` | `crmCalendarController.connect` |
| `GET` | `/status` | `crmAuth()` | `crmCalendarController.getStatus` |
| `POST` | `/sync` | `crmAuth()` | `crmCalendarController.sync` |
| `POST` | `/disconnect` | `crmAuth()` | `crmCalendarController.disconnect` |

`/callback` is intentionally public — Google's OAuth redirect won't carry the CRM auth token.

All other routes apply `crmAuth()` middleware (which validates a separate CRM JWT using `CRM_JWT_SECRET`) and expose `req.crmUser` to the handlers.

---

### Controller

**File:** [src/controllers/crmCalendar.controller.ts](../src/controllers/crmCalendar.controller.ts)

OAuth scopes requested:
- `https://www.googleapis.com/auth/calendar.events`
- `https://www.googleapis.com/auth/calendar.readonly`

---

#### `connect` — GET `/auth`

Initiates the Google OAuth2 flow.

- Reads `req.crmUser._id` and encodes it as the `state` parameter so the CRM user identity survives the redirect round-trip.
- Uses `access_type: 'offline'` and `prompt: 'consent'` to guarantee a refresh token is issued.
- Returns `{ url: string }` — the client redirects the browser to this URL.

---

#### `callback` — GET `/callback`

Handles the Google OAuth redirect. **Public route.**

1. Validates `code` and `state` query parameters (400 if missing).
2. Exchanges `code` for tokens via `oauth2Client.getToken()`.
3. Fetches the connected Google account email via `google.oauth2.userinfo.get()`.
4. Persists to `CrmUser.googleCalendar`:
   - `calendarConnected: true`
   - `gmailAddress` from userinfo
   - `accessToken` — encrypted
   - `refreshToken` — encrypted (if returned; Google only returns it on first consent)
   - `expiryDate` from token metadata
   - `lastSyncAt: new Date()`
5. Fires `googleCalendarService.syncCrmUserCalendar(crmUserId)` asynchronously in the background — errors are logged but do not block the response.
6. Redirects the browser to `${FRONTEND_URL}/crm/settings?calendar=connected`.

---

#### `sync` — POST `/sync`

Manually triggers a full calendar sync.

- Calls `googleCalendarService.syncCrmUserCalendar(crmUserId)`.
- Returns `{ success: true, message: "Synced N events", count: number }`.

---

#### `disconnect` — POST `/disconnect`

Removes the calendar connection.

- Calls `googleCalendarService.disconnectCalendar(crmUserId)`, which sets `googleCalendar.calendarConnected = false` in the database.
- Returns `{ success: true, message: "Calendar disconnected" }`.

---

#### `getStatus` — GET `/status`

Returns the current calendar connection state.

- Fetches `CrmUser` with `.select('googleCalendar')` (projection — no tokens leaked).
- Returns:
  ```json
  {
    "connected": true,
    "email": "user@gmail.com",
    "lastSyncAt": "2026-04-30T00:00:00.000Z"
  }
  ```

---

## 4. Appointment Service

**File:** [src/services/appointment.service.ts](../src/services/appointment.service.ts)

### `CreateAppointmentData` interface

```ts
interface CreateAppointmentData {
  title:          string;
  description?:   string;
  startTime:      Date;
  endTime:        Date;
  location?:      string;
  type:           'in-person' | 'phone' | 'video' | 'other';
  entryType:      'event' | 'task' | 'reminder' | 'appointment';
  participants:   string[];           // user IDs
  guestEmails?:   string[];           // external email addresses
  customerBooking?: {
    isCustomerBooking: boolean;
    firstName:         string;
    lastName:          string;
    email:             string;
    phone:             string;
  };
  vehicleId?:     string;
  quoteId?:       string;
  shipmentId?:    string;
  meetingLink?:   string;
  notes?:         string;
}
```

---

### Helper: `resolveCalendarTarget(userId, orgId)`

Determines whether to sync to an org-level calendar or a CRM user's personal calendar:

```ts
const resolveCalendarTarget = async (userId: string, orgId: string) => {
  const isCrmUser = await CrmUser.exists({ _id: userId });
  if (isCrmUser) return { type: 'crmUser', id: userId };
  return { type: 'org', id: orgId };
};
```

Returns `{ type: 'org' | 'crmUser', id: string }` — the polymorphic target used by `GoogleCalendarService`.

---

### Helper: `safeObjectId(id)`

Safely casts a string to `mongoose.Types.ObjectId` without throwing. Falls back to the raw string if the input is not a valid ObjectId. Used to avoid Mongoose cast errors on filter queries.

---

### `createAppointment(userId, orgId, data)`

**Business rules:**
- `endTime` must be after `startTime` — throws 400 otherwise.
- `startTime` must be in the future — throws 400 otherwise.
- **Intelligent Conflict Detection**: The system checks for overlapping events on the user's Google Calendar. It intelligently ignores "All-Day" events (spanning >23 hours) and events marked as "transparent" (Free), preventing false-positive double-booking errors.
- **Polymorphic Identity Support**: All operations (Create, Update, Delete) are identity-agnostic, resolving the correct `User` or `CrmUser` context based on `orgId` and session data.
- **Terminal Status Validation**: Mandatory `outcomeNotes` are required when updating an appointment to terminal statuses (`completed`, `no-show`).
- `participants` array is deduplicated; creator's ID is always included.
- `guestEmails` are normalized to lowercase/trimmed and stored with `status: 'pending'`.

**Side effects (in order):**
1. Persists the `Appointment` document.
2. Resolves calendar target via `resolveCalendarTarget` and calls `googleCalendarService.syncAppointmentToGoogleCalendar()`. Failure is caught and logged, not thrown.
3. If `customerBooking.isCustomerBooking = true`, sends a JWT-signed invitation email (30-day TTL) to the customer via `emailService.sendAppointmentInvitation()`.
4. Sends invitation emails to all `guestEmails` via `Promise.allSettled` (partial failure doesn't abort).
5. Creates in-app notifications for all participants except the creator.
6. Calls `customerBookingService.updateBookingHistory()` if it's a customer booking.
7. **Automated Lead Transition**: If a lead is associated with the appointment (either via `leadId` or a matching customer email), the backend automatically transitions the lead to the `'Appointment Set'` status and broadcasts the update via Socket.io.
8. **Email Sync**: Sends a rich ICS invitation with automated RSVP tracking to all guests and the customer.

**Returns:** Populated appointment document (`participants`, `createdBy` with `name email avatar`).

---

### `getUserAppointments(userId, orgId, options)`

```ts
options: {
  status?:                  string;
  entryType?:               string;
  startDate?:               Date;
  endDate?:                 Date;
  limit?:                   number;   // default: 2500
  skip?:                    number;   // default: 0
  includeCustomerBookings?: boolean;
  customerBookingsOnly?:    boolean;
}
```

Scoped to `organizationId` + user as participant. Supports date-range filtering on `startTime`. Returns `{ appointments, total }`.

---

### `getCustomerBookings(userId, orgId, options)`

Fetches only appointments where `customerBooking.isCustomerBooking = true`. Sorted by `startTime` descending. Supports `startDate`, `endDate`, and `status` filters.

---

### `getAppointmentById(appointmentId, orgId, userId)`

Fetches a single appointment with full population (`participants`, `createdBy`, `vehicleId`, `quoteId`, `shipmentId`). Throws 403 if the requesting user is neither the creator nor a participant.

---

### `updateAppointment(appointmentId, orgId, userId, updateData)`

**Permission rules:**
- Creator or any participant can update basic fields.
- Only the creator can modify `participants` or `guestEmails` — throws 403 otherwise.

**Side effects:**
1. Saves the appointment.
2. Syncs changes to Google Calendar via `syncAppointmentToGoogleCalendar`.
3. Notifies all participants (except the updater).
4. Sends update emails to all `guestEmails` and the customer booking email via `Promise.allSettled`.

---

### `cancelAppointment(appointmentId, orgId, userId)`

**Permission:** Creator only — throws 403 otherwise.

**Side effects:**
1. Sets `status = 'cancelled'` and saves.
2. If `googleCalendarEventId` exists, deletes the event from Google Calendar via `deleteFromGoogleCalendar`.
3. Notifies all participants.
4. Sends cancellation emails to all guest emails and the customer booking email.

---

### `deleteAppointment(appointmentId, orgId, userId)`

**Permission:** Creator only — throws 403 otherwise.

Permanently removes the record. Same Google Calendar deletion and email side-effects as `cancelAppointment`. Does **not** send internal notifications (the record is gone).

---

### `handleGuestResponse(appointmentId, token, status, googleAccessToken?)`

Processes a guest's RSVP from an email link.

1. Verifies the JWT token (`JWT_SECRET`, 30-day TTL). Throws 403 on invalid/expired token.
2. Confirms `decoded.appointmentId` matches the route parameter.
3. Finds the guest entry in `appointment.guestEmails` by `decoded.email`. Throws 404 if not found.
4. Sets `guest.status = status` and `guest.respondedAt = new Date()`.
5. If `status === 'accepted'` and `googleAccessToken` is provided, syncs the appointment to the guest's personal Google Calendar and stores the returned event ID on the guest subdocument.
6. Saves and creates an in-app notification for the appointment creator.

---

### `removeDuplicateAppointments()`

Cleanup utility. Aggregates appointments by `googleCalendarEventId`, finds groups with `count > 1`, keeps the earliest, and deletes the rest. Returns the count of removed documents.

---

## 5. Appointment Controller

**File:** [src/controllers/appointment.controller.ts](../src/controllers/appointment.controller.ts)

All handlers use `asyncHandler` for automatic async error propagation and return `ApiResponse`-wrapped JSON.

| Handler | Method | Notes |
|---|---|---|
| `createAppointment` | POST | Duplicate customer booking check before service call; notifies org admins; logs activity |
| `getAppointments` | GET | Query params: `status`, `entryType`, `startDate`, `endDate`, `limit`, `skip`, `includeCustomerBookings` |
| `getCustomerBookings` | GET | Query params: `startDate`, `endDate`, `status` |
| `getCustomerHistory` | GET | Query params: `email`, `phone`, `firstName`, `lastName` — delegates to `customerBookingService` |
| `getDateStatistics` | GET | Requires `date` query param; delegates to `customerBookingService.getDateStatistics` |
| `syncWithGoogleCalendar` | POST | Triggers `googleCalendarService.syncAllEvents(orgId, userId)` |
| `getAppointmentById` | GET | URL param: `id` |
| `updateAppointment` | PUT | Duplicate customer booking check; notifies org admins; logs activity |
| `cancelAppointment` | PUT | Notifies org admins; logs activity at `logger.warn` level |
| `deleteAppointment` | DELETE | Notifies org admins; logs activity at `logger.warn` level |
| `handleGuestResponse` | POST | Body: `{ token, status, googleAccessToken? }`; validates `status` ∈ `{accepted, declined}` |
| `getAppointmentStats` | GET | Computed in-memory from `getUserAppointments`; no extra DB query |

### `getAppointmentStats` response shape

```json
{
  "total": 42,
  "upcoming": 10,
  "past": 25,
  "cancelled": 5,
  "completed": 2,
  "customerBookings": 8,
  "byType": {
    "appointment": 20,
    "event": 12,
    "task": 6,
    "reminder": 4
  },
  "byStatus": {
    "scheduled": 30,
    "confirmed": 5,
    "cancelled": 5,
    "completed": 2
  }
}
```

### Notification side-effects per handler

| Handler | Template | Recipients |
|---|---|---|
| `createAppointment` | `appointment_created` | Org admins (via `notifyOrgAdmins`) |
| `updateAppointment` | `appointment_updated` | Org admins |
| `cancelAppointment` | `appointment_cancelled` | Org admins |
| `deleteAppointment` | `appointment_cancelled` | Org admins |
| `handleGuestResponse` | `guest_response` | Appointment creator (`safeCreateNotification`) |

All handlers also write an activity log entry via `activityService.createActivity`.

---

## 6. Google Calendar Service

**File:** [src/services/googleCalendar.service.ts](../src/services/googleCalendar.service.ts)

Exported as a singleton: `export default new GoogleCalendarService()`.

### Polymorphic `target` pattern

All methods that touch Google Calendar accept:
```ts
target: { type: 'org' | 'crmUser'; id: string }
```
- `type: 'org'` — reads tokens from `OrgLeadConfig` (keyed by `organizationId`)
- `type: 'crmUser'` — reads tokens from `CrmUser.googleCalendar`

This lets a single service handle both the organization-level calendar and individual CRM user calendars.

---

### `getCalendarClient(target)` (private)

Core authentication method. For each call:
1. Loads the relevant config document.
2. Decrypts `accessToken` and `refreshToken` via `decrypt()`.
3. Instantiates an OAuth2 client and calls `setCredentials()`.
4. Registers a `'tokens'` event listener — when Google issues new tokens during a refresh, they are encrypted and saved back to the database automatically.
5. Returns an authenticated `calendar_v3.Calendar` client.

Throws 401 if `calendarConnected` is false or tokens are missing.

---

### Conflict Detection Logic

The service implements `checkUserAvailability(userId, orgId, startTime, endTime, appointmentId?)` to prevent double-booking.

**Refined Rules:**
- **Ignores All-Day Events**: Any Google Calendar event with a duration > 23 hours is treated as a background event (e.g., birthdays, holidays) and does not block scheduling.
- **Ignores Transparent Events**: Events marked as `transparent` (Free) in Google Calendar are ignored.
- **Supports Partial Overlap**: Only strictly `opaque` (Busy) events that overlap with the requested time-slot will trigger a 409 Conflict.

---

### Inbound Sync Pipeline Updates

The inbound sync has been hardened to handle cross-collection identities:
- Correctly resolves `CrmUser` or `User` for `createdBy` attribution.
- Supports polymorphic `refPath` for participants.
- Automatically handles Gmail token refreshes via the `'tokens'` event listener.

---

### Sync window

```ts
// 3 months back → 6 months forward (rolling 9-month window)
function getSyncWindow(): { timeMin: Date; timeMax: Date }
```

All full scans are bounded to this window to keep sync fast and dataset small.

---

### `fetchAllEventsFromGoogle(calendar, timeMin?, timeMax?, syncToken?)` (private)

Paginated event fetch from Google Calendar API (`primary` calendar):
- Up to `MAX_PAGES = 5` pages × 2,500 results = 12,500 max events per sync.
- If `syncToken` is provided, uses incremental mode (returns only changed events since last sync).
- Otherwise uses date-range mode (`timeMin`/`timeMax`, `singleEvents: true`, `showDeleted: true`).
- Returns `{ items: Event[], nextSyncToken }`.

---

### `parseEventTimes(event)` (private)

Safely parses a Google Calendar event's start/end times:
- Detects all-day events (`event.start.date` present, `event.start.dateTime` absent) and converts to UTC midnight / end-of-day boundaries.
- Returns `{ startTime: Date, endTime: Date }` or `null` if either value is missing or invalid.

---

### `syncInternal(target, triggeringUserId?)` (private) — Core sync engine

Full inbound sync pipeline:

**Step 1 — Resolve identity**
- `org`: finds an active admin user for attribution.
- `crmUser`: reads the CRM user directly; picks up their stored `syncToken`.

**Step 2 — Fetch from Google**
- Calls `fetchAllEventsFromGoogle` with the stored `syncToken` for incremental sync.
- On HTTP 410 (token expired/invalidated): discards token, falls back to full scan.
- On HTTP 403 (insufficient permissions): calls `markDisconnected(target)` and throws 403.

**Step 3 — Process events**
- Splits events into `validEvents` (status ≠ `'cancelled'`) and `cancelledIds`.
- Bulk-cancels matching appointments: `Appointment.updateMany({ googleCalendarEventId: $in cancelledIds })`.
- For valid events, infers `entryType` from the event title (keyword matching: `task`, `reminder`, `appointment`, else `event`).
- Infers `type` from `hangoutLink`/`conferenceData` → `'video'`, `location` → `'in-person'`, else `'other'`.
- Builds a `bulkWrite` operation array:
  - **Existing** (matched by `googleCalendarEventId`): `updateOne` with title, description, times, location, meetingLink, `lastSyncedAt`.
  - **New**: `insertOne` with all fields including `createdBy: userIdForAttribution`, `organizationId`, `syncedWithGoogleCalendar: true`.
- Executes `Appointment.bulkWrite(ops, { ordered: false })` for performance.

**Step 4 — Persist sync state**
- Saves `nextSyncToken` and `lastSyncAt` back to the config document for the next incremental sync.

Returns the count of inserted + modified appointments.

---

### `syncAllEvents(orgId, triggeringUserId?)`: `Promise<number>`

Public wrapper — calls `syncInternal({ type: 'org', id: orgId })`.

### `syncCrmUserCalendar(crmUserId)`: `Promise<number>`

Public wrapper — calls `syncInternal({ type: 'crmUser', id: crmUserId })`.

---

### `syncAppointmentToGoogleCalendar(appointment, target)`: `Promise<string | null>`

Outbound sync — pushes an appointment to Google Calendar:
- If `appointment.googleCalendarEventId` exists: calls `events.update()`.
- Otherwise: calls `events.insert()` and saves the returned event ID back to the appointment document (`Appointment.findByIdAndUpdate`).

Returns the Google event ID, or `null` on failure (failure is logged, not thrown — callers tolerate this).

The event description is built by `buildEventDescription()`:
```
<appointment.description>

--- Appointment Details ---
Type: <entryType>
Meeting Type: <type>
Join Meeting: <meetingLink>   ← only if present
```

---

### `deleteFromGoogleCalendar(eventId, target)`: `Promise<void>`

Calls `calendar.events.delete()`. Errors are caught and logged only — never thrown.

---

### `markDisconnected(target)` (private)

Sets `calendarConnected = false` in the relevant config document. Called automatically when a 403 is detected during sync.

---

### `disconnectCalendar(crmUserId)`: `Promise<void>`

Sets `CrmUser.googleCalendar.calendarConnected = false`. Called by the disconnect controller endpoint.

---

### `setupWebhook(target, channelId)`: `Promise<void>`

Registers a Google Calendar push webhook pointing to `${BACKEND_URL}/api/crm-calendar/webhook`. Errors are logged but not thrown.

### `processWebhookNotification(channelId, resourceState, resourceId)`: `Promise<void>`

Stub — logs the channel ID. Full processing logic to be implemented.

### `updateRSVPStatusFromGoogle(appointmentId, target)`: `Promise<void>`

Fetches the Google Calendar event for an appointment and saves the document. RSVP mapping logic is a placeholder for future extension.

---

## 7. Google Calendar Controller

**File:** [src/controllers/googleCalendar.controller.ts](../src/controllers/googleCalendar.controller.ts)

Handles the **org-level** Google Calendar connection (as opposed to the CRM-user-level `crmCalendar` controller).

| Handler | Route | Access |
|---|---|---|
| `getStatus` | `GET /api/google-calendar/status` | Private |
| `disconnect` | `POST /api/google-calendar/disconnect` | Private |
| `handleWebhook` | `POST /api/google-calendar/webhook` | Public |
| `syncRSVPStatus` | `POST /api/google-calendar/sync-rsvp/:appointmentId` | Private |
| `syncEvents` | `POST /api/google-calendar/sync-events` | Private |

---

#### `getStatus`

Calls `googleCalendarService.isGoogleCalendarConnected(userId)`. Returns `{ connected: boolean }`.

---

#### `disconnect`

Calls `googleCalendarService.disconnectCalendar(userId)`. Returns 200 on success.

---

#### `handleWebhook`

Processes Google Calendar push notifications. Implements the **fast-acknowledge pattern**:

1. Reads headers: `x-goog-channel-id`, `x-goog-resource-state`, `x-goog-resource-id`, `x-goog-channel-expiration`.
2. If `resourceState === 'sync'` (initial handshake): responds `200 OK` immediately.
3. If `resourceState === 'exists'` (change notification): fires `googleCalendarService.processWebhookNotification()` in the background (`.catch()` to log errors), then responds `200 OK` immediately without waiting.

This ensures Google's delivery timeout is never exceeded, regardless of how long processing takes.

---

#### `syncRSVPStatus`

Manually triggers RSVP sync for a specific appointment. Builds target `{ type: 'org', id: orgId }` from the requesting user's org and calls `googleCalendarService.updateRSVPStatusFromGoogle(appointmentId, target)`. Returns 200.

---

#### `syncEvents`

Triggers a full paginated inbound sync for the requesting user's organization. Calls `googleCalendarService.syncAllEvents(orgId, userId)`. Returns `{ syncedAppointments: number }`.

---

## 8. Integration Points & Cross-Cutting Concerns

### Token encryption

All Google OAuth tokens are encrypted with AES before storage using `encrypt()` / `decrypt()` from `src/utils/crypto.ts`. Tokens are never written to or read from the database in plaintext.

### Auto-refresh

The OAuth2 client registered in `getCalendarClient` listens for the `'tokens'` event. When Google issues new credentials during a silent refresh, they are automatically encrypted and persisted — no manual refresh management needed.

### Multi-tenancy

Every appointment query is scoped to `organizationId`. The `createdBy` filter in sync operations ensures that events imported for one CRM user do not appear in another user's or org's appointment list.

### Async error handling

All controller functions are wrapped with `asyncHandler` from `src/utils/asyncHandler.ts`. Service-layer errors use `ApiError` instances, which are caught and formatted by the global error middleware in `src/middleware/error.middleware.ts`.

### Socket.io real-time updates

When an appointment creates a customer booking and a matching lead is found, the lead's status is updated to `'Appointment Set'` and the change is broadcast immediately via `io.to('org:<orgId>').emit('lead:update', updatedLead)` using `getSocketIO()` from `src/utils/socketEmitter.ts`.

### Email delivery

All guest/customer invitation and cancellation emails are sent with `Promise.allSettled` — partial delivery failures are logged but do not fail the overall operation.

### Activity logging

Every create, update, cancel, and delete action writes an entry to the activity log via `activityService.createActivity`. This provides a full audit trail with `type`, `title`, `description`, and `metadata` (including `appointmentId`).

### Environment variables used

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth2 app client ID |
| `GOOGLE_CLIENT_SECRET` | OAuth2 app client secret |
| `GOOGLE_REDIRECT_URI` | Callback URL registered in Google Cloud Console |
| `FRONTEND_URL` | Post-OAuth redirect destination |
| `BACKEND_URL` | Used to construct the webhook registration URL |
| `JWT_SECRET` | Signs and verifies guest RSVP invitation tokens |
