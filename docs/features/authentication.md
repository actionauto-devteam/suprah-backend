# Authentication System

## Overview

The ActionAuto platform implements a dual-token JWT authentication system with email/password login, Google OAuth 2.0 integration, and email verification via OTP. The authentication layer supports multi-tenant architecture with organization-level context.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Authentication Flow                        │
└─────────────────────────────────────────────────────────────┘

User Registration
  ↓
Email Verification (6-digit OTP)
  ↓
Login (Email/Password or Google OAuth)
  ↓
Generate Access Token (15 min) + Refresh Token (7 days)
  ↓
Store Refresh Token in Database (Session model)
  ↓
Return Access Token + Set httpOnly Cookie with Refresh Token
  ↓
Client sends Access Token in Authorization header
  ↓
Token expires → Use Refresh Token to get new Access Token
  ↓
Logout → Delete Session from Database
```

## Key Files

### Routes
- **File**: `src/routes/auth.routes.ts`
- **Base Path**: `/api/auth`

### Controllers
- **File**: `src/controllers/auth.controller.ts`
- **Responsibility**: Handle HTTP requests, validate input, set cookies

### Services
- **File**: `src/services/auth.service.ts`
- **Responsibility**: Business logic, token generation, user validation
- **File**: `src/services/token.service.ts`
- **Responsibility**: JWT creation and verification

### Models
- **File**: `src/models/User.model.ts`
- **Schema**: User authentication credentials, roles, organization membership
- **File**: `src/models/Session.model.ts`
- **Schema**: Refresh token storage with expiration

### Middleware
- **File**: `src/middleware/auth.middleware.ts`
- **Responsibility**: JWT validation, user injection into `req.user`

## Dual-Token JWT System

### Access Token

**Lifetime**: 15 minutes (configurable via `JWT_ACCESS_EXPIRATION`)

**Storage**: Client-side memory (NOT localStorage for security)

**Usage**: Sent in `Authorization: Bearer <token>` header for API requests

**Payload**:
```json
{
  "sub": "user_mongodb_id",
  "orgId": "organization_mongodb_id",
  "role": "admin",
  "iat": 1714096800,
  "exp": 1714097700
}
```

**Generation** (`src/services/token.service.ts:10-18`):
```typescript
generateAccessToken(user: IUser): string {
  return jwt.sign(
    {
      sub: user._id.toString(),
      orgId: user.organizationId?.toString(),
      role: user.role,
    },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiration }
  );
}
```

### Refresh Token

**Lifetime**: 7 days (configurable via `JWT_REFRESH_EXPIRATION`)

**Storage**: httpOnly cookie (XSS-safe)

**Usage**: Automatically sent by browser to `/api/auth/refresh-tokens`

**Payload**:
```json
{
  "sub": "user_mongodb_id",
  "iat": 1714096800,
  "exp": 1714701600
}
```

**Storage**: Hashed using SHA-256 and stored in MongoDB `Session` collection

**Rotation**: Each refresh generates a NEW refresh token and invalidates the old one

**Generation** (`src/services/auth.service.ts:441-455`):
```typescript
private async generateAuthTokens(user: IUser) {
  const accessToken = tokenService.generateAccessToken(user);
  const refreshToken = tokenService.generateRefreshToken(user);

  const refreshTokenHash = this.hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await Session.create({
    userId: user._id,
    refreshTokenHash,
    expiresAt
  });

  return { accessToken, refreshToken };
}
```

## API Endpoints

### POST `/api/auth/register`

Register a new user account.

**Rate Limit**: `authLimiter` (5 requests per 15 minutes per IP)

**Request Body**:
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "SecurePass123!",
  "role": "customer",  // Optional: "customer", "dealership", "driver"
  "inviteToken": "abc123"  // Optional: If joining via invitation
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "message": "Registration successful. Please verify your email.",
  "data": {
    "user": {
      "_id": "507f1f77bcf86cd799439011",
      "name": "John Doe",
      "email": "john@example.com",
      "role": "customer",
      "emailVerified": false,
      "onboardingCompleted": true
    }
  }
}
```

**Process**:
1. Validate email uniqueness
2. Hash password using bcrypt (10 rounds)
3. Create user in database (`emailVerified: false`)
4. Generate 6-digit OTP (valid for 15 minutes)
5. Send verification email via `emailService`
6. Return user object (NO tokens until email verified)

**File**: `src/services/auth.service.ts:14-95`

---

### POST `/api/auth/verify-email`

Verify email address with OTP received via email.

**Rate Limit**: `otpLimiter` (10 requests per 15 minutes)

**Request Body**:
```json
{
  "email": "john@example.com",
  "otp": "123456"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Email verified successfully",
  "data": {
    "user": { ... },
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```

**Cookies Set**:
```
refreshToken=<jwt_refresh_token>; HttpOnly; Secure; SameSite=None; Max-Age=604800
```

**Process**:
1. Find user by email
2. Validate OTP and expiration
3. Set `emailVerified: true`
4. Clear OTP fields
5. Generate access + refresh tokens
6. Log login activity
7. Return tokens

**File**: `src/services/auth.service.ts:100-113`

---

### POST `/api/auth/resend-otp`

Resend email verification OTP.

**Rate Limit**: `otpLimiter`

**Request Body**:
```json
{
  "email": "john@example.com"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Verification code resent successfully"
}
```

**File**: `src/services/auth.service.ts:118-142`

---

### POST `/api/auth/login`

Authenticate with email and password.

**Rate Limit**: `authLimiter`

**Request Body**:
```json
{
  "email": "john@example.com",
  "password": "SecurePass123!"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": { ... },
    "accessToken": "eyJhbGci..."
  }
}
```

**Cookies Set**: `refreshToken` httpOnly cookie

**Error Responses**:
- `401 LEGACY_USER_UPGRADE_REQUIRED` - User from old Clerk system, needs password setup
- `401 Please sign in with Google` - User registered via Google OAuth
- `401 Invalid email or password` - Credentials don't match

**Process**:
1. Find user by email (case-insensitive)
2. Check if legacy user (no password, no googleId)
3. Validate password using bcrypt
4. Generate tokens
5. Set httpOnly cookie
6. Log login activity

**File**: `src/services/auth.service.ts:220-253`

---

### POST `/api/auth/refresh-tokens`

Exchange refresh token for new access token.

**Request Body** (optional, cookie takes precedence):
```json
{
  "refreshToken": "eyJhbGci..."
}
```

**Cookies**: Reads `refreshToken` from httpOnly cookie

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Tokens refreshed successfully",
  "data": {
    "accessToken": "new_access_token..."
  }
}
```

**Cookies Set**: NEW `refreshToken` (token rotation for security)

**Process**:
1. Verify refresh token signature
2. Hash token and find matching session in DB
3. Validate user still exists
4. Delete old session
5. Generate NEW access + refresh tokens
6. Create new session in DB
7. Return new access token

**Security**: Implements refresh token rotation to prevent replay attacks

**File**: `src/services/auth.service.ts:301-320`

---

### POST `/api/auth/logout`

Invalidate refresh token and end session.

**Request**: Reads `refreshToken` from cookie or body

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

**Cookies**: Clears `refreshToken` cookie

**Process**:
1. Hash refresh token
2. Delete session from database
3. Clear httpOnly cookie
4. Log logout activity

**File**: `src/services/auth.service.ts:325-328`

---

### POST `/api/auth/register-dealership`

Register a dealership account (creates User + Organization atomically).

**Rate Limit**: `authLimiter`

**Request Body**:
```json
{
  "name": "Jane Smith",
  "email": "jane@dealership.com",
  "password": "SecurePass123!",
  "dealershipName": "ABC Motors",
  "dealershipSlug": "abc-motors"
}
```

**Response** (201 Created):
```json
{
  "success": true,
  "message": "Dealership registered. Please verify your email.",
  "data": {
    "user": { ... },
    "organization": { ... },
    "status": "pending_verification"
  }
}
```

**Process** (uses MongoDB transaction):
1. Validate email and slug uniqueness
2. Create User with `role: "admin"`
3. Create Organization with user as owner
4. Link user to organization (`organizationId`, `organizationRole: "owner"`)
5. Generate OTP and send email
6. Commit transaction

**File**: `src/services/auth.service.ts:147-215`

---

### POST `/api/auth/forgot-password`

Request password reset OTP.

**Request Body**:
```json
{
  "email": "john@example.com"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "If an account exists, a reset code has been sent"
}
```

**Security**: Always returns success to prevent email enumeration

**File**: `src/services/auth.service.ts:333-354`

---

### POST `/api/auth/reset-password`

Reset password with OTP.

**Request Body**:
```json
{
  "email": "john@example.com",
  "otp": "123456",
  "newPassword": "NewSecurePass123!"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Password reset successfully",
  "data": {
    "user": { ... }
  }
}
```

**Process**:
1. Find user by email
2. Validate OTP and expiration
3. Hash new password
4. Clear OTP fields
5. Log password change activity

**File**: `src/services/auth.service.ts:359-372`

---

### POST `/api/auth/complete-onboarding`

Complete onboarding flow by selecting a role.

**Authentication**: Requires valid JWT (`auth()` middleware)

**Request Body**:
```json
{
  "role": "driver"  // "customer", "dealership", "driver"
}
```

**Response** (200 OK):
```json
{
  "success": true,
  "message": "Onboarding completed successfully",
  "data": {
    "user": { ... }
  }
}
```

**Process**:
1. Validate user hasn't completed onboarding
2. Assign role
3. Set `onboardingCompleted: true`
4. If driver, create `DriverRequest` (pending approval)
5. Invalidate auth cache

**File**: `src/services/auth.service.ts:384-406`

## Google OAuth 2.0

### GET `/api/auth/google`

Initiate Google OAuth flow.

**Query Parameters**:
```
?role=customer&redirect_url=https://app.com/dashboard&inviteToken=abc123
```

**Process**:
1. Redirect to Google OAuth consent screen
2. Pass state parameter with role and redirect URL
3. User authorizes app

**Scopes**: `profile`, `email`

---

### GET `/api/auth/google/callback`

Handle Google OAuth callback.

**Query Parameters**:
```
?code=4/0AX4XfWg...&state={"role":"customer","redirect_url":"..."}
```

**Process**:
1. Exchange code for Google profile via Passport.js
2. Find or create user in database:
   - If user exists with email: Link googleId
   - If new user: Create with `googleId`, no password
3. Generate access + refresh tokens
4. Set httpOnly cookie
5. Redirect to frontend with access token in URL

**Redirect URL**:
```
https://app.actionauto.com/auth/callback?token=<access_token>&redirect_url=<encoded_url>
```

**Passport Strategy** (`src/config/passport.ts`):
```typescript
passport.use(new GoogleStrategy({
  clientID: config.google.clientId,
  clientSecret: config.google.clientSecret,
  callbackURL: `${config.backendUrl}/api/auth/google/callback`,
  passReqToCallback: true
}, async (req, accessToken, refreshToken, profile, done) => {
  // Find or create user logic
}));
```

**File**: `src/routes/auth.routes.ts:28-81`

## Legacy User Upgrade Flow

For users migrated from the old Clerk authentication system:

### POST `/api/auth/send-upgrade-otp`

Send OTP to legacy user (no password set).

**Request Body**:
```json
{
  "email": "legacy@example.com"
}
```

---

### POST `/api/auth/upgrade-legacy`

Set password for legacy user.

**Request Body**:
```json
{
  "email": "legacy@example.com",
  "otp": "123456",
  "newPassword": "NewSecurePass123!"
}
```

**Response**: Returns tokens, user can now login

**File**: `src/services/auth.service.ts:258-296`

## Authentication Middleware

### `auth()` Middleware

**File**: `src/middleware/auth.middleware.ts`

**Responsibility**:
- Extract JWT from `Authorization: Bearer <token>` header
- Verify token signature
- Load user from database (with 5-min cache)
- Check user status (active, verified, onboarded, approved)
- Check organization status (not suspended)
- Handle super admin impersonation
- Inject `req.user`, `req.orgId`, `req.orgRole`

**Usage**:
```typescript
router.get('/protected', auth(), async (req, res) => {
  console.log(req.user._id);  // Authenticated user
  console.log(req.orgId);      // User's organization
  console.log(req.orgRole);    // User's role in org
});
```

**Security Checks** (`src/middleware/auth.middleware.ts:121-167`):

1. **User Active**: `user.isActive === true`
2. **Email Verified**: `user.emailVerified === true` (bypassed for certain routes)
3. **Onboarding Completed**: `user.onboardingCompleted === true`
4. **Driver Approval**: If `role === 'driver'`, check `user.isApproved === true`
5. **Organization Suspended**: Check `organization.status !== 'suspended'`

**Whitelisted Routes** (bypass email/onboarding checks):
- `/api/auth/complete-onboarding`
- `/api/users/me`
- `/api/notifications`
- `/api/invitations/accept`
- `/api/driver-requests/my-status`

---

### Super Admin Impersonation

Super admins can impersonate any organization:

**Request Header**:
```
x-impersonate-org-id: 507f1f77bcf86cd799439011
```

**Process** (`src/middleware/auth.middleware.ts:76-99`):
1. Check if user has `role: "super_admin"`
2. Extract `x-impersonate-org-id` header
3. Validate organization exists
4. Override `req.orgId` and `req.orgRole = "admin"`

**Use Case**: Admin support, debugging, data access

## Password Security

### Hashing

**Algorithm**: bcrypt with 10 rounds (configurable via `BCRYPT_SALT_ROUNDS`)

**Pre-save Hook** (`src/models/User.model.ts`):
```typescript
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});
```

### Validation

**Method** (`src/models/User.model.ts`):
```typescript
userSchema.methods.isPasswordMatch = async function (password: string): Promise<boolean> {
  return bcrypt.compare(password, this.password);
};
```

### Password Requirements

Enforced via Joi validation schema (`src/validations/auth.validation.ts`):
- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number

## Email Verification

### OTP Generation

**Format**: 6-digit random number

**Expiration**: 15 minutes

**Storage**: `User.otpCode` (string), `User.otpExpiresAt` (Date)

**Generation**:
```typescript
const otp = Math.floor(100000 + Math.random() * 900000).toString();
user.otpCode = otp;
user.otpExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
```

### Email Template

**Subject**: "Verify Your Action Auto Account"

**Content**:
```html
<h1>Account Verification</h1>
<p>Welcome to Action Auto! Your verification code is: <strong>123456</strong></p>
```

**Delivery**: `emailService.sendEmail()` (Nodemailer)

## Session Management

### Session Model

**File**: `src/models/Session.model.ts`

**Schema**:
```typescript
{
  userId: ObjectId (ref: 'User'),
  refreshTokenHash: String (SHA-256 hash),
  expiresAt: Date,
  createdAt: Date
}
```

**Indexes**:
- `userId` - Lookup sessions by user
- `refreshTokenHash` - Fast token validation
- `expiresAt` - TTL index for auto-deletion

### Session Cleanup

Expired sessions are automatically removed by MongoDB TTL index.

Manual cleanup runs daily via `src/schedulers/cleanup.scheduler.ts`.

## Security Considerations

### XSS Protection
- Refresh tokens stored in httpOnly cookies (not accessible via JavaScript)
- Access tokens kept in memory (NOT localStorage)

### CSRF Protection
- SameSite cookie attribute (`none` in production for cross-domain)
- Short access token lifetime reduces attack window

### Token Rotation
- Refresh tokens rotated on each use
- Old refresh tokens immediately invalidated

### Rate Limiting
- Login: 5 attempts per 15 minutes per IP
- OTP: 10 attempts per 15 minutes
- Registration: 5 attempts per 15 minutes

### Brute Force Prevention
- Rate limiting on auth endpoints
- Account lockout (future enhancement)
- Password complexity requirements

### SQL Injection
- Protected by Mongoose ODM (no raw queries)

### Password Enumeration
- Forgot password returns same response for existing/non-existing emails

## Activity Logging

All authentication events are logged via `activityService`:

**Events**:
- `login` - Successful login
- `logout` - User logout
- `password_change` - Password reset/change
- `email_verification` - Email verified

**Log Fields**:
- `userId`
- `organizationId`
- `type`
- `title`
- `description`
- `ipAddress`
- `userAgent`
- `timestamp`

**File**: `src/services/activity.service.ts`

## Caching

### User Lookup Cache

**TTL**: 5 minutes

**Implementation** (`src/utils/cache.util.ts`):
```typescript
const userAuthCache = new NodeCache({ stdTTL: 300 });

// In auth middleware
const cachedUser = userAuthCache.get(userId);
if (cachedUser) return cachedUser;
const user = await User.findById(userId);
userAuthCache.set(userId, user);
```

**Invalidation**: Deleted on:
- User update
- Password change
- Role change
- Onboarding completion

### Organization Status Cache

**TTL**: 5 minutes

**Purpose**: Reduce DB queries for organization suspension checks

## Testing

### Unit Tests

Test files: `tests/auth.test.ts`

**Test Cases**:
- User registration with valid data
- Email verification with correct OTP
- Login with correct credentials
- Login with incorrect credentials
- Refresh token flow
- Logout and session invalidation
- Google OAuth callback
- Password reset flow
- Dealership registration

### Integration Tests

Uses Supertest for HTTP assertions:

```typescript
describe('POST /api/auth/register', () => {
  it('should register a new user', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({
        name: 'Test User',
        email: 'test@example.com',
        password: 'SecurePass123!'
      });

    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe('test@example.com');
  });
});
```

## Error Handling

All errors thrown as `ApiError` instances:

```typescript
throw new ApiError(401, 'Invalid email or password');
```

**Common Error Codes**:
- `400` - Invalid input (validation failure)
- `401` - Authentication failed (invalid credentials/token)
- `403` - Email not verified, onboarding incomplete, driver not approved
- `404` - User not found
- `409` - Email already exists
- `500` - Server error

## Environment Variables

Required configuration (`.env`):

```bash
# JWT Secrets
JWT_ACCESS_SECRET=your_access_secret_here
JWT_ACCESS_EXPIRATION=15m
JWT_REFRESH_SECRET=your_refresh_secret_here
JWT_REFRESH_EXPIRATION=7d

# Google OAuth
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback

# Password Hashing
BCRYPT_SALT_ROUNDS=10

# Frontend URL (for redirects)
FRONTEND_URL=http://localhost:3000
```

**Validation**: All env vars validated at startup via Joi (`src/config/index.ts`)

## Common Operations

### Adding a New OAuth Provider

1. Install passport strategy: `npm install passport-facebook`
2. Configure strategy in `src/config/passport.ts`
3. Add routes in `src/routes/auth.routes.ts`
4. Update user model to store provider ID
5. Add provider button in frontend

### Changing Token Expiration

1. Update `.env`: `JWT_ACCESS_EXPIRATION=30m`
2. Restart server (config validated at startup)

### Forcing User Logout

```typescript
// Delete all sessions for a user
await Session.deleteMany({ userId: user._id });
```

### Enabling Account Lockout

Future enhancement:

```typescript
// Add to User model
loginAttempts: { type: Number, default: 0 },
lockUntil: Date,

// In login service
if (user.isLocked()) {
  throw new ApiError(403, 'Account temporarily locked');
}
if (!isMatch) {
  await user.incLoginAttempts();
}
```

## Related Documentation

- [Authorization & RBAC](./authorization.md) - Role-based access control
- [User Management](./user-management.md) - User CRUD operations
- [Organization Management](./organization-management.md) - Multi-tenant setup
- [Email Service](./email-service.md) - Email delivery configuration
- [API Overview](../api/api-overview.md) - API conventions
