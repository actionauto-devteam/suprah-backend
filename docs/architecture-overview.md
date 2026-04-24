# Architecture Overview

## System Overview

ActionAuto is a multi-tenant Express/TypeScript REST API platform serving as the backend for an automotive CRM and logistics ecosystem. The system handles vehicle inventory management, lead processing, shipment tracking, driver coordination, and real-time collaboration features.

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client Applications                       │
│  (Web Dashboard, Mobile Apps, External Integrations)            │
└───────────────────┬─────────────────────────────────────────────┘
                    │
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│                      Load Balancer / CDN                         │
│                    (Nginx / Cloudflare)                          │
└───────────────────┬─────────────────────────────────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌───────────────┐      ┌──────────────────┐
│  Main Server  │      │   FTP Worker     │
│ (src/server.ts)│      │(src/ftp-worker.ts)│
│               │      │                  │
│ • Express API │      │ • FTPS Server    │
│ • Socket.IO   │      │ • R2 Upload      │
│ • HTTP/HTTPS  │      │ • Inventory Sync │
└───────┬───────┘      └────────┬─────────┘
        │                       │
        └───────────┬───────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌──────────────┐        ┌──────────────┐
│   MongoDB    │        │    Redis     │
│  (Primary DB)│        │  (Cache)     │
└──────────────┘        └──────────────┘
        │
        ▼
┌──────────────────────────────────────┐
│      External Services               │
├──────────────────────────────────────┤
│ • Cloudflare R2 (File Storage)       │
│ • Stripe (Payments)                  │
│ • Google OAuth & Calendar            │
│ • Nodemailer (Email)                 │
│ • Anthropic AI (SupraLeo)            │
│ • DealersCloud (FTP Inventory)       │
└──────────────────────────────────────┘
```

## Dual Entry Points

The system runs two independent Node.js processes:

### 1. Main API Server (`src/server.ts`)
**Port**: 5000 (configurable)

**Responsibilities**:
- REST API endpoints
- Socket.IO real-time communication
- User authentication and authorization
- Business logic orchestration
- Background schedulers (sync, cleanup)

**Key Features**:
- Express.js HTTP server
- Socket.IO for real-time events
- JWT-based authentication
- Multi-tenant organization support
- Graceful shutdown handling

### 2. FTP Worker (`src/ftp-worker.ts`)
**Port**: 2121 (FTPS)

**Responsibilities**:
- FTPS server for DealersCloud inventory uploads
- Direct streaming to Cloudflare R2
- Automatic inventory sync triggering
- Stateless, cloud-native architecture

**Key Features**:
- Custom FTP server implementation
- TLS/SSL encryption support
- R2-backed filesystem (no local storage)
- Independent deployment and scaling

## Technology Stack

### Core Runtime
- **Node.js** - JavaScript runtime
- **TypeScript** - Type-safe development
- **Express.js** - Web framework

### Database & Cache
- **MongoDB** - Primary database (Mongoose ODM)
- **Redis** - Caching and rate limiting (ioredis)

### Authentication & Security
- **JWT** - Access and refresh tokens
- **Passport.js** - Google OAuth 2.0 strategy
- **WebAuthn** - Biometric authentication
- **bcrypt** - Password hashing
- **Helmet** - Security headers
- **CORS** - Cross-origin resource sharing

### File Storage
- **Cloudflare R2** - S3-compatible object storage
  - `actionauto-public` - Public assets (avatars, etc.)
  - `actionauto-private` - Private documents (signed URLs)
  - `actionauto-ftp` - Inventory files from DealersCloud

### Real-Time Communication
- **Socket.IO** - WebSocket communication
- Namespaces for different features (feed, messaging, monitoring)

### External Integrations
- **Stripe** - Payment processing
- **Google APIs** - OAuth, Calendar, Gmail
- **Anthropic SDK** - AI chat (SupraLeo feature)
- **Nodemailer** - Email delivery

### Monitoring & Logging
- **Pino** - High-performance structured logging
- **pino-http** - HTTP request logging
- **pino-roll** - Log rotation
- Custom metrics middleware (golden signals)

### Testing
- **Jest** - Test framework
- **ts-jest** - TypeScript support
- **Supertest** - HTTP assertion library

## 5-Layer Architecture Pattern

The codebase follows a strict layered architecture:

```
┌─────────────────────────────────────────┐
│            1. Routes Layer              │
│  Define endpoints, attach middleware    │
│  Files: src/routes/*.route.ts           │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│          2. Middleware Layer            │
│  Validation, Auth, RBAC, Error Handling │
│  Files: src/middleware/*.middleware.ts  │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│         3. Controllers Layer            │
│  HTTP request/response handling         │
│  Files: src/controllers/*.controller.ts │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│          4. Services Layer              │
│  Business logic, DB operations          │
│  Files: src/services/*.service.ts       │
└───────────────┬─────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────┐
│           5. Models Layer               │
│  Mongoose schemas, data validation      │
│  Files: src/models/*.model.ts           │
└─────────────────────────────────────────┘
```

### Layer Responsibilities

**1. Routes Layer**
- Define HTTP endpoints (GET, POST, PUT, DELETE)
- Register middleware chains
- Map paths to controller methods
- Centralized in `src/routes/index.ts`

**2. Middleware Layer**
- `auth.middleware.ts` - JWT validation, user injection
- `rbac.middleware.ts` - Role-based access control
- `validate.middleware.ts` - Request validation (Joi)
- `error.middleware.ts` - Global error handler
- `rate-limit.middleware.ts` - API rate limiting
- `upload.middleware.ts` - File upload handling

**3. Controllers Layer**
- Parse HTTP request
- Call service methods
- Format HTTP response (ApiResponse)
- Wrapped with `asyncHandler` for automatic error catching

**4. Services Layer**
- Business logic implementation
- Database queries (Mongoose)
- External API calls
- Data transformation
- No HTTP concerns

**5. Models Layer**
- Mongoose schemas
- Virtual fields and methods
- Pre/post hooks
- Indexes and validation

## Request Lifecycle

```
1. HTTP Request Arrives
   ↓
2. Rate Limiting (globalLimiter)
   ↓
3. Correlation ID Assignment (request tracking)
   ↓
4. Metrics Collection (latency, errors)
   ↓
5. HTTP Logging (Pino)
   ↓
6. Security Headers (Helmet)
   ↓
7. Body Parsing (JSON, XML, URL-encoded)
   ↓
8. CORS Validation
   ↓
9. Cookie Parsing
   ↓
10. Passport Initialization (OAuth)
   ↓
11. Route Matching
   ↓
12. auth() Middleware
    • Extract JWT from Authorization header
    • Verify token signature
    • Load user from MongoDB (cached)
    • Check user status (active, verified, onboarded)
    • Check organization status (not suspended)
    • Handle super admin impersonation
    • Inject req.user, req.orgId, req.orgRole
   ↓
13. RBAC Middleware (if present)
    • Validate user role matches required role
   ↓
14. Validation Middleware
    • Validate request body/params/query against Joi schema
   ↓
15. Controller Method
    • Extract data from request
    • Call service layer
    • Return ApiResponse
   ↓
16. Success Response
   OR
   Error Handler (catch ApiError, format response)
```

## Multi-Tenant Architecture

### Organization Isolation

Each organization operates in an isolated data context:

```typescript
// All queries filtered by organizationId
const vehicles = await Vehicle.find({ organizationId: req.orgId });
```

### User-Organization Relationship

```
User Model
├── organizationId (reference to Organization)
├── organizationRole ("admin" | "member" | "viewer")
└── role (global: "super_admin" | "admin" | "user" | "driver")
```

### Access Control Levels

1. **Global Roles** (`User.role`)
   - `super_admin` - Full system access, can impersonate orgs
   - `admin` - Elevated privileges across orgs
   - `user` - Standard user
   - `driver` - Driver-specific features

2. **Organization Roles** (`User.organizationRole`)
   - `admin` - Full control within organization
   - `member` - Standard access within organization
   - `viewer` - Read-only access

### Impersonation (Super Admin)

Super admins can impersonate any organization:

```http
GET /api/vehicles
Authorization: Bearer <super_admin_token>
x-impersonate-org-id: 507f1f77bcf86cd799439011
```

The `auth()` middleware switches context to the target organization.

## Authentication System

### Dual-Token JWT System

**Access Token** (short-lived: 15 minutes)
- Sent in `Authorization: Bearer <token>` header
- Contains: `{ sub: userId, orgId, role }`
- Used for API authentication

**Refresh Token** (long-lived: 7 days)
- Stored as httpOnly cookie (`refreshToken`)
- Stored in MongoDB `Session` collection
- Rotated on each refresh
- Invalidated on logout

### Authentication Flow

```
1. POST /api/auth/login
   ↓
2. Validate credentials (bcrypt)
   ↓
3. Generate access + refresh tokens
   ↓
4. Store refresh token in DB (Session model)
   ↓
5. Set httpOnly cookie with refresh token
   ↓
6. Return access token in response body
   ↓
7. Client stores access token (memory, not localStorage)
   ↓
8. Access token expires after 15 min
   ↓
9. POST /api/auth/refresh (sends cookie automatically)
   ↓
10. Validate refresh token from cookie
   ↓
11. Generate new access + refresh tokens
   ↓
12. Invalidate old refresh token
   ↓
13. Return new access token
```

### Google OAuth Flow

```
1. GET /api/auth/google (redirect to Google)
   ↓
2. User authenticates with Google
   ↓
3. GET /api/auth/google/callback
   ↓
4. Exchange code for Google profile
   ↓
5. Find or create user in MongoDB
   ↓
6. Generate access + refresh tokens
   ↓
7. Redirect to frontend with tokens
```

## Database Schema Design

### Core Collections

**Users** - System users
- Authentication credentials
- Organization membership
- Roles and permissions
- Onboarding status

**Organizations** - Multi-tenant entities
- Company/dealer information
- Subscription status
- Settings and preferences

**Vehicles** - Inventory items
- Organization-scoped
- Searchable fields (make, model, year, VIN)
- Sync metadata

**Leads** - Sales opportunities
- ADF email integration
- Pipeline stages
- Organization-scoped

**Shipments** - Transport orders
- Origin/destination
- Driver assignment
- Real-time tracking

**Loads** - Carrier load boards
- Multiple vehicles per load
- Bidding and matching

**SupraSpaceConversation** - Team messaging
- Organization chat rooms
- Real-time via Socket.IO

**Notifications** - User alerts
- Type-based (info, success, warning, error)
- Read/unread tracking

### Relationships

```
Organization
  ↓ (1:N)
  Users
  Vehicles
  Leads
  Shipments

User
  ↓ (1:N)
  Notifications
  ActivityLogs
  Sessions (JWT refresh tokens)

Shipment
  ↓ (N:1)
  DriverProfile (assigned driver)
  Quote (associated quote)
```

## Caching Strategy

### Redis Usage

1. **Rate Limiting** - IP-based request throttling
2. **User Authentication Cache** - Reduce DB queries for user lookups
3. **Organization Status Cache** - Cache org suspension status
4. **Query Results** - Cache expensive queries (KPIs, analytics)

### Cache Patterns

```typescript
// Example: User lookup cache
const cachedUser = userAuthCache.get(userId);
if (cachedUser) {
  return cachedUser;
}
const user = await User.findById(userId);
userAuthCache.set(userId, user);
```

**TTL Strategy**:
- User auth cache: 5 minutes
- Organization status: 5 minutes
- Analytics: 15 minutes

## File Storage Architecture

### Cloudflare R2 Buckets

**actionauto-public**
- User avatars
- Feed post images
- Public vehicle photos
- Direct URL access via CDN

**actionauto-private**
- Driver documents (licenses, insurance)
- Proof of delivery photos
- Sensitive customer documents
- Access via signed URLs (15-min expiry)

**actionauto-ftp**
- DealersCloud inventory files
- Uploaded via FTP worker
- Processed and archived

### Upload Flow

```
1. Client uploads file via multipart/form-data
   ↓
2. Multer middleware captures file
   ↓
3. storageService.upload(file, folder, bucketType)
   ↓
4. Upload to R2 via AWS SDK
   ↓
5. Return public URL or private key
   ↓
6. Store URL/key in MongoDB document
```

### Local Fallback

If R2 is not configured (development), files are saved to `./uploads/` directory.

## Real-Time Communication

### Socket.IO Namespaces

**Default Namespace** (`/`)
- User-specific rooms: `user:{userId}`
- Organization rooms: `org:{orgId}`
- Shipment tracking: `shipment:{shipmentId}`
- Conversation rooms: `conversation:{conversationId}`

**SupraSpace Namespace** (`/supraspace`)
- Team messaging
- Typing indicators
- Read receipts

**Feed Namespace** (`/feed`)
- Real-time post updates
- Reaction notifications
- Comment additions

### Authentication

Socket.IO connections require JWT in handshake:

```javascript
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  const decoded = jwt.verify(token, config.jwt.accessSecret);
  socket.userId = decoded.sub;
  next();
});
```

## Background Jobs

### Cron Schedulers

**Sync Scheduler** (`src/schedulers/sync.scheduler.ts`)
- Runs: Daily at midnight (configurable)
- Fetches inventory from DealersCloud FTP
- Updates vehicle database
- Archives old files

**Cleanup Scheduler** (`src/schedulers/cleanup.scheduler.ts`)
- Runs: Daily
- Deletes expired sessions
- Removes old activity logs
- Cleans up temporary files

### Manual Triggers

Admins can trigger sync via:
```
POST /api/sync/trigger
```

## Error Handling

### ApiError Class

```typescript
class ApiError extends Error {
  statusCode: number;
  isOperational: boolean;
}

throw new ApiError(404, 'Vehicle not found');
```

### Global Error Handler

All errors flow through `src/middleware/error.middleware.ts`:

```typescript
app.use(errorHandler);

// Converts errors to standardized format:
{
  success: false,
  message: "Error message",
  statusCode: 400,
  correlationId: "req-123-456"
}
```

### Error Types

1. **Validation Errors** (400) - Joi schema failures
2. **Authentication Errors** (401) - Invalid/missing JWT
3. **Authorization Errors** (403) - Insufficient permissions
4. **Not Found Errors** (404) - Resource doesn't exist
5. **Conflict Errors** (409) - Duplicate resources
6. **Server Errors** (500) - Unexpected failures

## Security Measures

### Authentication Security
- JWT tokens with short expiration
- Refresh token rotation
- httpOnly cookies (XSS protection)
- Password hashing with bcrypt (10 rounds)

### API Security
- Rate limiting (100 req/15min per IP)
- Helmet security headers
- CORS origin validation
- Input validation (Joi schemas)
- SQL injection protection (Mongoose)

### Organization Security
- Data isolation by organizationId
- Super admin impersonation audit logs
- Organization suspension checks
- Email verification requirements

### File Security
- Private bucket with signed URLs
- File type validation
- File size limits (512KB for API requests)
- Virus scanning (recommended for production)

## Monitoring & Observability

### Structured Logging (Pino)

```typescript
logger.info({ userId, action: 'login' }, 'User logged in');
logger.error({ err, correlationId }, 'Database query failed');
```

**Log Levels**:
- `fatal` - System crash
- `error` - Operation failed
- `warn` - Potential issue
- `info` - Normal operation
- `debug` - Detailed diagnostic
- `trace` - Ultra-detailed

### Metrics Collection

**Golden Signals** tracked by metrics middleware:
1. **Latency** - Request duration
2. **Traffic** - Request rate
3. **Errors** - Error rate
4. **Saturation** - Resource usage

### Correlation IDs

Every request assigned a unique ID for distributed tracing:

```
X-Correlation-ID: req-1714096800000-abc123
```

## Deployment Architecture

### Production Setup

```
┌─────────────────┐
│   Cloudflare    │ (CDN, DDoS protection)
└────────┬────────┘
         │
┌────────▼────────┐
│     Nginx       │ (Reverse proxy, SSL termination)
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
┌───▼──┐  ┌──▼───┐
│ API  │  │ FTP  │ (Separate processes)
│ Node │  │ Node │
└───┬──┘  └──┬───┘
    │        │
┌───▼────────▼───┐
│   MongoDB      │ (Replica set)
└────────────────┘
┌────────────────┐
│     Redis      │ (Cluster mode)
└────────────────┘
```

### Environment Variables

See [Environment Configuration](./guides/environment-configuration.md) for complete reference.

### Graceful Shutdown

Both processes handle `SIGTERM` and `SIGINT`:

```typescript
process.on('SIGTERM', async () => {
  await disconnectDB();
  await cacheService.disconnect();
  process.exit(0);
});
```

## Scalability Considerations

### Horizontal Scaling
- Stateless API servers (scale via load balancer)
- Socket.IO with Redis adapter for multi-server
- FTP worker can run multiple instances (different ports)

### Database Optimization
- Indexed fields (organizationId, userId, VIN, status)
- Lean queries for read operations
- Aggregation pipelines for analytics

### Caching Strategy
- Redis for hot data
- TTL-based invalidation
- Cache-aside pattern

## Development Workflow

### Local Development
```bash
npm run dev          # API server with hot-reload
npm run dev:ftp      # FTP worker with hot-reload
```

### Testing
```bash
npm test             # Run all tests
npm run test:watch   # Watch mode
```

### Building
```bash
npm run build        # Compile TypeScript
npm start            # Run production build
```

## Key Design Decisions

1. **Dual Processes** - Separate FTP worker for better isolation and scaling
2. **JWT over Sessions** - Stateless authentication for horizontal scaling
3. **R2 over S3** - Lower costs, better performance for Cloudflare CDN
4. **Mongoose over TypeORM** - Better MongoDB support, richer schema features
5. **Pino over Winston** - 5x faster, structured JSON logging
6. **Joi over Zod** - More mature, better documentation (though Zod is available)
7. **Socket.IO over WebSockets** - Fallback support, easier room management

## Future Enhancements

- [ ] GraphQL API layer
- [ ] Pub/sub for distributed events (Redis Streams)
- [ ] OpenTelemetry for distributed tracing
- [ ] Database read replicas
- [ ] Message queue for async jobs (Bull/BullMQ)
- [ ] API versioning (v2)
