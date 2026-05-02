# Load Lifecycle — ActionAuto Platform

## Table of Contents

1. [Overview](#1-overview)
2. [Full Lifecycle Flow Diagram](#2-full-lifecycle-flow-diagram)
3. [Status Reference Table](#3-status-reference-table)
4. [Load Data Model Reference](#4-load-data-model-reference)
5. [Org / Dispatcher Workflow](#5-org--dispatcher-workflow)
6. [Driver Workflow](#6-driver-workflow)
7. [Proof of Delivery Flow](#7-proof-of-delivery-flow)
8. [Payout Flow](#8-payout-flow)
9. [API Endpoint Reference](#9-api-endpoint-reference)
10. [Socket.IO Real-Time Events](#10-socketio-real-time-events)
11. [Notifications Reference](#11-notifications-reference)
12. [Business Rules and Guards](#12-business-rules-and-guards)

---

## 1. Overview

The Load is the central entity of ActionAuto's logistics platform. A load represents a vehicle transport job from a pickup location to a delivery location. Loads are scoped to an organization (`organizationId`) and may be assigned to a single driver.

The platform unified a dual Load+Shipment pattern into a single `Load` model. Both legacy `Shipment` records and new `Load` records coexist; the driver-tracking and payout controllers handle both document types transparently. New functionality should use the `Load` model exclusively.

**Two creation paths exist:**

- **Quote path** — A dispatcher creates a Quote (customer-facing estimate), then converts it to a Load when ready to dispatch.
- **Direct path** — A dispatcher creates a Load directly from the Transportation dashboard using the Create Load form.

**Two dispatch methods exist (`postType`):**

- `load-board` — The load is posted publicly within the org. Drivers can browse and request it. A dispatcher approves one driver from the request queue.
- `assign-carrier` — The dispatcher directly assigns a specific driver without a request step.

---

## 2. Full Lifecycle Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  QUOTE PATH (optional)                                                  │
│                                                                         │
│  POST /api/quotes           POST /api/quotes/:id/convert-to-load        │
│  [Dispatcher creates        [Dispatcher converts — quote.status → booked│
│   customer quote]            Load.status → Draft]                       │
└────────────────────────────────────────┬────────────────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  DIRECT PATH                            │
                    │  POST /api/loads                        │
                    │  [Dispatcher creates load directly]     │
                    │  Load.status → Posted                   │
                    └────────────────────┬────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────────────────────┐
                    │  DRAFT (from Quote conversion only)                     │
                    │  Dispatcher must manually post / edit before drivers    │
                    │  can see it. No direct API endpoint to move Draft→Posted│
                    │  (edit the load and save it as Posted in the UI)        │
                    └────────────────────┬────────────────────────────────────┘
                                         │
                    ┌────────────────────▼────────────────────┐
                    │  POSTED                                  │
                    │  Visible on load board to org drivers    │
                    │  postType=load-board: drivers request it │
                    │  postType=assign-carrier: dispatcher      │
                    │  assigns directly via /assign-load       │
                    └──────────┬───────────────────────────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │ load-board path    │                     │ assign-carrier path
          │                    │                     │
          ▼                    │                     ▼
  Driver: POST                 │         Dispatcher: POST
  /request-load                │         /assign-load
  (pendingDriverRequests       │         Load.status → Assigned
   entry created)              │         assignedDriverId set
          │                    │
          ▼                    │
  Dispatcher: POST             │
  /approve-request             │
  Load.status → Assigned       │
  assignedDriverId set         │
          │                    │
          └────────────────────┘
                    │
                    ▼
          ┌─────────────────────────┐
          │  ASSIGNED               │
          │  Driver notified        │
          │  assignedAt timestamp   │
          └──────────┬──────────────┘
                     │
                     ▼
          Driver: POST /accept-load
          Load.status → Accepted
          driverAcceptedAt + acceptedAt set
                     │
                     ▼
          ┌─────────────────────────┐
          │  ACCEPTED               │
          │  Driver heads to pickup │
          └──────────┬──────────────┘
                     │
                     ▼
          Driver: POST /mark-picked-up
          Load.status → Picked Up
          pickedUpAt set
                     │
                     ▼
          ┌─────────────────────────┐
          │  PICKED UP              │
          │  Vehicle loaded         │
          └──────────┬──────────────┘
                     │
                     ▼
          Driver: POST /start-route
          Load.status → In-Transit
          DriverLocation.status → on-route
                     │
                     ▼
          ┌─────────────────────────┐
          │  IN-TRANSIT             │
          │  Driver en route        │
          │  Real-time GPS tracking │
          └──────────┬──────────────┘
                     │
                     ▼
          Driver: POST /api/loads/:id/submit-proof
          (multipart/form-data — image upload)
          proofOfDelivery.imageUrl set
          proofOfDelivery.submittedAt set
          proofOfDelivery.submittedTo set (load creator)
                     │
                     ▼
          ┌─────────────────────────────────────┐
          │  PROOF SUBMITTED (still In-Transit) │
          │  Awaiting dispatcher confirmation   │
          └──────────┬──────────────────────────┘
                     │
                     ▼
          Dispatcher: POST /api/loads/:id/confirm-delivery
          Load.status → Delivered
          proofOfDelivery.confirmedAt set
          proofOfDelivery.confirmedBy set
                     │
                     ▼
          ┌─────────────────────────┐
          │  DELIVERED              │
          │  Eligible for payout    │
          └──────────┬──────────────┘
                     │
                     ▼
          Dispatcher: POST /api/driver-payouts
          (initiates Stripe Transfer)
          DriverPayout.status → processing → paid
                     │
                     ▼
          ┌─────────────────────────┐
          │  PAYOUT COMPLETE        │
          │  Driver notified        │
          │  DriverPayout.status    │
          │  = paid                 │
          └─────────────────────────┘
```

---

## 3. Status Reference Table

| Status | Who Sets It | Endpoint / Action | Timestamp Set | Notifications Fired |
|---|---|---|---|---|
| `Draft` | System | `POST /api/quotes/:id/convert-to-load` | `createdAt` | org members: `load:change {action:"created"}` |
| `Posted` | System (on direct create) or Dispatcher (reverting) | `POST /api/loads`, or `remove-load` / `drop-load` | `createdAt` | org members: `load:change {action:"created"}` |
| `Assigned` | Dispatcher (via assign or approve) | `POST /api/driver-tracking/assign-load`, `POST /api/driver-tracking/approve-request` | `assignedAt` | Driver: `shipment_assigned`; org admins: `driver_assigned` |
| `Accepted` | Driver | `POST /api/driver-tracking/accept-load` (body: `{loadId}`) | `driverAcceptedAt`, `acceptedAt` | Driver: in-app notification; org admins: `shipment_status_changed` |
| `Picked Up` | Driver | `POST /api/driver-tracking/mark-picked-up` (body: `{loadId}`) | `pickedUpAt` | Driver: `Pickup Confirmed`; org admins: `Vehicle Picked Up` |
| `In-Transit` | Driver | `POST /api/driver-tracking/start-route` (body: `{loadId}`) | none (DriverLocation updates) | org admins: `Driver Started Route` |
| `Delivered` | Dispatcher / Admin | `POST /api/loads/:id/confirm-delivery` | `proofOfDelivery.confirmedAt` | Driver: `delivery_confirmed` |
| `Cancelled` | Dispatcher | Direct field update (no dedicated endpoint observed) | none | none observed |

**Intermediate proof state** (not a Load status): When a driver calls `submit-proof`, the load stays in `In-Transit` but `proofOfDelivery.imageUrl` is populated. The dispatcher sees it in the Pending Proofs tab and must confirm to advance to `Delivered`.

**Drop / Remove effects on status:**
- Dispatcher calls `/remove-load`: Load reverts to `Posted` (previous `assignedDriverId`, `assignedAt`, and `driverAcceptedAt` are unset).
- Driver calls `/drop-load` on a Load: Load reverts to `Assigned` (driver stays linked; dispatcher must re-assign or remove), `droppedAt` is set, proof image is deleted from R2.
- Dispatcher calls `/reassign-load`: Load returns to `Assigned` with a new `assignedDriverId`.

---

## 4. Load Data Model Reference

**Source:** `src/models/Load.model.ts`

### Top-Level Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `organizationId` | `String` | Yes | Org identifier (string, not ObjectId). Used for all multi-tenant scoping. |
| `orgId` | `ObjectId` ref `Organization` | No | ObjectId form of the org, populated on creation. |
| `createdBy` | `ObjectId` ref `User` | Yes | User who created the load (dispatcher or system). Indexed. |
| `quoteId` | `ObjectId` ref `Quote` | No | Present when load was created via quote conversion. |
| `migratedFromShipment` | `Boolean` | No | True for records migrated from the legacy Shipment collection. |
| `loadNumber` | `String` | No | Auto-generated on direct create as `LD-YYYYMMDD-XXXX`. Unique, sparse. |
| `postType` | `"load-board" \| "assign-carrier"` | Yes | How the load is dispatched. Defaults to `load-board`. |
| `status` | `LoadStatus` | Yes | See Status Reference Table above. Defaults to `Draft`. |
| `assignedDriverId` | `ObjectId` ref `User` | No | Set when a driver is assigned. Indexed. |
| `assignedAt` | `Date` | No | Timestamp when `assignedDriverId` was set. |
| `driverAcceptedAt` | `Date` | No | Timestamp when the driver called `accept-load`. |
| `acceptedAt` | `Date` | No | Same as `driverAcceptedAt`; both are set together on accept. |
| `pickedUpAt` | `Date` | No | Timestamp when driver called `mark-picked-up`. |
| `deliveredAt` | `Date` | No | Not set by current code; `proofOfDelivery.confirmedAt` is the delivery timestamp. |
| `droppedAt` | `Date` | No | Set when driver calls `drop-load`. |

### Sub-Document: `pickupLocation` / `deliveryLocation` (ILocationBlock)

Both are required. Fields:

| Field | Type | Notes |
|---|---|---|
| `city` | String | Required |
| `state` | String | Required, stored uppercase |
| `zip` | String | Required |
| `country` | String | Defaults to `"US"`, stored uppercase |
| `locationType` | String | Optional label (e.g. "Dealer", "Auction") |
| `companyName` | String | Optional |
| `contactName` | String | Optional |
| `email` | String | Optional, stored lowercase |
| `phone` / `cellPhone` / `phoneExt` | String | Optional |
| `street` | String | Optional |
| `buyerReferenceNumber` | String | Optional, max 50 chars |
| `isTwicRequired` | Boolean | Defaults to false |
| `notes` | String | Optional, max 500 chars |

### Sub-Document: `vehicles` (array of ILoadVehicle)

| Field | Type | Notes |
|---|---|---|
| `vehicleId` | ObjectId ref `Vehicle` | Optional link to org inventory |
| `trailerType` | String | Required (e.g. `"open"`, `"enclosed"`, `"enclosed_2car"`, `"enclosed_3car"`) |
| `condition` | `"Operable" \| "Inoperable"` | Defaults to `"Operable"` |
| `vin` | String | Optional, max 17 chars, stored uppercase |
| `year` / `make` / `model` / `color` | String/Number | Optional vehicle identification |
| `vehicleType` | String | Optional (e.g. `"sedan"`) |
| `oversized` | Boolean | Defaults to false |
| `lotNumber` / `licensePlate` / `licenseState` | String | Optional |
| `carrierNotes` | String | Optional, max 500 chars |

### Sub-Document: `pricing` (ILoadPricing)

| Field | Type | Notes |
|---|---|---|
| `miles` | Number | Server-computed from ZIP coordinates |
| `estimatedRate` | Number | Server-computed via `calculateRate()` |
| `carrierPayAmount` | Number | Dispatcher-entered; what the carrier earns |
| `copCodAmount` | Number | Cash on pickup/delivery collected by driver; defaults to 0 |
| `balanceAmount` | Number | Auto-computed on save: `carrierPayAmount - copCodAmount` |

### Sub-Document: `proofOfDelivery`

| Field | Type | Notes |
|---|---|---|
| `imageUrl` | String | R2 private bucket key (not a public URL; must be signed for display) |
| `submittedAt` | Date | When driver submitted |
| `note` | String | Optional driver note |
| `submittedTo` | ObjectId ref `User` | Auto-set to `load.createdBy` on submit |
| `confirmedAt` | Date | Set by dispatcher on confirmation |
| `confirmedBy` | ObjectId ref `User` | Dispatcher who confirmed |

### Sub-Document: `pendingDriverRequests` (array)

Used for load-board post type to queue driver interest:

| Field | Type | Notes |
|---|---|---|
| `driverId` | ObjectId ref `User` | Required |
| `driverName` | String | Required (denormalized for display) |
| `requestedAt` | Date | Defaults to now |
| `status` | `"pending" \| "approved" \| "rejected"` | Defaults to `"pending"` |
| `reviewedAt` | Date | When dispatcher acted |
| `reviewedBy` | ObjectId ref `User` | Dispatcher who reviewed |
| `rejectionReason` | String | Optional; set automatically on approve (other pending requests get: "Another driver was approved for this load") |

### Sub-Document: `additionalInfo` (ILoadAdditionalInfo)

| Field | Type | Notes |
|---|---|---|
| `visibility` | `"public" \| "private"` | Defaults to `"public"` |
| `notes` | String | Max 4000 chars |
| `instructions` | String | Max 4000 chars |
| `internalLoadId` | String | Max 50 chars |
| `preDispatchNotes` | String | Shown to driver in Dispatch Details panel |
| `specialInstructions` | String | Shown to driver in Dispatch Details panel |
| `loadSpecificTerms` | String | Max 500 chars; shown to driver |

### Indexes

```
{ organizationId: 1, createdAt: -1 }
{ organizationId: 1, status: 1 }
{ organizationId: 1, "additionalInfo.visibility": 1 }
{ "pendingDriverRequests.driverId": 1, "pendingDriverRequests.status": 1 }
{ createdBy: 1 }           (from field definition)
{ assignedDriverId: 1 }    (from field definition)
```

---

## 5. Org / Dispatcher Workflow

### 5.1 Creating a Quote

Quotes are customer-facing shipping estimates computed from ZIP coordinates.

**Endpoint:** `POST /api/quotes`
**Auth:** JWT + org required

**Request body:**
```json
{
  "firstName": "Jane",
  "lastName": "Smith",
  "email": "jane@example.com",
  "phone": "801-555-0100",
  "fromZip": "84101",
  "toZip": "90210",
  "fromAddress": "Salt Lake City, UT 84101",
  "toAddress": "Beverly Hills, CA 90210",
  "vehicleId": "<optional ObjectId from org inventory>",
  "units": 1,
  "enclosedTrailer": false,
  "vehicleInoperable": false
}
```

The server calls `getCoordinatesFromZip()` on both ZIPs, computes `miles` via Haversine, and calls `calculateRate()` to produce the quote `rate`. An ETA (min/max day range) is also computed via `calculateETA()`. The created Quote has `status: "pending"`.

### 5.2 Converting a Quote to a Load

**Endpoint:** `POST /api/quotes/:id/convert-to-load`
**Auth:** JWT + org required

What happens:
- Parses city/state from the quote's `fromAddress` / `toAddress` strings.
- Creates a Load with `status: "Draft"`, `postType: "load-board"`.
- Copies pricing: `miles`, `estimatedRate`, and sets `carrierPayAmount` equal to the quote rate.
- Sets `quoteId` on the load to preserve the lineage.
- Updates the source Quote to `status: "booked"` (it remains in the system for customer history).
- Emits `load:change { action: "created" }` to the org's Socket.IO room.

The resulting load is in `Draft` status and does not appear to drivers until it is posted.

### 5.3 Creating a Load Directly

**Endpoint:** `POST /api/loads`
**Auth:** JWT + org required + staff role (`super_admin`, `admin`, `employee`)

New loads created directly always start with `status: "Posted"` — they are immediately visible.

The server:
1. Validates the body against `createLoadSchema` (Zod).
2. Resolves ZIPs to coordinates and computes `miles` and `estimatedRate` server-side. The client cannot override these computed values.
3. Accepts `carrierPayAmount` and `copCodAmount` from the client.
4. Auto-generates `loadNumber` in the format `LD-YYYYMMDD-XXXX` (e.g. `LD-20260428-F3K2`).
5. If `contract.agreedToTerms === true`, sets `contract.signedAt` to now.

**Minimal request body:**
```json
{
  "postType": "load-board",
  "pickupLocation": {
    "city": "Salt Lake City",
    "state": "UT",
    "zip": "84101",
    "country": "US"
  },
  "deliveryLocation": {
    "city": "Las Vegas",
    "state": "NV",
    "zip": "89101",
    "country": "US"
  },
  "vehicles": [
    {
      "trailerType": "open",
      "condition": "Operable"
    }
  ]
}
```

### 5.4 Viewing and Filtering Loads

**Endpoint:** `GET /api/loads`
**Query parameters:**

| Parameter | Values | Notes |
|---|---|---|
| `status` | `Posted`, `Assigned`, `In-Transit`, `Delivered`, `Cancelled` | Filter by status |
| `postType` | `load-board`, `assign-carrier` | Filter by dispatch method |
| `q` | any string | Full-text search across `loadNumber`, city, state, vehicle make/model/VIN |
| `page` | integer (default 1) | Pagination |
| `limit` | integer, max 50 (default 20) | Page size |

Drivers calling this endpoint receive loads masked via `maskLoadForDriver()` — sensitive org pricing/contact fields are stripped.

**Stats endpoint:** `GET /api/loads/stats` returns counts by status:
```json
{ "all": 42, "Posted": 10, "Assigned": 8, "In-Transit": 5, "Delivered": 18, "Cancelled": 1 }
```

### 5.5 Assigning a Driver Directly (assign-carrier)

**Endpoint:** `POST /api/driver-tracking/assign-load`
**Auth:** JWT + org required

**Request body:**
```json
{
  "shipmentId": "<loadId or shipmentId>",
  "driverId": "<userId of driver>"
}
```

Guards enforced:
- The driver's `role` must be `"driver"`.
- The driver's `organizationId` must match the calling org.
- If the load is already assigned and not in `Posted`, `Available for Pickup`, or `Draft` status, a `409 Conflict` is returned.

Effect: Sets `assignedDriverId`, `assignedAt`, advances status to `Assigned`.

### 5.6 Reviewing Load Board Requests (load-board path)

When a driver requests a load-board load, a `pendingDriverRequests` entry appears on the load document.

**View pending requests:** `GET /api/driver-tracking/load-requests`
Returns all loads with pending requests, enriched with each requesting driver's `DriverProfile` (trailer type, capacity, compliance status, truck make/model).

**Approve a request:** `POST /api/driver-tracking/approve-request`
```json
{
  "loadId": "<id>",
  "driverId": "<id>"
}
```
Effect: The approved driver's request entry moves to `status: "approved"`. All other `pending` entries on the same load are automatically set to `status: "rejected"` with `rejectionReason: "Another driver was approved for this load"`. Each rejected driver receives an in-app notification.

**Reject a request:** `POST /api/driver-tracking/reject-request`
```json
{
  "loadId": "<id>",
  "driverId": "<id>",
  "reason": "Equipment mismatch"  // optional
}
```

### 5.7 Reassigning a Driver

**Endpoint:** `POST /api/driver-tracking/reassign-load`
**Auth:** JWT + org required

**Request body:**
```json
{
  "shipmentId": "<loadId>",
  "newDriverId": "<userId>"
}
```

Effect on a Load: Clears `driverAcceptedAt`, `acceptedAt`, `pickedUpAt`. Sets new `assignedDriverId` and `assignedAt`. Status returns to `Assigned`. The old driver receives a `shipment_reassigned` notification; the new driver receives `shipment_assigned`.

### 5.8 Removing a Driver from a Load

**Endpoint:** `POST /api/driver-tracking/remove-load`
**Auth:** JWT + org required

**Request body:**
```json
{ "shipmentId": "<loadId>" }
```

Effect: Status reverts to `Posted`. `assignedDriverId`, `assignedAt`, and `driverAcceptedAt` are unset. The removed driver receives a `shipment_removed` notification.

### 5.9 Confirming Proof of Delivery

**Endpoint:** `POST /api/loads/:id/confirm-delivery`
**Auth:** JWT + org required + staff role

Effect:
- Sets `proofOfDelivery.confirmedAt` and `proofOfDelivery.confirmedBy`.
- Advances `Load.status` to `"Delivered"`.
- Sends `delivery_confirmed` notification to the assigned driver.

Viewing the proof image before confirming:

**Endpoint:** `GET /api/loads/:id/proof-image`
**Auth:** JWT + org + staff role

The image is stored in the private R2 bucket. This endpoint proxies the stream to the client so private bucket keys are never exposed.

The dispatcher can also use `GET /api/driver-payouts/pending-proofs` to see all proofs submitted to them that have not yet been confirmed.

### 5.10 Issuing a Driver Payout

**Endpoint:** `POST /api/driver-payouts`
**Auth:** JWT + org required

**Request body:**
```json
{
  "loadId": "<loadId>",
  "driverId": "<userId>",
  "amount": 450.00,
  "description": "Driver payout for load LD-20260428-F3K2",
  "notes": "Delivery bonus included"
}
```

Guards enforced:
- Load must exist in the org and have `status: "Delivered"`.
- Driver must have `stripeConnectAccountId` set on their User record (completed Stripe Connect onboarding).
- No existing `DriverPayout` for the same load with `status: "paid"` or `"processing"`.

Flow:
1. `DriverPayout` is created with `status: "processing"`.
2. `stripe.transfers.create()` is called with the amount in cents, targeting `driver.stripeConnectAccountId`.
3. On success: payout `status → "paid"`, `paidAt` set, `stripeTransferId` stored.
4. On Stripe error: payout `status → "failed"`, `failureReason` stored; a `402` error is returned.

**Legacy note:** The frontend's payout modal sends the field as `shipmentId` (legacy param name). The controller accepts both `loadId` and `shipmentId` as the entity identifier.

---

## 6. Driver Workflow

### 6.1 Prerequisites

Before a driver can interact with loads, the following must be true on their `DriverProfile`:

- `isComplianceExpired` must be `false` (expired compliance blocks load requests).
- `operationalStatus` must be `"active"` (inactive drivers cannot request loads).
- Active load count must be below `maxVehicleCapacity` (defaults to 12 if no profile exists).

### 6.2 Viewing Available Loads

**Endpoint:** `GET /api/driver-tracking/available-loads`
**Auth:** JWT required (driver role)

Returns loads and shipments where:
- `organizationId` matches the driver's org.
- For Loads: `status === "Posted"` and no `assignedDriverId`.
- For Shipments (legacy): `status === "Available for Pickup"` and no `assignedDriverId`.

Each result includes a `myRequestStatus` field (`"pending"`, `"approved"`, `"rejected"`, or `null`) so the driver can see whether they have already requested a given load.

The response is capped at 20 Load records and 40 Shipment records per request. Trailer type and capacity filters are noted in the source as temporarily disabled for demo purposes.

### 6.3 Requesting a Load (load-board path)

**Endpoint:** `POST /api/driver-tracking/request-load`
**Auth:** JWT required (driver role)

**Request body:**
```json
{ "loadId": "<id>" }
```

A `pendingDriverRequests` entry is pushed onto the load. The driver cannot request the same load twice. Multiple drivers can request the same load simultaneously; the dispatcher picks one.

After requesting, the driver can track their request status via:

**Endpoint:** `GET /api/driver-tracking/my-requests`
Returns all loads (and shipments) where the driver has a `pendingDriverRequests` entry, annotated with `myRequestStatus` and `rejectionReason` if declined.

### 6.4 Viewing Assigned Loads

**Endpoint:** `GET /api/driver-tracking/my-loads`
**Auth:** JWT required (driver role)

Returns all loads and shipments where `assignedDriverId === req.user._id`, sorted by `assignedAt` descending. Also returns:
- `activeLoadCount` — loads not in `Delivered` or `Cancelled`
- `maxLoadCapacity` — from the driver's profile (default 12)
- `trailerType` — from the driver's profile

Load documents are normalized for the frontend:
- `origin` — `"${pickupLocation.city}, ${pickupLocation.state}"`
- `destination` — `"${deliveryLocation.city}, ${deliveryLocation.state}"`
- `trackingNumber` — aliased from `loadNumber`
- `__docType` — `"load"` (used by the frontend to route to the correct API endpoint)

### 6.5 Accepting a Load

**Endpoint:** `POST /api/driver-tracking/accept-load`
**Auth:** JWT required (driver role)

**Request body:**
```json
{ "loadId": "<id>" }
```

Guards:
- Load must be in `Assigned` status.
- `assignedDriverId` must match the calling driver.
- Total active load count must be below `maxVehicleCapacity`.

Effect: Sets `driverAcceptedAt` and `acceptedAt` to now, advances status to `Accepted`.

### 6.6 Marking Vehicle Picked Up

**Endpoint:** `POST /api/driver-tracking/mark-picked-up`
**Auth:** JWT required (driver role)

**Request body:**
```json
{ "loadId": "<id>" }
```

Guards:
- Load must be in `Accepted` status.
- `assignedDriverId` must match the calling driver.

Effect: Sets `pickedUpAt` to now, advances status to `Picked Up`. Also updates `DriverLocation.status` to `"on-route"`.

### 6.7 Starting the Route

**Endpoint:** `POST /api/driver-tracking/start-route`
**Auth:** JWT required (driver role)

**Request body:**
```json
{ "loadId": "<id>" }
```

Guards:
- Load must be in `Picked Up` status.
- `assignedDriverId` must match the calling driver.

Effect: Advances status to `In-Transit`. Updates `DriverLocation.status` to `"on-route"`.

If the load is already `In-Transit`, the endpoint returns `200 OK` without error (idempotent).

### 6.8 Submitting Proof of Delivery

**Endpoint:** `POST /api/loads/:id/submit-proof`
**Auth:** JWT required (driver role via `auth()` called directly on the route, bypassing `requireOrg`)
**Content-Type:** `multipart/form-data`

**Form fields:**

| Field | Type | Required |
|---|---|---|
| `proof` | image file (JPEG, PNG) | Yes |
| `note` | string | No |

The image is uploaded to the private R2 bucket under the `proof-of-delivery` prefix. The stored value is a bucket key, not a public URL.

`proofOfDelivery.submittedTo` is automatically set to `load.createdBy` (the dispatcher who posted the load). If the driver re-submits, the old image is deleted from R2 before the new one is uploaded.

The load status does **not** change on proof submission — it remains `In-Transit` until a dispatcher calls `confirm-delivery`.

### 6.9 Dropping a Load

**Endpoint:** `POST /api/driver-tracking/drop-load`
**Auth:** JWT required (driver role)

**Request body:**
```json
{ "loadId": "<id>" }
```

Effect on a Load:
- Status reverts to `Assigned` (not `Posted`) — the driver remains linked and must be manually removed or reassigned by a dispatcher.
- `driverAcceptedAt`, `acceptedAt`, `pickedUpAt`, and `proofOfDelivery` are all unset.
- Any uploaded proof image is deleted from R2.
- `droppedAt` is set.
- Org admins receive a `shipment_status_changed` notification.

The drop confirmation dialog in the frontend warns: "Frequently dropping loads may affect your driver rating and future load assignments."

### 6.10 Updating Location

**Endpoint:** `POST /api/driver-tracking/location`
**Auth:** JWT required (driver role)

**Request body:**
```json
{
  "lat": 40.7608,
  "lng": -111.8910,
  "status": "on-route"
}
```

Valid status values: `"on-route"`, `"idle"`, `"on-break"`, `"waiting"`, `"offline"`.

Uses upsert on `DriverLocation` keyed by `userId`. After update, the new coordinates are emitted to:
- `org:{orgId}` room — `driver:location_update` event (for the dispatcher map view).
- `shipment:{shipmentId}` room for each active shipment linked to the driver.

### 6.11 Driver Dashboard Stats

**Endpoint:** `GET /api/driver-tracking/dashboard-stats`
**Auth:** JWT required (driver role)

Returns:
```json
{
  "totalLoads": 15,
  "activeLoads": 2,
  "completedLoads": 12,
  "pendingRequests": 1,
  "totalEarnings": 4500.00,
  "profileCompletionScore": 85,
  "isComplianceExpired": false,
  "operationalStatus": "active"
}
```

Note: `totalEarnings` here is computed from `Shipment.carrierPayAmount` for delivered shipments only — it does not aggregate `DriverPayout` records. Use `/api/driver-payouts/my-payouts` for actual transferred payout amounts.

---

## 7. Proof of Delivery Flow

```
Driver (In-Transit)
    │
    ▼ POST /api/loads/:id/submit-proof
    │  multipart: file=<image>, note=<optional>
    │
    ├── Guard: load.assignedDriverId === req.user._id
    ├── Delete old image from R2 (if resubmitting)
    ├── Upload new image → R2 private bucket
    │   key stored in proofOfDelivery.imageUrl
    ├── proofOfDelivery.submittedAt = now
    ├── proofOfDelivery.submittedTo = load.createdBy
    ├── Notify org admins: "proof_of_delivery"
    └── Return { imageUrl: "<R2 key>" }
    
    Load status stays: In-Transit

Dispatcher (Pending Proofs tab)
    │
    ▼ GET /api/driver-payouts/pending-proofs
    │  Returns loads where proof submitted to this admin, not yet confirmed
    │  Images returned with signed URLs from storageService.getSignedUrl()
    │
    ▼ GET /api/loads/:id/proof-image
    │  Proxies private R2 stream — no public URL exposed
    │
    ▼ POST /api/loads/:id/confirm-delivery
    ├── Guard: proofOfDelivery.imageUrl must exist
    ├── Load.status → "Delivered"
    ├── proofOfDelivery.confirmedAt = now
    ├── proofOfDelivery.confirmedBy = req.user._id
    ├── Notify driver: "delivery_confirmed"
    └── Log activity: "load_delivered"
```

---

## 8. Payout Flow

### 8.1 Stripe Connect Onboarding (Driver)

Drivers must complete Stripe Connect Express onboarding before they can receive payouts. The `stripeConnectAccountId` field on the `User` document tracks whether onboarding has been completed.

**Initiate onboarding:**
`POST /api/driver-payouts/connect/onboard`

Flow:
1. If `user.stripeConnectAccountId` is not set, calls `stripe.accounts.create()` with type `"express"` and capability `transfers`.
2. The new account ID is saved to `user.stripeConnectAccountId`.
3. Calls `stripe.accountLinks.create()` to generate a one-time onboarding URL.
4. Returns `{ url: "<stripe-hosted-onboarding-url>" }`.
5. The frontend redirects the driver to Stripe's hosted onboarding flow.
6. Stripe redirects back to `${frontendUrl}/driver/settings?stripe=success` on completion, or `?stripe=refresh` if the session expires.

**Check status:**
`GET /api/driver-payouts/connect/status`

Returns:
```json
{
  "connected": true,
  "accountId": "acct_xxxxxx",
  "detailsSubmitted": true,
  "chargesEnabled": false,
  "payoutsEnabled": true
}
```

If the Stripe account no longer exists (deleted from Stripe dashboard), the controller clears `user.stripeConnectAccountId` and returns `{ connected: false }`.

### 8.2 DriverPayout Model Reference

**Source:** `src/models/DriverPayout.model.ts`

| Field | Type | Notes |
|---|---|---|
| `organizationId` | String | Org that issued the payout. Indexed. |
| `loadId` | ObjectId ref `Load` | The load being paid out. |
| `driverId` | ObjectId ref `User` | The driver receiving the payout. Indexed. |
| `driverName` | String | Denormalized at creation time. |
| `driverEmail` | String | Denormalized at creation time, stored lowercase. |
| `amount` | Number | USD amount (dollars, not cents). Min 0. |
| `currency` | String | Defaults to `"usd"`. |
| `description` | String | Auto-set to `"Driver payout for load {loadNumber}"`. |
| `status` | `"pending" \| "processing" \| "paid" \| "failed"` | Defaults to `"pending"`. Indexed. |
| `stripeTransferId` | String | Stripe transfer ID on success. Sparse unique. |
| `payoutNumber` | String | Auto-generated on save: `PAY-YYYYMM-NNNN` (e.g. `PAY-202604-0001`). |
| `paidAt` | Date | Set on successful Stripe transfer. |
| `failureReason` | String | Stripe error message on failure. |
| `notes` | String | Optional dispatcher notes. |
| `createdBy` | ObjectId ref `User` | The dispatcher who initiated the payout. |

### 8.3 Payout Creation Lifecycle

```
Dispatcher calls POST /api/driver-payouts
    │
    ├── Guard: Load exists in org with status "Delivered"
    ├── Guard: No existing paid/processing payout for this load
    ├── Guard: Driver has stripeConnectAccountId
    │
    ├── DriverPayout.create({ status: "processing" })
    ├── payoutNumber auto-generated by pre-save hook
    │
    ├── stripe.transfers.create({
    │     amount: Math.round(amount * 100),  // dollars → cents
    │     currency: "usd",
    │     destination: driver.stripeConnectAccountId,
    │     metadata: { payoutId, organizationId, loadId, driverId }
    │   })
    │
    ├── SUCCESS:
    │   ├── payout.stripeTransferId = transfer.id
    │   ├── payout.status = "paid"
    │   ├── payout.paidAt = now
    │   ├── Notify driver: "driver_payout" — "Payout Received"
    │   └── Log financial activity via activityService
    │
    └── FAILURE:
        ├── payout.status = "failed"
        ├── payout.failureReason = stripeError.message
        └── Throw ApiError(402, "Payout failed: ...")
```

### 8.4 Payout Blocked Conditions

A payout is blocked when any of the following are true:

| Condition | Error |
|---|---|
| Load does not have `status: "Delivered"` | 404 "Load not found or not yet delivered" |
| Driver has no `stripeConnectAccountId` | 400 "Driver has not connected a Stripe account yet" |
| Existing payout with `status: "paid"` or `"processing"` for same load | 400 "A payout has already been sent for this load" |
| `amount <= 0` | 400 "Amount must be greater than zero" |

### 8.5 Driver Earnings View

**Endpoint:** `GET /api/driver-payouts/my-payouts`
**Auth:** JWT required (no org required — uses `req.user._id`)

Returns all `DriverPayout` records where `driverId === req.user._id`, populated with load number and locations.

The driver earnings page (`/driver/earnings`) combines this with `GET /api/driver-tracking/my-loads` to produce a merged transaction timeline showing both payout records and completed loads in chronological order.

### 8.6 Org Payout Management

**Endpoint:** `GET /api/driver-payouts/deliverable`
Returns all Delivered loads (and those with unconfirmed proof) that have an `assignedDriverId`, annotated with any existing payout record (`existingPayout`) and a `pendingConfirmation` boolean.

**Endpoint:** `GET /api/driver-payouts`
Lists all `DriverPayout` records for the org. Supports filtering by `?status=paid` or `?driverId=<id>`.

**Endpoint:** `GET /api/driver-payouts/stats`
Aggregated stats:
```json
{
  "totalPaid": 12500.00,
  "totalPending": 800.00,
  "countPaid": 28,
  "countPending": 2,
  "countFailed": 1
}
```

---

## 9. API Endpoint Reference

All endpoints are prefixed with `/api`. All require a valid JWT `Authorization: Bearer <token>` header unless otherwise noted.

### Quote Endpoints (`/api/quotes`)

| Method | Path | Caller | Auth | Description |
|---|---|---|---|---|
| `POST` | `/api/quotes` | Org/Dispatcher | JWT + org | Create a new shipping quote |
| `GET` | `/api/quotes` | Org/Dispatcher | JWT + org | List all quotes (paginated); supports `?status=pending&search=&page=1&limit=20` |
| `GET` | `/api/quotes/:id` | Org/Dispatcher | JWT + org | Get single quote |
| `PUT/PATCH` | `/api/quotes/:id` | Org/Dispatcher | JWT + org | Full update of quote fields |
| `PATCH` | `/api/quotes/:id/status` | Org/Dispatcher | JWT + org | Update only quote status (`pending`, `accepted`, `rejected`, `booked`) |
| `DELETE` | `/api/quotes/:id` | Org/Dispatcher | JWT + org | Delete quote |
| `POST` | `/api/quotes/:id/convert-to-load` | Org/Dispatcher | JWT + org | Convert quote to Load (Quote → `booked`, Load created at `Draft`) |

### Load CRUD Endpoints (`/api/loads`)

| Method | Path | Caller | Auth | Description |
|---|---|---|---|---|
| `POST` | `/api/loads` | Dispatcher (staff only) | JWT + org + staff role | Create load directly; initial status `Posted` |
| `GET` | `/api/loads` | Org member | JWT + org | List loads with filters/search/pagination |
| `GET` | `/api/loads/stats` | Org member | JWT + org | Count of loads per status |
| `GET` | `/api/loads/:id` | Org member | JWT + org | Get load by ID (driver receives masked response) |
| `DELETE` | `/api/loads/:id` | Dispatcher (staff only) | JWT + org + staff role | Delete load (blocked if `In-Transit`) |
| `POST` | `/api/loads/:id/submit-proof` | Driver | JWT (no org required) | Upload proof of delivery image (`multipart/form-data`, field name `proof`) |
| `GET` | `/api/loads/:id/proof-image` | Dispatcher (staff only) | JWT + org + staff role | Stream proof image from private R2 |
| `POST` | `/api/loads/:id/confirm-delivery` | Dispatcher (staff only) | JWT + org + staff role | Confirm proof; advances load to `Delivered` |
| `GET` | `/api/loads/vin/:vin` | Dispatcher (staff only) | JWT + org + staff role | VIN lookup in org inventory |
| `GET` | `/api/loads/vehicles` | Dispatcher (staff only) | JWT + org + staff role | Search org inventory vehicles; supports `?q=search` |
| `POST` | `/api/loads/calculate-rate` | Dispatcher (staff only) | JWT + org + staff role | Compute miles + rate from ZIPs; body: `{pickupZip, deliveryZip, vehicles}` |

### Driver Tracking Endpoints (`/api/driver-tracking`)

**Driver-only (no org middleware):**

| Method | Path | Caller | Auth | Description |
|---|---|---|---|---|
| `POST` | `/api/driver-tracking/location` | Driver | JWT | Update driver GPS coordinates and status |
| `GET` | `/api/driver-tracking/my-loads` | Driver | JWT | Fetch all assigned loads and shipments |
| `POST` | `/api/driver-tracking/accept-load` | Driver | JWT | Accept an assigned load; body: `{loadId}` or `{shipmentId}` |
| `POST` | `/api/driver-tracking/mark-picked-up` | Driver | JWT | Mark vehicle picked up; body: `{loadId}` |
| `POST` | `/api/driver-tracking/drop-load` | Driver | JWT | Drop a load; body: `{loadId}` or `{shipmentId}` |
| `POST` | `/api/driver-tracking/start-route` | Driver | JWT | Start route after pickup; body: `{loadId}` or `{shipmentId}` |
| `GET` | `/api/driver-tracking/available-loads` | Driver | JWT | Browse available loads in driver's org |
| `POST` | `/api/driver-tracking/request-load` | Driver | JWT | Request a load-board load; body: `{loadId}` or `{shipmentId}` |
| `GET` | `/api/driver-tracking/my-requests` | Driver | JWT | View all driver load requests with status |
| `GET` | `/api/driver-tracking/dashboard-stats` | Driver | JWT | Driver dashboard aggregate stats |

**Org-scoped (org middleware applied):**

| Method | Path | Caller | Auth | Description |
|---|---|---|---|---|
| `GET` | `/api/driver-tracking/active` | Dispatcher | JWT + org | List active drivers with location and loads; supports `?status=on-route` |
| `POST` | `/api/driver-tracking/assign-load` | Dispatcher | JWT + org | Directly assign driver; body: `{shipmentId, driverId}` |
| `POST` | `/api/driver-tracking/remove-load` | Dispatcher | JWT + org | Remove driver from load; body: `{shipmentId}` |
| `POST` | `/api/driver-tracking/reassign-load` | Dispatcher | JWT + org | Reassign to new driver; body: `{shipmentId, newDriverId}` |
| `GET` | `/api/driver-tracking/load-requests` | Dispatcher | JWT + org | View pending load board requests |
| `POST` | `/api/driver-tracking/approve-request` | Dispatcher | JWT + org | Approve a driver's load request; body: `{loadId, driverId}` or `{shipmentId, driverId}` |
| `POST` | `/api/driver-tracking/reject-request` | Dispatcher | JWT + org | Reject a request; body: `{loadId, driverId, reason}` |

### Driver Payout Endpoints (`/api/driver-payouts`)

**Driver-only (no org middleware):**

| Method | Path | Caller | Auth | Description |
|---|---|---|---|---|
| `POST` | `/api/driver-payouts/connect/onboard` | Driver | JWT | Initiate Stripe Connect Express onboarding; returns `{url}` |
| `GET` | `/api/driver-payouts/connect/status` | Driver | JWT | Check driver's Stripe Connect account status |
| `GET` | `/api/driver-payouts/my-payouts` | Driver | JWT | Fetch driver's own payout history |

**Org-scoped:**

| Method | Path | Caller | Auth | Description |
|---|---|---|---|---|
| `GET` | `/api/driver-payouts/deliverable` | Dispatcher | JWT + org | List delivered loads eligible for payout (with existing payout annotation) |
| `GET` | `/api/driver-payouts/pending-proofs` | Dispatcher | JWT + org | List loads with unconfirmed proof submitted to this admin |
| `GET` | `/api/driver-payouts/org-admins` | Dispatcher | JWT + org | List org admins/employees for "Submit To" dropdown |
| `GET` | `/api/driver-payouts/stats` | Dispatcher | JWT + org | Aggregate payout stats |
| `GET` | `/api/driver-payouts` | Dispatcher | JWT + org | List all org payouts; supports `?status=paid&driverId=<id>` |
| `POST` | `/api/driver-payouts` | Dispatcher | JWT + org | Create and send a payout via Stripe Transfer |

---

## 10. Socket.IO Real-Time Events

The server uses Socket.IO namespaces and rooms. Org members join `org:{orgId}`. Drivers are also connected on the same socket.

### Events Emitted by Server

| Event | Room | Payload | Trigger |
|---|---|---|---|
| `driver:location_update` | `org:{orgId}` | `{driverId, coords, status, lastSeenAt}` | Driver calls `POST /location` |
| `driver:location_update` | `shipment:{shipmentId}` | same as above | Driver has active shipments |
| `driver:loads_updated` | `org:{orgId}` | `{action, loadId?, shipmentId?, driverId?, status?}` | Any load assignment change |
| `driver:load_requested` | `org:{orgId}` | `{loadId?, shipmentId?, driverId, driverName}` | Driver requests a load |
| `driver:load_request_updated` | `org:{orgId}` | `{loadId?, shipmentId?, driverId, action}` | Request approved or rejected |
| `load:change` | `org:{orgId}` | `{action: "created" \| "deleted", loadId?}` | Load created or deleted |
| `quote:change` | `org:{orgId}` | `{action: "created" \| "updated" \| "deleted"}` | Quote created, updated, or deleted |

### `driver:loads_updated` Actions

| Action value | When |
|---|---|
| `"assigned"` | Driver assigned to load |
| `"approved"` | Load board request approved |
| `"accepted"` | Driver accepted load |
| `"picked-up"` | Driver marked vehicle picked up |
| `"in-route"` | Driver started route |
| `"removed"` | Dispatcher removed driver |
| `"dropped"` | Driver dropped load |
| `"reassigned"` | Load reassigned to new driver |

The driver's loads page listens for `driver:loads_updated`, `driver:load_request_updated`, and `driver:load_requested` and calls `fetchLoads()` on any of these events, supplemented by a 30-second polling interval as a fallback.

---

## 11. Notifications Reference

All notifications are created via `safeCreateNotification()` which wraps creation in try/catch to prevent notification failures from interrupting the main flow. `notifyOrgAdmins()` fans out to all users with `role` in `["admin", "super_admin"]` in the org.

| Trigger Action | Recipient | `type` value | Title | Message Pattern |
|---|---|---|---|---|
| Quote created | Creator | `quote_created` | "New Quote Created" | "Quote created for {customerName}" |
| Quote accepted | Creator + org admins | `quote_accepted` | "Quote Accepted" | From `notificationTemplates.quote_accepted` |
| Quote deleted | Creator + org admins | `quote_deleted` | "Quote Deleted" | "{vehicleName} for {customerName}" |
| Driver assigned to load | Driver | `shipment_assigned` | "Load Assigned" | From `notificationTemplates.shipment_assigned` |
| Driver assigned (org) | Org admins | `driver_assigned` | "Load Assigned to Driver" | "{trackingNumber} assigned to {driverName}" |
| Driver accepted load | Driver | `shipment_assigned` | "Load Accepted" | "You accepted load {loadNumber}. Head to pickup." |
| Driver accepted (org) | Org admins | `shipment_status_changed` | "Load Accepted by Driver" | "{driverName} accepted load {loadNumber}" |
| Driver marked picked up | Driver | `shipment_status_changed` | "Pickup Confirmed" | "Load {loadNumber} marked as picked up." |
| Driver picked up (org) | Org admins | `shipment_status_changed` | "Vehicle Picked Up" | "{driverName} picked up load {loadNumber}" |
| Driver started route | Org admins | `shipment_status_changed` | "Driver Started Route" | "{driverName} started route for load {loadNumber}" |
| Proof submitted | Org admins | `proof_of_delivery` | From template | From `notificationTemplates.proof_of_delivery` |
| Delivery confirmed | Driver | `delivery_confirmed` | "Delivery Confirmed" | "Your delivery for load {loadNumber} has been confirmed" |
| Driver removed from load | Driver | `shipment_removed` | "Load Removed" | "Load {loadNumber} has been removed from your assignments" |
| Driver removed (org) | Org admins | `shipment_status_changed` | "Load Removed from Driver" | "{loadNumber} removed from {driverName}" |
| Load reassigned (old driver) | Old driver | `shipment_reassigned` | "Load Reassigned" | "Load {loadNumber} has been reassigned to another driver" |
| Load reassigned (new driver) | New driver | `shipment_assigned` | "New Load Assigned" | "Load {loadNumber}: {origin} → {destination}" |
| Driver dropped load | Org admins | `shipment_status_changed` | "Load Dropped by Driver" | "{driverName} dropped load {loadNumber}" |
| Load request submitted | Org admins | `driver_request` | "Load Requested by Driver" | "{driverName} requested load {loadNumber}" |
| Load request approved | Approved driver | `shipment_assigned` | "Load Request Approved" | "Your request for {loadNumber} has been approved." |
| Load request auto-rejected | Other drivers | `shipment_status_changed` | "Load Request Update" | "Your request for {loadNumber} was not approved — another driver was selected." |
| Load request rejected | Driver | `shipment_status_changed` | "Load Request Declined" | "Your request for {loadNumber} was declined{: reason}." |
| Payout sent | Driver | `driver_payout` | "Payout Received" | "You received a payout of ${amount} for load {loadNumber}" |

---

## 12. Business Rules and Guards

### Driver Eligibility Gates

Before a driver can request or accept any load, the system checks:

1. **Compliance:** `DriverProfile.isComplianceExpired === false`. If expired, a `403` is returned with "Your compliance documents are expired."
2. **Operational status:** `DriverProfile.operationalStatus === "active"`. If not active, a `403` is returned.
3. **Capacity:** `activeShipmentCount + activeLoadCount < maxVehicleCapacity`. `maxVehicleCapacity` defaults to 12 if no profile exists. The capacity check runs on both `requestLoad` and `acceptLoad`.
4. **Vehicle capacity match:** If the load has more vehicles than `DriverProfile.maxVehicleCapacity`, a `400` is returned.

### Status Transition Guards (Load model)

| From Status | Allowed Transitions | Blocked By |
|---|---|---|
| `Draft` | → `Posted` (manual edit / UI) | — |
| `Posted` | → `Assigned` (assign or approve) | — |
| `Assigned` | → `Accepted` (driver accept) | Driver must match `assignedDriverId` |
| `Assigned` | → `Posted` (remove-load) | Dispatcher only |
| `Accepted` | → `Picked Up` (mark-picked-up) | Driver must match `assignedDriverId` |
| `Picked Up` | → `In-Transit` (start-route) | Driver must match `assignedDriverId` |
| `In-Transit` | → `Delivered` (confirm-delivery) | Requires proof image; staff only |
| Any | → `Assigned` (drop-load by driver) | Driver must match `assignedDriverId` |
| Any | → `Posted` (remove-load by dispatcher) | Dispatcher + org only |
| `In-Transit` | Cannot be deleted | Enforced in `deleteLoad` |

### Duplicate Payout Protection

`DriverPayout` records are checked before creating a new payout. If a record exists with `status: "paid"` or `"processing"` for the same `loadId` in the org, a `400` error is returned. This prevents double-payment even if the Stripe transfer is still processing.

### Proof of Delivery Re-submission

A driver can re-submit proof at any time while assigned to a load. The old image is deleted from R2 before the new one is uploaded. There is no lock on re-submission until the dispatcher confirms.

### Load Board Multi-Request Handling

When a dispatcher approves one driver's request, all other `pending` requests on the same load are atomically set to `rejected` with a standard message. The approval is atomic (single `.save()` on the load document after mutating all request entries in memory).

### Privacy and Masking

Loads returned to driver-role users are passed through `maskLoadForDriver()` (defined in `src/utils/loadMask.ts`). This strips sensitive fields such as org pricing details and contact information that drivers should not see.

Proof images are stored in the **private** R2 bucket (`actionauto-private`). They are never returned as direct URLs. The dispatcher accesses them via the proxy endpoint (`GET /api/loads/:id/proof-image`), which signs the request server-side. Signed URLs are also used in the `pending-proofs` response via `storageService.getSignedUrl()`.
