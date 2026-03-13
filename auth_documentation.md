# Action Auto: Custom Authentication Architecture Documentation

This document serves as the comprehensive guide for the newly implemented custom authentication system at Action Auto, replacing the legacy Clerk integration.

## 1. High-Level Architecture Overview

Action Auto uses a **Stateless JWT (JSON Web Token) Dual-Token Architecture**.

*   **Frontend (Next.js/React):** Manages user session state via a root-level React Context (`AuthProvider.tsx`). It handles Route Guarding (UX redirects), token storage, and injecting tokens into outgoing API requests.
*   **Backend (Express/Node.js):** Acts as the single source of truth. It validates credentials, interfaces with MongoDB (`User` model), handles Google OAuth server-side, and issues secure tokens.

### The Two Tokens
1.  **Access Token (Short-lived, e.g., 15 mins):** Stored purely in Javascript memory (`(window as any).__AUTH_TOKEN__`) on the client. It is attached to the `Authorization` header of every API request. Because it strictly lives in memory, it is highly secure against XSS (Cross-Site Scripting) attacks.
2.  **Refresh Token (Long-lived, e.g., 7 days):** Stored automatically by the browser in an `HttpOnly`, `Secure`, `SameSite` cookie (`refreshToken`). It cannot be read by Javascript. When the Access Token expires or the user refreshes the page, the frontend automatically pings `/api/auth/refresh-tokens`, and the browser automatically sends this cooking to retrieve a *new* Access Token.

---

## 2. Backend Implementation Detail

### Relevant Files
*   `src/middleware/auth.middleware.ts`: The universal gatekeeper for protected endpoints.
*   `src/controllers/auth.controller.ts`: Handling of login, registration, OTPs, and token generation.
*   `src/services/auth.service.ts`: Core business logic for authentication.
*   `src/services/token.service.ts`: JWT generation and hashing.
*   `src/config/passport.ts`: Google OAuth 2.0 implementation.

### Protected Route Middleware (`auth.middleware.ts`)
To protect a new backend route, simply wrap the controller in the `auth()` middleware.

```typescript
import express from 'express';
import auth from '../middleware/auth.middleware';
import myController from '../controllers/my.controller';

const router = express.Router();
// Protects the route; ensures a valid JWT access token is present
router.post('/my-secure-data', auth(), myController.getData);
```

The middleware extracts the token, verifies it, finds the user in the database, and attaches them to `req`:
*   `req.user`: The full MongoDB user document.
*   `req.orgId`: The user's associated active Organization.
*   `req.orgRole`: The user's role in the active Organization.

**Security Constraints inside Middleware:**
The middleware explicitly rejects users who:
1. Have an inactive account (`isActive: false`).
2. Have not completed email verification (unless calling whitelist endpoints).
3. Have not completed onboarding (`onboardingCompleted: false`).
4. Are `driver` roles that have not been approved.
5. Belong to an organization that is `suspended`.

### Google OAuth Flow
1. User clicks "Sign in with Google" on the frontend.
2. Frontend redirects to `GET <BACKEND_URL>/api/auth/google`.
3. Passport.js redirects the user to Google's consent screen.
4. Google redirects back to `GET <BACKEND_URL>/api/auth/google/callback` with a profile.
5. `passport.ts` finds or creates the user in MongoDB.
6. The backend issues a `refreshToken` cookie and redirects the browser back to `<FRONTEND_URL>/auth/callback?token={accessToken}`.

---

## 3. Frontend Implementation Detail

### Relevant Files
*   `src/providers/AuthProvider.tsx`: The heart of the auth system.
*   `src/lib/api-client.ts`: The Axios client heavily integrated with AuthProvider.
*   `src/app/layout.tsx`: Wraps the entire app in `<AuthProvider>`.

### Accessing User State
Any React Component can access the current user state via hooks exposed by `AuthProvider.tsx`:

```tsx
import { useAuth, useUser, useAuthActions } from '@/providers/AuthProvider';

export function MyComponent() {
  // `useUser` returns a compatible proxy object similar to the old Clerk hook
  const { user, isLoaded, isSignedIn } = useUser();
  const { signOut } = useAuthActions();
  const { getToken } = useAuth(); // Rarely needed directly, handled by interceptors

  if (!isLoaded) return <LoadingSpinner />;
  if (!isSignedIn) return null; // App router handles redirects

  return (
    <div>
      <h1>Welcome, {user.fullName}!</h1>
      <button onClick={() => signOut()}>Log Out</button>
    </div>
  );
}
```

### The `apiClient` Interceptors
You do not need to manually attach the Bearer token to API calls. The `apiClient` instance in `src/lib/api-client.ts` has a request interceptor that automatically grabs it from memory and attaches it.

```typescript
import { apiClient } from '@/lib/api-client';

// The Authorization header is attached automatically securely
const response = await apiClient.get('/api/users/me'); 
```

### Frontend Route Guarding & Onboarding Enforcement
The `refreshUser` function inside `AuthProvider.tsx` runs when the app boots or the user role changes. It controls security routing:

*   If the user has `onboardingCompleted === false`, they are forcefully locked to `/onboarding/role-selection`.
*   If the user is logged in and tries to go to `/sign-in`, they are booted to their respective dashboard (`/customer`, `/driver`, or `/admin/dashboard`).
*   If the user lacks a valid token and tries to access a private page, they are bounced to `/sign-in`.
*   Note: **Do not use Next.js `middleware.ts` for authentication guarding.** Because the backend API runs on a separate sub-domain in Production, Edge Middleware cannot read the `HttpOnly` token cookie. Leave all auth routing logic isolated to `AuthProvider.tsx`.

---

## 4. Legacy Account Migration ("Upgrade Flow")

We built a custom flow to handle users migrating from the old Clerk system. 

1. Legacy users attempt sign-in normally using their email.
2. The backend intercepts the login, detects it's a legacy user without a password hash, and throws a specific error: `LEGACY_USER_UPGRADE_REQUIRED`.
3. `SignInForm.tsx` catches this error and automatically routes the user to `/upgrade?email=...`.
4. The user completes an OTP email verification workflow inside `UpgradeForm.tsx` to prove identity.
5. They set a new password, their Account upgrades to native standard, and they are logged in normally.

## 5. Security Summary Checklist for Developers

*   **New API Endpoints:** Always use `auth()` from `auth.middleware.ts` unless the route strictly requires public access.
*   **Cookie Security:** Ensure `.env` settings use `NODE_ENV=production` in deploy environments, as this forces the `Secure` and `SameSite=none` headers on the `refreshToken` cookie, preventing Cross-Site Request Forgery (CSRF).
*   **Google Console:** If migrating environments or changing domains, the Google Cloud Console "Authorized Redirect URIs" must explicitly match `<BACKEND_URL>/api/auth/google/callback` identically, including `https://`.
*   **Permissions:** Just because `auth()` passes does not mean the user has rights to do a specific action. You must check `req.user.role` or `req.orgRole` inside your Controller if the action targets admin-level modifications.
