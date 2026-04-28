# Push Notifications

## Overview

The push notification feature delivers real-time browser/PWA notifications to users even when they do not have the application open. It is built on the **Web Push Protocol** (RFC 8030) and **VAPID** authentication, using the `web-push` npm package to communicate with browser push vendors (Chrome/FCM, Firefox, Safari/APNs).

Every meaningful action in the system — a new shipment assignment, a payment received, a driver join request — can trigger a push notification that appears in the OS notification tray. The system is integrated with the Socket.IO real-time layer: Socket.IO delivers in-app notifications to open browser tabs while the push layer covers offline or backgrounded devices.

Key capabilities:

- Per-user device subscription management (multiple devices per user)
- Preference-gated delivery: notifications are suppressed if the user has disabled the relevant category in their account settings
- Interactive notifications: `driver_request` notifications render Approve/Reject action buttons in the OS tray
- Cross-device dismiss sync: marking a notification as read sends a silent push to all of the user's other devices to dismiss the matching OS notification
- Role-targeted broadcast from admin UI or internal services
- Background queue processing via BullMQ to keep HTTP response times unaffected by push delivery latency
- Self-healing: expired or invalid push endpoints (HTTP 410/404 from the vendor) are pruned from the database automatically

---

## Architecture

### Component Map

```
Other services / event triggers
         |
         v
NotificationService.createNotification()
  |                         |
  | 1. Persist to MongoDB   | 2. Fire-and-forget
  |    (Notification doc)   |
  v                         v
Socket.IO emitToUser()   PushService.send() / .broadcast()
(in-app, live tab)            |
                              | adds job(s) to Redis
                              v
                       BullMQ Queue: "push-notifications"
                              |
                              | Worker picks up job
                              v
                         PushWorker
                              |
                   reads User.pushSubscriptions
                              |
                   for each subscription:
                       web-push.sendNotification()
                              |
                    +-------------------+
                    |  Browser Vendor   |
                    | (FCM / Firefox /  |
                    |  Safari APNs)     |
                    +-------------------+
                              |
                    Push delivered to device
                    (even if app is closed)
```

### Data Flow Summary

1. A business event (e.g. shipment assigned) calls `NotificationService.createNotification()`.
2. The service writes a `Notification` document to MongoDB and checks the user's `notificationPreferences` — if the category is disabled, it stops here.
3. Simultaneously, `emitToUser()` broadcasts the event on the Socket.IO namespace so any open browser tab updates immediately.
4. `PushService.send()` enqueues a `send-push` job in the BullMQ `push-notifications` queue. This is non-blocking — the HTTP response returns before any push is sent.
5. `PushWorker` picks up the job, loads the user's stored `pushSubscriptions` from MongoDB, and calls `webpush.sendNotification()` for each subscription in parallel.
6. If a vendor responds with HTTP 410 (Gone) or 404 (Not Found), the worker removes that endpoint from the user's document (self-healing).
7. When the user reads a notification, `NotificationService.markAsRead()` enqueues a silent "dismiss" push so other devices can close the OS-level notification via service-worker logic.

---

## Directory Structure

```
src/
  models/
    Notification.model.ts     Mongoose schema for persisted notification records
  services/
    notification.service.ts   Business logic: create, read, mark-read, broadcast, cleanup
    push.service.ts            Thin facade over BullMQ — queues jobs, never calls web-push directly
  jobs/
    push.queue.ts              BullMQ Queue definition and shared Redis connection config
    push.worker.ts             BullMQ Worker — actual web-push delivery and subscription pruning
  controllers/
    notification.controller.ts HTTP handlers for the in-app notification inbox
    push.controller.ts         HTTP handlers for device subscribe / unsubscribe / admin broadcast
  routes/
    notification.route.ts      Mounts under /api/notifications
    push.route.ts              Mounts under /api/push
```

---

## Data Model

### Notification (`src/models/Notification.model.ts`)

Persisted notification records form the in-app inbox. Each record belongs to one user within one organization.

| Field            | Type                  | Required | Default | Description |
|------------------|-----------------------|----------|---------|-------------|
| `userId`         | ObjectId (ref: User)  | No       | —       | The recipient user. Null/absent on legacy broadcast-only docs. |
| `organizationId` | String                | Yes      | —       | String identifier of the tenant organization. |
| `orgId`          | ObjectId (ref: Org)   | No       | —       | ObjectId reference to the Organization document (parallel to `organizationId`). |
| `roleTargets`    | String[]              | No       | `[]`    | Roles this notification targets. Used for broadcast queries. Enum: `user`, `admin`, `driver`, `super_admin`, `dealer`, `customer`. |
| `isBroadcast`    | Boolean               | No       | `false` | True when the notification was sent to multiple users simultaneously. |
| `type`           | String (enum)         | Yes      | —       | Event type. See the full enum list in the Notification Types section below. |
| `title`          | String                | Yes      | —       | Short notification headline. Max 200 characters (enforced in service). |
| `message`        | String                | Yes      | —       | Full notification body. Max 1000 characters (enforced in service). |
| `metadata`       | Mixed                 | No       | `{}`    | Arbitrary payload (e.g. `{ driverRequestId, shipmentId }`). |
| `isRead`         | Boolean               | No       | `false` | Whether the user has read this notification. |
| `createdAt`      | Date                  | Auto     | —       | Managed by Mongoose `timestamps`. |
| `updatedAt`      | Date                  | Auto     | —       | Managed by Mongoose `timestamps`. |

**TTL**: MongoDB automatically deletes notification documents 90 days (7,776,000 seconds) after `createdAt`.

**Indexes**:

| Index | Purpose |
|-------|---------|
| `userId` (single) | Fast per-user lookups |
| `organizationId` (single) | Org-level queries |
| `orgId` (single) | Organization reference joins |
| `isBroadcast` (single) | Filter broadcast vs. personal |
| `isRead` (single) | Unread count queries |
| `{ userId, createdAt: -1 }` | Paginated inbox fetch |
| `{ userId, isRead }` | Unread count per user |
| `{ organizationId, isBroadcast, createdAt: -1 }` | Broadcast inbox fetch |
| `{ organizationId, roleTargets, isBroadcast }` | Role-filtered broadcast queries |
| `{ createdAt: 1 }` + `expireAfterSeconds: 7776000` | TTL auto-delete after 90 days |

### Notification Types (full enum)

```
Quotes:          quote_created, quote_updated, quote_deleted, quote_converted
Shipments:       shipment_created, shipment_updated, shipment_deleted,
                 shipment_status_changed, shipment_assigned, shipment_picked_up,
                 shipment_delivered, proof_of_delivery
Vehicles:        vehicle_added, vehicle_updated, vehicle_sold,
                 vehicle_status_changed, inventory_sync, new_inventory_alert
Appointments:    appointment_created, appointment_updated, appointment_cancelled,
                 appointment_reminder, guest_response
CRM / Leads:     new_lead, lead_assigned, lead_status_changed, crm_message,
                 crm_task_assigned, crm_task_due
Driver:          driver_request, driver_request_approved, driver_request_rejected,
                 driver_assigned, driver_location_update, driver_payout
Payments:        payment_received, payment_pending, payment_failed,
                 payment_request, payout_processed
Team:            team_invite_sent, team_member_joined, team_member_left, role_changed
Account:         password_changed, email_changed, profile_updated, login_alert
System:          system_announcement, message_received, reminder, general
Legacy:          proof_submitted, delivery_confirmed
```

### PushSubscription (embedded in User)

Push endpoint data lives as an embedded array on the `User` document rather than a separate collection.

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `endpoint`   | String | Yes      | The browser vendor URL the push message is sent to. Globally unique. |
| `keys.p256dh`| String | Yes      | ECDH public key from the browser subscription. |
| `keys.auth`  | String | Yes      | Authentication secret from the browser subscription. |
| `deviceHint` | String | No       | Human-readable label (e.g. "Chrome on MacBook") supplied by the client. |
| `createdAt`  | Date   | No       | When this subscription was registered. |

A user can have multiple active subscriptions (one per device/browser). There is no explicit cap enforced in the schema.

### User Notification Preferences (embedded in User)

Controls whether a notification category triggers any delivery at all. All default to `true`.

| Preference Key      | Covers Notification Types |
|---------------------|--------------------------|
| `quoteCreated`      | `quote_created`, `quote_converted`, `shipment_assigned`, `driver_assigned` |
| `quoteUpdated`      | `quote_updated` |
| `quoteDeleted`      | `quote_deleted` |
| `shipmentCreated`   | `shipment_created` |
| `shipmentUpdated`   | `shipment_updated`, `shipment_deleted`, `shipment_status_changed`, `shipment_picked_up`, `shipment_delivered`, `proof_of_delivery`, `driver_payout` |
| `shipmentDeleted`   | `shipment_deleted` |
| `appointmentCreated`| `appointment_created`, `appointment_reminder` |
| `appointmentUpdated`| `appointment_updated`, `guest_response` |
| `appointmentCancelled`| `appointment_cancelled` |
| `passwordChanged`   | `password_changed` |
| `emailChanged`      | `email_changed` |
| `profileUpdated`    | `profile_updated` |
| `loginAlerts`       | `login_alert` |
| `driverRequests`    | `driver_request`, `driver_request_approved`, `driver_request_rejected` |
| `crmActivity`       | `new_lead`, `lead_assigned`, `lead_status_changed`, `crm_message`, `crm_task_assigned`, `crm_task_due`, `crm_biometric`, `crm_timeproof`, `team_invite_sent`, `team_member_joined`, `team_member_left` |

If a notification type has no entry in `PREFERENCE_MAP` (inside `notification.service.ts`), it bypasses the preference check and is always delivered.

---

## Push Service (`src/services/push.service.ts`)

`PushService` is a thin, stateless facade that translates notification delivery requests into BullMQ jobs. It never calls `web-push` directly — that is the worker's responsibility. All methods return immediately after enqueuing.

### `PushService.send(userId, payload)`

Enqueues a single `send-push` job.

```typescript
static async send(
  userId: string | mongoose.Types.ObjectId,
  payload: object
): Promise<{ success: boolean; message: string }>
```

| Parameter | Description |
|-----------|-------------|
| `userId`  | Recipient user ID. Converted to string internally. |
| `payload` | Notification payload object. Serialized to JSON by the worker before delivery. See payload shape below. |

Returns `{ success: true }` on successful enqueue or `{ success: false }` if the queue add throws. Errors are logged but not re-thrown — callers treat push as best-effort.

### `PushService.dismiss(userId, tag)`

Enqueues a silent sync action to dismiss matching OS notifications across a user's other devices. Used by `markAsRead` in the notification service.

```typescript
static async dismiss(
  userId: string | mongoose.Types.ObjectId,
  tag: string
): Promise<{ success: boolean; message: string }>
```

Internally calls `send()` with `{ isSyncAction: true, action: 'dismiss', tag }`. The service worker on the client side is responsible for interpreting this payload and calling `self.registration.getNotifications({ tag })` to close matching notifications.

### `PushService.broadcast(userIds, payload)`

Uses BullMQ's `addBulk` to enqueue one job per user in a single Redis round trip — significantly more efficient than calling `send()` in a loop.

```typescript
static async broadcast(
  userIds: (string | mongoose.Types.ObjectId)[],
  payload: object
): Promise<{ success: boolean; sentCount?: number; message?: string }>
```

Returns `{ success: true, sentCount: N }` where `N` is the number of jobs enqueued (not the number of devices reached).

### Standard Push Payload Shape

```typescript
{
  title: string;          // Notification headline
  body: string;           // Notification body text
  tag?: string;           // Groups notifications; used for dismiss sync
  image?: string;         // Rich notification image URL
  icon?: string;          // Custom notification icon URL
  data: {
    url: string;          // Deep-link URL opened when notification is clicked
    notificationId?: string;
    driverRequestId?: string;  // Only present for driver_request type
  };
  actions?: [             // Only present for driver_request type
    { action: 'approve', title: 'Approve' },
    { action: 'reject',  title: 'Reject'  }
  ];
  // Sync-only (no visible notification rendered by SW):
  isSyncAction?: true;
  action?: 'dismiss';
}
```

---

## Queue & Worker

### Queue (`src/jobs/push.queue.ts`)

The queue is created once at module load and shared across all importers via a named export.

```typescript
export const pushQueue = new Queue('push-notifications', {
  connection: bullConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail:    { age: 86400, count: 5000 },
  },
});
```

**Redis connection** (`bullConnection`): uses `config.redis.host/port/password` with `maxRetriesPerRequest: null` as required by BullMQ.

**Job options**:

| Option | Value | Meaning |
|--------|-------|---------|
| `attempts` | 3 | The worker will retry a failed job up to 3 times total. |
| `backoff.type` | `exponential` | Retry delays: 1 s, 2 s, 4 s. |
| `backoff.delay` | 1000 ms | Base delay for the first retry. |
| `removeOnComplete.age` | 3600 s | Completed jobs are kept for 1 hour for monitoring, then purged. |
| `removeOnComplete.count` | 1000 | Keep at most the 1000 most recent completed jobs. |
| `removeOnFail.age` | 86400 s | Failed jobs are kept for 24 hours for debugging. |
| `removeOnFail.count` | 5000 | Keep at most the 5000 most recent failed jobs. |

All jobs use the name `'send-push'` and carry the data shape `{ userId: string, payload: object }`.

### Worker (`src/jobs/push.worker.ts`)

The worker is initialized by importing the module. `src/server.ts` imports it with `import './jobs/push.worker'` so it starts alongside the API server.

```typescript
export const pushWorker = new Worker(
  'push-notifications',
  async (job: Job) => { ... },
  {
    connection: bullConnection,
    concurrency: 50,
    limiter: { max: 100, duration: 1000 },
  }
);
```

**Concurrency**: 50 jobs are processed in parallel within one worker instance.

**Rate limiter**: No more than 100 push sends per second across all concurrent jobs, preventing browser vendor throttling.

**Job processing steps**:

1. Validate `userId` and `payload` from `job.data`. Warn and return early if either is missing.
2. Load the user document with `User.findById(userId).select('pushSubscriptions')`.
3. If the user has no subscriptions, log at debug level and return (not a failure).
4. Stringify the payload once and call `webpush.sendNotification()` for all subscriptions in parallel via `Promise.allSettled`.
5. Collect any subscription whose call returned HTTP 410 (Gone) or 404 (Not Found) — these endpoints are no longer valid.
6. Run a single `User.updateOne` with `$pull` to remove all expired endpoints atomically.

**Initialization**: VAPID credentials are set globally on the `web-push` module at module load:

```typescript
webpush.setVapidDetails(
  config.push.vapidSubject,     // e.g. "mailto:admin@example.com"
  config.push.vapidPublicKey,
  config.push.vapidPrivateKey
);
```

**Worker lifecycle events**:

| Event | Behavior |
|-------|----------|
| `completed` | Logs job ID at debug level. |
| `failed` | Logs job ID and error message at error level. |

**Graceful shutdown**: `src/server.ts` calls `pushWorker.close()` during SIGTERM/SIGINT shutdown to allow in-flight jobs to finish before the process exits.

---

## Notification Service (`src/services/notification.service.ts`)

The notification service is the single entry point for all notification creation and management. Other services should import and call this service rather than writing to the `Notification` collection directly.

### `createNotification(params)`

Creates a single notification, respects user preferences, emits a Socket.IO event, and enqueues a push.

```typescript
createNotification(params: {
  userId: string;
  organizationId: string;
  type: string;
  title: string;
  message: string;
  metadata?: any;
}): Promise<INotification | null>
```

Returns `null` (without creating a record) if the user has disabled the matching notification preference. Throws `ApiError(404)` if the user does not exist. Throws `ApiError(400)` if any required field is missing, the type is invalid, or title/message exceed length limits.

The push call is fire-and-forget:

```typescript
PushService.send(userId, pushPayload).catch(err => console.error(...));
```

Errors from the push queue never reject the returned promise.

### `createNotificationBatch(notifications)`

Calls `createNotification` for each item via `Promise.allSettled`. Returns a summary:

```typescript
{ successful: number, failed: number, results: PromiseSettledResult[] }
```

Individual failures do not abort the batch.

### `getUserNotifications(userId, orgId, options)`

Fetches the user's personal notifications merged with any org-level broadcast notifications that match their role. Results are sorted by `createdAt` descending and paginated client-side (skip/limit after merge).

```typescript
getUserNotifications(
  userId: string,
  orgId: string,
  options?: { limit?: number; skip?: number; isRead?: boolean; userRole?: string }
): Promise<{
  notifications: INotification[];
  total: number;
  unreadCount: number;
}>
```

Pass `limit: 0` to fetch all records without a cap.

### `markAsRead(notificationId, orgId, userId)`

Marks one notification as read and enqueues a cross-device dismiss sync. Throws `ApiError(404)` if the notification does not exist or does not belong to this user+org combination.

### `markAllAsRead(userId, orgId)`

Bulk-updates all unread notifications for the user. Emits `notification:readAll` on Socket.IO. Does not trigger push dismissals (bulk cross-device sync is not currently implemented).

### `deleteNotification(notificationId, orgId, userId)` / `deleteAllRead(userId, orgId)`

Hard-delete operations. Scoped to the user+org pair for security. `deleteAllRead` returns `{ deletedCount }`.

### `getUnreadCount(userId, orgId, userRole?)`

Returns the sum of unread personal notifications and unread broadcast notifications matching the user's role. Used for badge counts.

### `cleanupOldNotifications(userId, daysOld?)`

Deletes read notifications older than `daysOld` days (default: 30). Called by the cleanup scheduler, not by HTTP routes.

### `broadcastNotification(params)`

Creates one `Notification` document per matching user (with `isBroadcast: true`), emits Socket.IO events to all of them, and enqueues a BullMQ broadcast job via `PushService.broadcast`.

```typescript
broadcastNotification(params: {
  organizationId: string;
  roleTargets: string[];
  type: string;
  title: string;
  message: string;
  metadata?: any;
}): Promise<INotification[] | null>
```

Returns `null` if no users match the role targets.

---

## API Endpoints

All endpoints require a valid JWT access token sent as `Authorization: Bearer <token>`. The `auth()` middleware injects `req.user`, `req.orgId`, and `req.orgRole`.

### Push Subscription Endpoints (`/api/push`)

#### `POST /api/push/subscribe`

Registers or updates a push subscription for the authenticated user's current device. If the endpoint already belongs to another account, it is reassigned to the current user (single-ownership enforcement).

**Request body:**
```json
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/...",
    "keys": {
      "p256dh": "BNHivMpk...",
      "auth": "AbCdEfGh..."
    }
  },
  "deviceHint": "Chrome on MacBook Pro"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `subscription` | Yes | The full `PushSubscription` object returned by the browser's `pushManager.subscribe()`. |
| `subscription.endpoint` | Yes | Vendor push URL. |
| `subscription.keys.p256dh` | Yes | ECDH public key. |
| `subscription.keys.auth` | Yes | Auth secret. |
| `deviceHint` | No | Optional human-readable device label. |

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": {},
  "message": "Device subscribed to push notifications successfully."
}
```

**Error responses:** `400` if `subscription`, `endpoint`, or `keys` are missing.

---

#### `DELETE /api/push/subscribe`

Removes a specific push subscription from the authenticated user, typically called when the user revokes browser notification permission.

**Request body:**
```json
{
  "endpoint": "https://fcm.googleapis.com/fcm/send/..."
}
```

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": {},
  "message": "Device unsubscribed from push notifications."
}
```

**Error responses:** `400` if `endpoint` is missing.

---

#### `POST /api/push/broadcast`

Sends an ad-hoc push notification to all users matching a role or an explicit list of user IDs. Restricted to `admin` and `super_admin` roles.

**Request body:**
```json
{
  "roleTarget": "driver",
  "title": "Maintenance window tonight",
  "body": "The app will be down from 2–4 AM.",
  "url": "/announcements",
  "image": "https://cdn.example.com/banner.png",
  "icon": "https://cdn.example.com/icon.png"
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `title` | Yes | Notification headline. |
| `body` | Yes | Notification body text. |
| `roleTarget` | Conditional | Role to target (e.g. `driver`, `dealer`). Mutually exclusive with `userIds`. |
| `userIds` | Conditional | Explicit array of user IDs. Mutually exclusive with `roleTarget`. |
| `url` | No | Deep-link opened when the notification is clicked. Defaults to `/`. |
| `image` | No | Rich notification banner image. |
| `icon` | No | Custom notification icon. |

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": { "success": true, "sentCount": 42 },
  "message": "Broadcast to 42 users completed."
}
```

**Error responses:** `400` if `title` or `body` are missing; `403` if caller is not `admin` or `super_admin`.

---

### Notification Inbox Endpoints (`/api/notifications`)

#### `GET /api/notifications`

Returns the authenticated user's notification inbox, merging personal notifications with role-targeted broadcasts.

**Query parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | number | Max records to return. Defaults to 50. Pass `0` for unlimited. |
| `skip` | number | Records to skip for pagination. Defaults to 0. |
| `isRead` | boolean | Filter by read status. Omit to return all. |

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": {
    "notifications": [
      {
        "_id": "64a1b2c3d4e5f6a7b8c9d0e1",
        "userId": "64a1b2c3d4e5f6a7b8c9d0e0",
        "organizationId": "org_abc123",
        "type": "shipment_assigned",
        "title": "New Load Assigned",
        "message": "You have been assigned to haul a 2023 Ford F-150.",
        "metadata": { "shipmentId": "64a..." },
        "isRead": false,
        "isBroadcast": false,
        "createdAt": "2024-07-01T10:00:00.000Z"
      }
    ],
    "total": 15,
    "unreadCount": 3
  },
  "message": "Notifications fetched successfully"
}
```

---

#### `GET /api/notifications/unread-count`

Returns only the unread count badge value. Cheaper than fetching the full inbox.

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": { "unreadCount": 3 },
  "message": "Unread count fetched successfully"
}
```

---

#### `PATCH /api/notifications/:id/read`

Marks a single notification as read. Also enqueues a cross-device dismiss push.

**URL parameter:** `:id` — the notification's ObjectId.

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": { /* updated notification document */ },
  "message": "Notification marked as read"
}
```

**Error responses:** `404` if not found or the notification does not belong to the caller's user+org.

---

#### `PATCH /api/notifications/read-all`

Marks all of the caller's unread notifications as read.

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": { "message": "All notifications marked as read" },
  "message": "All notifications marked as read"
}
```

---

#### `DELETE /api/notifications/:id`

Permanently deletes a single notification.

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": null,
  "message": "Notification deleted successfully"
}
```

---

#### `DELETE /api/notifications/read/all`

Permanently deletes all read notifications for the caller.

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": { "message": "All read notifications deleted", "deletedCount": 7 },
  "message": "All read notifications deleted"
}
```

---

#### `POST /api/notifications/broadcast`

Creates persisted in-app notifications and triggers push for all users in the specified roles within the caller's organization. Requires `admin` or `super_admin` role.

**Request body:**
```json
{
  "roleTargets": ["driver", "dealer"],
  "type": "system_announcement",
  "title": "Scheduled maintenance",
  "message": "The system will be offline from 2–4 AM tonight.",
  "metadata": {}
}
```

**Response `200`:**
```json
{
  "statusCode": 200,
  "data": [ /* array of created notification documents */ ],
  "message": "Notification broadcasted to driver, dealer"
}
```

**Error responses:** `400` if required fields are missing; `403` if caller is not an admin.

---

#### `POST /api/notifications/create-test`

Creates a single test notification for the caller. Useful during development to verify the notification UI and push delivery pipeline without triggering a real business event.

**Request body:**
```json
{
  "type": "general",
  "title": "Test notification",
  "message": "This is a test push notification."
}
```

---

## Configuration

All environment variables are validated at startup by Joi in `src/config/index.ts`. The application will refuse to start if any required variable is missing.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `VAPID_PUBLIC_KEY` | **Yes** | — | Base64url-encoded VAPID public key. Generated once with `web-push generate-vapid-keys`. |
| `VAPID_PRIVATE_KEY` | **Yes** | — | Base64url-encoded VAPID private key. Keep secret — never commit. |
| `VAPID_SUBJECT` | **Yes** | — | Contact URI for VAPID. Must be `mailto:you@example.com` or an HTTPS URL. |
| `REDIS_HOST` | No | `127.0.0.1` | Redis host for BullMQ queue. |
| `REDIS_PORT` | No | `6379` | Redis port for BullMQ queue. |
| `REDIS_PASSWORD` | No | `""` | Redis auth password. Leave blank if Redis has no auth. |
| `REDIS_ENABLED` | No | `true` | Toggle to disable Redis (disables BullMQ queue, cache, and rate limiting). |

These map to `config.push.vapidPublicKey`, `config.push.vapidPrivateKey`, `config.push.vapidSubject`, and `config.redis.*` after validation.

**Generating VAPID keys** (run once per environment, store in secrets manager):

```bash
npx web-push generate-vapid-keys
```

Example `.env` entries:

```
VAPID_PUBLIC_KEY=BN7X...base64url...
VAPID_PRIVATE_KEY=abc...base64url...
VAPID_SUBJECT=mailto:admin@actionauto.com
```

The `VAPID_PUBLIC_KEY` must also be provided to the frontend so the browser can subscribe:

```javascript
// Frontend: subscribing to push
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY),
});
```

---

## How to Register a Device

This is the full flow from browser subscription to stored token.

**Step 1 — Request notification permission in the browser:**

```javascript
const permission = await Notification.requestPermission();
if (permission !== 'granted') return;
```

**Step 2 — Subscribe to the browser's Push Manager:**

```javascript
const registration = await navigator.serviceWorker.ready;
const subscription = await registration.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
});
```

`subscription` is a `PushSubscription` object with an `endpoint` URL and `keys` (`p256dh`, `auth`).

**Step 3 — Send the subscription to the backend:**

```javascript
await fetch('/api/push/subscribe', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
  },
  body: JSON.stringify({
    subscription: subscription.toJSON(),
    deviceHint: navigator.userAgent,
  }),
});
```

**What the backend does:**

1. `PushController.subscribe` receives the request.
2. It runs `User.updateMany` to remove this `endpoint` from any other user's `pushSubscriptions` array (prevents cross-account delivery if a device changes users).
3. It `$push`es the new subscription object into the current user's `pushSubscriptions` array.
4. Returns `200`.

The subscription is now stored. Future notifications will be delivered to this device until:
- The user explicitly calls `DELETE /api/push/subscribe`.
- The browser vendor returns HTTP 410/404, triggering automatic pruning in the worker.

---

## How to Send a Notification

Within any service, import `NotificationService` and call `createNotification`. The push delivery happens automatically.

```typescript
import NotificationService from '../services/notification.service';

// Example: inside shipment.service.ts after assigning a driver
await NotificationService.createNotification({
  userId: driver._id.toString(),
  organizationId: shipment.organizationId,
  type: 'shipment_assigned',
  title: 'New Load Assigned',
  message: `You have been assigned to haul a ${vehicle.year} ${vehicle.make} ${vehicle.model}.`,
  metadata: {
    shipmentId: shipment._id.toString(),
    vehicleId: vehicle._id.toString(),
  },
});
```

You do not need to call `PushService` directly. `NotificationService.createNotification` handles:
- Preference checking
- Persisting the Notification document
- Emitting the Socket.IO event for open tabs
- Enqueuing the push job (fire-and-forget)

For broadcasting to a role, use `broadcastNotification`:

```typescript
await NotificationService.broadcastNotification({
  organizationId: org._id.toString(),
  roleTargets: ['driver'],
  type: 'system_announcement',
  title: 'Route Update',
  message: 'I-95 southbound is closed. Please check your alternate route.',
});
```

If you need to send a push without creating an in-app notification record (unusual), call `PushService` directly:

```typescript
import PushService from '../services/push.service';

await PushService.send(userId, {
  title: 'Silent data update',
  body: '',
  isSyncAction: true,
  action: 'refresh',
  data: { url: '/dashboard' },
});
```

---

## Error Handling & Retries

### Queue-level retries

BullMQ retries a failed job up to 3 times with exponential backoff (1 s, 2 s, 4 s). A job fails at the queue level only if the worker's async function throws an unhandled error. The following do NOT cause a job failure:

- User has no subscriptions (early return, not a throw).
- A subset of subscriptions fail delivery (handled by `Promise.allSettled`; only errors that are not 410/404 are re-thrown per subscription).

The following DO cause a job to fail and retry:

- A non-410/404 HTTP error from the push vendor (network errors, 500s, rate limit 429s).
- MongoDB query errors when loading the user.

After 3 failed attempts, BullMQ moves the job to the failed set. Failed jobs are retained for 24 hours (configurable via `removeOnFail.age`). You can inspect them with a BullMQ dashboard (e.g. Bull Board) or directly via `pushQueue.getFailed()`.

### Application-level error isolation

Errors from the push layer never propagate to the caller of `NotificationService.createNotification`. The push call is wrapped in `.catch()`:

```typescript
PushService.send(userId, pushPayload).catch(err =>
  logger.error(err, `[PushService] Failed to queue push for user ${userId}`)
);
```

This means a Redis outage will cause push notifications to silently fail while in-app (Socket.IO) notifications continue to work.

### Self-healing subscription pruning

When `webpush.sendNotification()` receives HTTP 410 (Gone) or 404 (Not Found) from the vendor, it means the user revoked browser notification permission or the browser unregistered the service worker. The worker catches this specific error and marks that endpoint for pruning, then removes it from the user document in one batched `$pull` operation after processing all subscriptions for the job.

---

## Adding a New Notification Type

Follow these steps when you need to add a new event to the notification system.

### Step 1 — Add the type to the Notification model enum

In `src/models/Notification.model.ts`, add your new type string to the `type` field enum array:

```typescript
// Inside the type enum array:
'your_new_event',
```

### Step 2 — Add it to the service's `VALID_NOTIFICATION_TYPES` constant

In `src/services/notification.service.ts`, append your type to the `VALID_NOTIFICATION_TYPES` array:

```typescript
'your_new_event',
```

### Step 3 — Map the type to a notification preference (optional)

If the new type should be suppressed by an existing user preference, add an entry to `PREFERENCE_MAP` in `notification.service.ts`:

```typescript
your_new_event: 'crmActivity',  // reuse an existing preference key
```

If all users should always receive this notification regardless of preferences, omit it from `PREFERENCE_MAP`.

### Step 4 — Add a deep-link URL (optional)

If clicking the push notification should navigate somewhere specific, add an entry to `urlMap` inside both `createNotification` and `broadcastNotification` in `notification.service.ts`:

```typescript
const urlMap: Record<string, string> = {
  // ... existing entries ...
  your_new_event: '/your/target/path',
};
```

### Step 5 — Add interactive actions (optional)

If the notification type should have OS-level action buttons (like Approve/Reject), add a branch in `createNotification`:

```typescript
if (type === 'your_new_event') {
  pushPayload.actions = [
    { action: 'confirm', title: 'Confirm' },
    { action: 'dismiss', title: 'Dismiss' },
  ];
  pushPayload.data.relevantId = metadata?.relevantId;
}
```

The client-side service worker must handle the `notificationclick` event and route `event.action` accordingly.

### Step 6 — Trigger the notification from your service

Call `NotificationService.createNotification()` from your business logic service. Do not write to the `Notification` model directly.

### Step 7 — Add a preference key (optional, for new categories)

If the new event represents a brand-new category of notification that users should be able to toggle independently:

1. Add the preference field to `IUser.notificationPreferences` interface in `src/models/User.model.ts`.
2. Add the schema field (with `default: true`) to `notificationPreferences` in `UserSchema`.
3. Add the new preference key to `PREFERENCE_MAP` in `notification.service.ts`.

---

## Related Documentation

- `docs/features/authentication.md` — JWT dual-token system, `req.user` injection by `auth()` middleware
- `auth_documentation.md` — Full authentication reference
- `src/utils/socketEmitter.ts` — `emitToUser()` utility used alongside push delivery
- `src/schedulers/cleanup.scheduler.ts` — Calls `cleanupOldNotifications` on a cron schedule
