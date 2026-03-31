# Technical Documentation: Multi-Tenant OAuth Migration & Sync Hardening

## Overview
This document details the architectural changes and code updates performed to migrate the Gmail/Calendar synchronization flow from a static, environment-variable-based system to a robust, multi-tenant, database-backed model.

## Core Architectural Changes

### 1. Multi-Tenant OAuth Strategy
Instead of relying on a single set of `CENTRAL_GMAIL_*` tokens in the `.env` file, the system now prioritizes tokens stored in the `OrgLeadConfig` collection.

- **Primary Source**: `OrgLeadConfig` (Per-Organization)
- **Secondary Source**: `SystemConfig` (Global Registry)
- **Fallback**: `.env` variables

**Key Benefits**:
- **Isolation**: Each dealership (Organization) can have its own authenticated Gmail channel.
- **Self-Healing**: Tokens refreshed by the Google library are automatically persisted back to the database, preventing session loss.
- **Independence**: The `.env` file is no longer a single point of failure for authentication.

---

## File-by-File Technical Breakdown

### 1. Lead Controller
**File Path**: `src/controllers/lead.controller.ts`

- **`getCentralOAuth2Client(orgId?: string)`**:
  - The central utility for obtaining an authenticated Google client.
  - Now accepts an optional `orgId` to look up organization-specific tokens.
  - Implements a persistence listener (`oauth2Client.on('tokens', ...)`) that updates the `OrgLeadConfig` or `SystemConfig` collections automatically upon refresh.
- **`syncCentralGmail`**:
  - Hardened to check `OrgLeadConfig` for connectivity status before starting.
  - Now passes the `req.orgId` to the OAuth client to ensure the correct dealership's inbox is scanned.
- **`getThreadMessages`**:
  - Refactored to fetch lead-specific conservation threads using the organization's OAuth context.
- **`getCentralSyncStatus`**:
  - Updated to report granular connectivity status (e.g., whether the organization is connected or using a system fallback).

### 2. Google Calendar Service
**File Path**: `src/services/googleCalendar.service.ts`

- **`getCalendarClient(id: string)`**:
  - Refactored to handle "id" as either a `userId` or an `orgId`.
  - Prioritizes `OrgLeadConfig` lookup, looking up the user's organization only if a direct organization config isn't found.
- **`syncAllEvents(id: string)`**:
  - Updated to support organization-level synchronization, removing the previous hard dependency on a `User` object.
- **`fetchAllGoogleCalendarEvents`**:
  - Hardened to resolve the `organizationId` context even when triggered via a manual "Sync Now" button that only provides an `orgId`.

### 3. Lead Model & Data Quality
**File Path**: `src/models/lead.model.ts`

- **Vehicle Schema**: Added `odometer` (String) and `price` (String) to capture dealership-specific vehicle data from ADF emails.
- **Lead Cleanup**: Added `subject` and `body` fields to the selection query in `getAllLeads` to ensure historical lead content is available in the UI.

### 4. ADF Parser Utility
**File Path**: `src/utils/adfParser.ts`

- **`extractText(node)`**:
  - Hardened to recursively handle XML nodes. Prevents values like `[object Object]` (common in phone or price nodes) by extracting the innermost text content.
- **XML Sanitization**: Added a pre-parsing step to handle malformed XML (e.g., unescaped ampersands or unclosed tags) commonly found in dealer-generated lead emails.

### 5. Gmail Internal Service
**File Path**: `src/services/orgGmail.service.ts`

- **`syncLeadsForOrg`**: Matches the controller logic by populating the `subject` and `body` fields during ingestion, ensuring the database record is complete from the moment of creation.

### 6. Frontend: Lead Selection UI
**File Path**: `actionautoutah/src/components/LeadsTab.tsx`

- **Selection Logic**: Restored the missing `onClick` handler on lead list items.
- **Interactions**: Tapping a lead now correctly:
  1. Sets the `selectedLead` state.
  2. Triggers `markAsRead()` API call.
  3. Loads the message thread via the backend's updated multi-tenant logic.

---

## Handover Notes for Developers

### How to Connect a New Organization
1. Go to the **Lead Ingestion Settings**.
2. Click **Connect Google**.
3. Upon successful callback, the system will store the tokens in `OrgLeadConfig` for that `organizationId`.
4. The system will automatically use these tokens for all future syncs and thread fetches for that organization.

### Debugging Authentication
If you see an `invalid_grant` or `401 Unauthorized` error:
1. Verify that the `OrgLeadConfig` for the organization has a valid `refreshToken`.
2. Check the server logs for `[CENTRAL-AUTH]` prefixes; they will tell you exactly which source (DB or .env) the system is currently using.
3. If an organization is disconnected, the system will fall back to `.env` if configured, otherwise it will prompt the user to connect.

### Database Collections Involved
- `leads`: Stores lead data, vehicle info, and thread IDs.
- `orgleadconfigs`: Stores per-organization Gmail/Calendar tokens and sync filters.
- `systemconfigs`: Stores global fallbacks for tokens.
