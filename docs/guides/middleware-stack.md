# Middleware Stack

## Overview

The ActionAuto platform uses a layered middleware architecture to handle cross-cutting concerns before requests reach controllers. Middleware is applied globally or at route level to enforce security, validation, logging, and rate limiting.

## Request Lifecycle

```
HTTP Request
    ↓
┌─────────────────────────────────────┐
│  1. Global Rate Limiter             │ ← Prevent API abuse
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  2. Correlation ID Assignment       │ ← Request tracing
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  3. Metrics Collection              │ ← Golden signals (latency, errors)
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  4. HTTP Structured Logging         │ ← Pino request/response logs
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  5. Helmet Security Headers         │ ← XSS, clickjacking protection
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  6. Body Parsers                    │ ← JSON, URL-encoded, XML
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  7. CORS Validation                 │ ← Origin whitelisting
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  8. Cookie Parser                   │ ← Parse refresh token cookie
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  9. Passport Initialization         │ ← OAuth strategies
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  Route-Specific Middleware          │
├─────────────────────────────────────┤
│  • auth()                           │ ← JWT validation
│  • requireRole()                    │ ← RBAC enforcement
│  • validate()                       │ ← Joi schema validation
│  • upload()                         │ ← File upload handling
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  Controller                         │ ← Business logic
└───────────────┬─────────────────────┘
                ↓
┌─────────────────────────────────────┐
│  Global Error Handler               │ ← Catch all errors, format response
└─────────────────────────────────────┘
```

## Global Middleware (Applied to All Routes)

### 1. Global Rate Limiter

**File**: `src/middleware/rate-limit.middleware.ts`

**Applied**: Line 33 in `src/server.ts`

**Purpose**: Protect API from abuse by limiting request rate per IP

**Configuration**:
```typescript
export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,                  // 100 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  store: new RedisStore({
    client: redis,
    prefix: 'rl:global:',
  }),
});
```

**Headers**:
- `RateLimit-Limit`: Maximum requests allowed
- `RateLimit-Remaining`: Requests remaining in window
- `RateLimit-Reset`: Timestamp when limit resets

**Response** (429 Too Many Requests):
```json
{
  "success": false,
  "message": "Too many requests from this IP, please try again later."
}
```

---

### 2. Correlation ID Middleware

**File**: `src/middleware/correlationId.middleware.ts`

**Applied**: Line 36 in `src/server.ts`

**Purpose**: Assign unique ID to each request for distributed tracing

**Implementation**:
```typescript
export const correlationIdMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const correlationId = req.headers['x-correlation-id']?.toString() ||
    `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);

  next();
};
```

**Usage**:
```typescript
logger.info({ correlationId: req.correlationId }, 'Processing request');
```

**Benefits**:
- Track requests across multiple services
- Correlate logs for debugging
- Client can send ID to link related requests

---

### 3. Metrics Middleware

**File**: `src/middleware/metrics.middleware.ts`

**Applied**: Line 39 in `src/server.ts`

**Purpose**: Collect golden signals (latency, traffic, errors, saturation)

**Tracked Metrics**:
- Request latency (ms)
- Request count by path and method
- Error count by status code
- Response size (bytes)

**Implementation**:
```typescript
export const metricsMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Log metrics
    logger.debug({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      contentLength: res.get('content-length'),
    }, 'Request completed');

    // Emit to monitoring system (future)
    // metricsCollector.recordRequest(...)
  });

  next();
};
```

**Future Enhancement**: Export to Prometheus/Grafana

---

### 4. HTTP Structured Logging

**File**: `src/utils/logger.ts` (Pino HTTP middleware)

**Applied**: Line 42 in `src/server.ts`

**Purpose**: Log all HTTP requests and responses in structured JSON format

**Configuration**:
```typescript
export const httpLogger = pinoHttp({
  logger,
  autoLogging: true,
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} ${res.statusCode} - ${err.message}`;
  },
});
```

**Log Format**:
```json
{
  "level": 30,
  "time": 1714096800000,
  "msg": "GET /api/vehicles 200",
  "req": {
    "method": "GET",
    "url": "/api/vehicles",
    "headers": { ... },
    "remoteAddress": "192.168.1.1"
  },
  "res": {
    "statusCode": 200,
    "headers": { ... }
  },
  "responseTime": 45
}
```

---

### 5. Helmet Security Headers

**File**: Express `helmet` middleware

**Applied**: Line 45 in `src/server.ts`

**Purpose**: Set security HTTP headers to protect against common attacks

**Configuration**:
```typescript
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  contentSecurityPolicy: config.env === 'production' ? undefined : false,
}));
```

**Headers Set**:
- `X-DNS-Prefetch-Control: off`
- `X-Frame-Options: SAMEORIGIN` (clickjacking protection)
- `X-Content-Type-Options: nosniff` (MIME sniffing protection)
- `X-XSS-Protection: 0` (deprecated, CSP preferred)
- `Strict-Transport-Security: max-age=15552000` (HTTPS enforcement)

**CSP Disabled in Dev**: Allows Vite hot reload without CSP conflicts

---

### 6. Body Parsers

**File**: Express built-in middleware

**Applied**: Lines 59-69 in `src/server.ts`

**Purpose**: Parse incoming request bodies

**JSON Parser**:
```typescript
app.use(express.json({
  limit: '512kb',
  verify: (req: any, res, buf) => {
    req.rawBody = buf.toString(); // For webhook signature verification
  }
}));
```

**URL-Encoded Parser**:
```typescript
app.use(express.urlencoded({ extended: true, limit: '512kb' }));
```

**XML Parser** (for ADF emails):
```typescript
app.use(express.text({ type: ['application/xml', 'text/xml'], limit: '512kb' }));
```

**Size Limit**: 512KB to prevent DoS attacks

---

### 7. CORS Middleware

**File**: Express `cors` middleware

**Applied**: Line 111 in `src/server.ts`

**Purpose**: Enable cross-origin resource sharing with whitelisted origins

**Configuration**:
```typescript
const corsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = config.corsOrigin.split(',').map(o => o.trim());

    if (!origin) return callback(null, true); // Allow Postman, mobile apps

    if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
      return callback(null, true);
    }

    if (config.env === 'development') {
      return callback(null, true); // Allow all in dev
    }

    callback(new Error(`Origin ${origin} not allowed by CORS`));
  },
  credentials: true, // Allow cookies
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-impersonate-org-id'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400, // 24 hours
};

app.use(cors(corsOptions));
```

**Allowed Origins**: From `CORS_ORIGIN` env variable (comma-separated)

**Credentials**: Required for httpOnly cookies (refresh tokens)

---

### 8. Cookie Parser

**File**: Express `cookie-parser` middleware

**Applied**: Line 127 in `src/server.ts`

**Purpose**: Parse cookies from `Cookie` header

**Usage**:
```typescript
app.use(cookieParser());

// In controller
const refreshToken = req.cookies.refreshToken;
```

**Use Case**: Reading refresh token for `/api/auth/refresh-tokens`

---

### 9. Passport Initialization

**File**: Passport.js middleware

**Applied**: Line 128 in `src/server.ts`

**Purpose**: Initialize OAuth strategies (Google OAuth 2.0)

**Configuration**:
```typescript
import passport from './config/passport';
app.use(passport.initialize());
```

**Strategies** (`src/config/passport.ts`):
- Google OAuth 2.0

**Usage**:
```typescript
router.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);
```

---

## Route-Specific Middleware

### auth() - Authentication Middleware

**File**: `src/middleware/auth.middleware.ts`

**Purpose**: Validate JWT and inject user context

**Usage**:
```typescript
import auth from '../middleware/auth.middleware';

router.get('/vehicles', auth(), vehicleController.getAll);
```

**Process**:
1. Extract JWT from `Authorization: Bearer <token>` header
2. Verify token signature
3. Load user from database (with cache)
4. Check user status (active, verified, onboarded)
5. Check organization status (not suspended)
6. Handle super admin impersonation
7. Inject `req.user`, `req.orgId`, `req.orgRole`

**Injected Properties**:
```typescript
req.user: IUser           // Full user document
req.orgId: string         // Organization ID
req.orgRole: string       // 'admin' | 'member' | 'viewer'
req.auth: {               // Backwards compatibility
  userId: string,
  sessionId: string,
  orgId: string,
  orgRole: string,
  getToken: () => Promise<string>
}
```

**Error Responses**:
- `401 Please authenticate` - Missing/invalid token
- `401 User not found` - Token valid but user deleted
- `403 Account Suspended` - User inactive
- `403 Email not verified` - Email verification required
- `403 Account setup incomplete` - Onboarding not completed
- `403 Your driver account is pending approval` - Driver not approved
- `403 Organization Suspended` - Organization suspended

**Whitelisted Routes** (bypass email/onboarding checks):
- `/api/auth/complete-onboarding`
- `/api/users/me`
- `/api/notifications`
- `/api/invitations/accept`
- `/api/driver-requests/my-status`

**Caching**:
- User lookups cached for 5 minutes
- Organization status cached for 5 minutes

**File**: Lines 34-178 in `src/middleware/auth.middleware.ts`

---

### requireRole() - RBAC Middleware

**File**: `src/middleware/rbac.middleware.ts`

**Purpose**: Enforce role-based access control within organization

**Usage**:
```typescript
import { requireRole, requireAdmin } from '../middleware/rbac.middleware';

router.delete('/vehicles/:id', auth(), requireAdmin, vehicleController.delete);
router.post('/leads', auth(), requireRole(['admin', 'member']), leadController.create);
```

**Exported Functions**:

**requireRole(roles)**:
```typescript
export const requireRole = (requiredRoles: string[]) => (req, res, next) => {
  const userRole = req.auth?.orgRole || req.orgRole;

  if (!userRole || !requiredRoles.includes(userRole)) {
    return next(new ApiError(403, 'Permission denied: Insufficient organization role.'));
  }

  next();
};
```

**requireAdmin** (shorthand):
```typescript
export const requireAdmin = requireRole(['admin']);
```

**requireGlobalRole** (for system-level roles):
```typescript
export const requireGlobalRole = (allowedRoles: string[]) => (req, res, next) => {
  const userRole = req.user?.role;

  if (!userRole || !allowedRoles.includes(userRole)) {
    return next(new ApiError(403, 'Permission denied: Insufficient global role.'));
  }

  next();
};

export const requireSuperAdmin = requireGlobalRole(['super_admin']);
```

**Error Response** (403 Forbidden):
```json
{
  "success": false,
  "message": "Permission denied: Insufficient organization role.",
  "statusCode": 403
}
```

---

### validate() - Request Validation Middleware

**File**: `src/middleware/validate.middleware.ts`

**Purpose**: Validate request body/params/query against Joi schema

**Usage**:
```typescript
import { validate } from '../middleware/validate.middleware';
import { createVehicleSchema } from '../validations/vehicle.validation';

router.post('/vehicles',
  auth(),
  validate(createVehicleSchema),
  vehicleController.create
);
```

**Implementation**:
```typescript
export const validate = (schema: Joi.ObjectSchema) =>
  (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body, { abortEarly: false });

    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message
      }));

      return next(new ApiError(400, 'Validation Error', errors));
    }

    req.body = value; // Use validated/sanitized data
    next();
  };
```

**Example Schema** (`src/validations/auth.validation.ts`):
```typescript
export const registerSchema = Joi.object({
  name: Joi.string().required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(8).required(),
  role: Joi.string().valid('customer', 'dealership', 'driver').optional()
});
```

**Error Response** (400 Bad Request):
```json
{
  "success": false,
  "message": "Validation Error",
  "statusCode": 400,
  "errors": [
    {
      "field": "email",
      "message": "\"email\" must be a valid email"
    },
    {
      "field": "password",
      "message": "\"password\" length must be at least 8 characters long"
    }
  ]
}
```

**Alternative: Zod** (some routes use Zod instead of Joi):
```typescript
import { z } from 'zod';

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8)
});

const validatedData = schema.parse(req.body); // Throws on error
```

---

### upload() - File Upload Middleware

**File**: `src/middleware/upload.middleware.ts`

**Purpose**: Handle multipart file uploads using Multer

**Configuration**:
```typescript
const storage = multer.memoryStorage(); // Store in memory (upload to R2)

export const uploadAvatar = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const mimetype = allowedTypes.test(file.mimetype);
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());

    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error('Only image files are allowed'));
  }
}).single('avatar');

export const uploadProofOfDelivery = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
}).array('photos', 5); // Max 5 photos
```

**Usage**:
```typescript
import { uploadAvatar } from '../middleware/upload.middleware';

router.post('/profile/avatar',
  auth(),
  uploadAvatar,
  profileController.uploadAvatar
);
```

**Accessing Files**:
```typescript
// Single file
const file = req.file; // { buffer, originalname, mimetype, size }

// Multiple files
const files = req.files; // Array of file objects
```

**Error Handling**:
```typescript
if (!req.file) {
  throw new ApiError(400, 'Please upload an image');
}

if (req.file.size > 5 * 1024 * 1024) {
  throw new ApiError(400, 'File too large (max 5MB)');
}
```

---

### authLimiter - Authentication Rate Limiter

**File**: `src/middleware/rate-limit.middleware.ts`

**Purpose**: Stricter rate limiting for auth endpoints

**Configuration**:
```typescript
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts
  message: 'Too many login attempts, please try again later.',
  store: new RedisStore({
    client: redis,
    prefix: 'rl:auth:',
  }),
});
```

**Applied To**:
- `/api/auth/register`
- `/api/auth/login`
- `/api/auth/register-dealership`

---

### otpLimiter - OTP Rate Limiter

**File**: `src/middleware/rate-limit.middleware.ts`

**Purpose**: Prevent OTP brute force attacks

**Configuration**:
```typescript
export const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 attempts
  message: 'Too many OTP attempts, please try again later.',
  store: new RedisStore({
    client: redis,
    prefix: 'rl:otp:',
  }),
});
```

**Applied To**:
- `/api/auth/verify-email`
- `/api/auth/resend-otp`

---

### webhookValidation - Stripe Webhook Middleware

**File**: `src/middleware/webhookValidation.middleware.ts`

**Purpose**: Verify Stripe webhook signatures

**Implementation**:
```typescript
export const validateStripeWebhook = (req: Request, res: Response, next: NextFunction) => {
  const sig = req.headers['stripe-signature'];
  const rawBody = req.rawBody; // From body parser verify function

  try {
    const event = stripe.webhooks.constructEvent(rawBody, sig, config.stripe.webhookSecret);
    req.stripeEvent = event;
    next();
  } catch (err) {
    logger.error({ err }, 'Webhook signature verification failed');
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
};
```

**Usage**:
```typescript
router.post('/payments/webhook',
  express.raw({ type: 'application/json' }), // Skip JSON parsing
  validateStripeWebhook,
  paymentController.handleWebhook
);
```

---

### adfValidation - ADF Email Validation

**File**: `src/middleware/adfValidation.middleware.ts`

**Purpose**: Validate ADF/XML lead emails

**Implementation**:
```typescript
export const validateADF = async (req: Request, res: Response, next: NextFunction) => {
  const xml = req.body;

  try {
    const parsed = await parseADFXML(xml);
    req.adfData = parsed;
    next();
  } catch (err) {
    return next(new ApiError(400, 'Invalid ADF format'));
  }
};
```

**Usage**:
```typescript
router.post('/leads/adf',
  express.text({ type: 'application/xml' }),
  validateADF,
  leadController.createFromADF
);
```

---

## Global Error Handler

**File**: `src/middleware/error.middleware.ts`

**Applied**: Line 144 in `src/server.ts` (MUST be last middleware)

**Purpose**: Catch all errors and format consistent responses

**Implementation**:
```typescript
export const errorHandler = (err: Error, req: Request, res: Response, next: NextFunction) => {
  let statusCode = 500;
  let message = 'Internal Server Error';
  let errors = undefined;

  // Handle ApiError instances
  if (err instanceof ApiError) {
    statusCode = err.statusCode;
    message = err.message;
    errors = err.errors;
  }

  // Handle Mongoose ValidationError
  if (err.name === 'ValidationError') {
    statusCode = 400;
    message = 'Validation Error';
    errors = Object.values(err.errors).map(e => e.message);
  }

  // Handle Mongoose CastError (invalid ObjectId)
  if (err.name === 'CastError') {
    statusCode = 400;
    message = 'Invalid ID format';
  }

  // Handle JWT errors
  if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid token';
  }

  if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Token expired';
  }

  // Log error
  logger.error({
    err,
    correlationId: req.correlationId,
    userId: req.user?._id,
    path: req.path,
  }, message);

  // Send response
  res.status(statusCode).json(
    new ApiResponse(statusCode, null, message, errors)
  );
};
```

**Error Response Format**:
```json
{
  "success": false,
  "message": "Error message",
  "statusCode": 400,
  "correlationId": "req-123-456",
  "errors": [ ... ] // Optional array of validation errors
}
```

**Never Exposed**:
- Stack traces
- Internal error details
- Database query errors (in production)

---

## Custom Middleware Examples

### Organization Context Middleware

**File**: `src/middleware/org.middleware.ts`

**Purpose**: Ensure user belongs to an organization

```typescript
export const requireOrg = (req: Request, res: Response, next: NextFunction) => {
  if (!req.orgId) {
    return next(new ApiError(403, 'You must belong to an organization to access this resource'));
  }
  next();
};
```

---

### Lead Context Middleware

**File**: `src/middleware/leadContext.middleware.ts`

**Purpose**: Load lead and attach to request

```typescript
export const loadLeadContext = async (req: Request, res: Response, next: NextFunction) => {
  const { leadId } = req.params;

  const lead = await Lead.findById(leadId);
  if (!lead) {
    return next(new ApiError(404, 'Lead not found'));
  }

  if (lead.organizationId.toString() !== req.orgId) {
    return next(new ApiError(403, 'Access denied'));
  }

  req.leadContext = { lead };
  next();
};
```

---

## Middleware Best Practices

### 1. Order Matters
Apply middleware in the correct order:
1. Rate limiting (first)
2. Logging and metrics
3. Security headers
4. Body parsing
5. Authentication
6. Authorization
7. Validation
8. Business logic (controller)
9. Error handler (last)

### 2. Fail Fast
Validate and reject invalid requests early:
```typescript
// Good
router.post('/vehicles', validate(schema), auth(), controller.create);

// Bad (wastes resources authenticating invalid requests)
router.post('/vehicles', auth(), validate(schema), controller.create);
```

### 3. Use asyncHandler
Wrap async middleware to avoid try/catch boilerplate:
```typescript
import { asyncHandler } from '../utils/asyncHandler';

export const loadUser = asyncHandler(async (req, res, next) => {
  const user = await User.findById(req.params.id);
  if (!user) throw new ApiError(404, 'User not found');
  req.loadedUser = user;
  next();
});
```

### 4. Inject, Don't Fetch
Middleware should load resources and attach to `req`:
```typescript
// Good
req.vehicle = vehicle;
next();

// Bad (controller shouldn't fetch again)
next();
```

### 5. Single Responsibility
Each middleware should do one thing:
```typescript
// Good
auth()           // Only authenticate
requireAdmin()   // Only check role

// Bad (mixing concerns)
authAndAuthorize(['admin'])
```

### 6. Error Handling
Always use `next(err)` for errors:
```typescript
// Good
if (!user) {
  return next(new ApiError(404, 'User not found'));
}

// Bad (breaks error handler)
if (!user) {
  return res.status(404).json({ error: 'Not found' });
}
```

### 7. Avoid Blocking
Never use synchronous operations in middleware:
```typescript
// Bad
const data = fs.readFileSync('/large-file.json');

// Good
const data = await fs.promises.readFile('/large-file.json');
```

## Testing Middleware

### Unit Tests

```typescript
import { auth } from '../middleware/auth.middleware';
import { createMockRequest, createMockResponse } from '../utils/test-helpers';

describe('auth middleware', () => {
  it('should inject user for valid JWT', async () => {
    const req = createMockRequest({
      headers: { authorization: 'Bearer valid_token' }
    });
    const res = createMockResponse();
    const next = jest.fn();

    await auth()(req, res, next);

    expect(req.user).toBeDefined();
    expect(next).toHaveBeenCalled();
  });

  it('should return 401 for missing token', async () => {
    const req = createMockRequest();
    const res = createMockResponse();
    const next = jest.fn();

    await auth()(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 401 })
    );
  });
});
```

### Integration Tests

```typescript
import request from 'supertest';
import app from '../server';

describe('Middleware integration', () => {
  it('should require authentication', async () => {
    const res = await request(app)
      .get('/api/vehicles')
      .expect(401);

    expect(res.body.message).toContain('authenticate');
  });

  it('should accept valid token', async () => {
    const token = generateTestToken();

    const res = await request(app)
      .get('/api/vehicles')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});
```

## Related Documentation

- [Authentication System](../features/authentication.md)
- [Authorization & RBAC](../features/authorization.md)
- [Error Handling](./error-handling.md)
- [Rate Limiting](../api/rate-limiting.md)
- [Architecture Overview](../architecture-overview.md)
