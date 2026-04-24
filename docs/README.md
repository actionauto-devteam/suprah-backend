# ActionAuto Backend Documentation

Comprehensive documentation for the ActionAuto automotive CRM and logistics platform backend.

## Table of Contents

### Core Documentation
- [Architecture Overview](./architecture-overview.md) - System design, tech stack, and architectural patterns
- [Getting Started](./guides/getting-started.md) - Setup and development guide
- [Environment Configuration](./guides/environment-configuration.md) - Complete env variable reference
- [Testing Guide](./guides/testing-guide.md) - Testing strategies and how to run tests

### API Documentation
- [API Overview](./api/api-overview.md) - API conventions and request/response patterns
- [Authentication API](./api/authentication.md) - JWT dual-token system and Google OAuth
- [Rate Limiting](./api/rate-limiting.md) - Rate limiting strategies and configuration

### Features

#### Authentication & Authorization
- [Authentication System](./features/authentication.md) - JWT dual-token, Google OAuth, session management
- [Authorization & RBAC](./features/authorization.md) - Role-based access control, multi-tenant permissions
- [User Management](./features/user-management.md) - User CRUD, profiles, onboarding

#### Multi-Tenancy
- [Organization Management](./features/organization-management.md) - Multi-tenant architecture, org CRUD
- [Invitations](./features/invitations.md) - Team member invitations and onboarding

#### Vehicle & Inventory Management
- [Vehicle Inventory](./features/vehicle-inventory.md) - Vehicle CRUD, search, filtering
- [DealersCloud Sync](./features/dealerscloud-sync.md) - FTP worker, inventory synchronization
- [Owned Vehicles](./features/owned-vehicles.md) - Customer vehicle management

#### CRM & Lead Management
- [Lead Management](./features/lead-management.md) - Lead pipeline, ADF email integration
- [Customer Management](./features/customer-management.md) - Customer profiles, booking, service history
- [CRM Users](./features/crm-users.md) - CRM-specific user management
- [Appointments](./features/appointments.md) - Service appointment scheduling

#### Logistics & Transportation
- [Shipment Management](./features/shipment-management.md) - Shipment lifecycle, tracking
- [Load Management](./features/load-management.md) - Load boards, carrier matching
- [Quote System](./features/quote-system.md) - Transport quotes and pricing
- [Driver Management](./features/driver-management.md) - Driver profiles, requests, tracking
- [Driver Payouts](./features/driver-payouts.md) - Payment processing for drivers

#### Real-Time Features
- [Socket.IO Integration](./features/socket-io.md) - Real-time events, namespaces
- [SupraSpace Messaging](./features/supraspace.md) - Team collaboration and messaging
- [Feed System](./features/feed-system.md) - Social feed with reactions and comments
- [Notifications](./features/notifications.md) - Real-time and persistent notifications

#### External Integrations
- [Cloudflare R2 Storage](./features/cloudflare-r2.md) - File storage and CDN
- [Stripe Payments](./features/stripe-payments.md) - Payment processing and webhooks
- [Google Calendar](./features/google-calendar.md) - Calendar integration
- [Email Service](./features/email-service.md) - Transactional emails via Nodemailer
- [Redis Caching](./features/redis-caching.md) - Caching and rate limiting

#### Analytics & Monitoring
- [Dashboard & Analytics](./features/dashboard-analytics.md) - KPIs, metrics, reporting
- [Activity Logging](./features/activity-logging.md) - Audit trails and user activity
- [Monitoring & Logging](../monitoring_logging_docs.md) - Observability and error tracking

#### Advanced Features
- [SupraLeo AI](./features/supraleo-ai.md) - AI-powered chat assistant
- [Biometric Authentication](./features/biometric-auth.md) - WebAuthn/fingerprint auth
- [Time Tracking](./features/time-tracking.md) - Employee time proof and tracking
- [Service Management](./features/service-management.md) - Service locations and records
- [Wallet System](./features/wallet-system.md) - Customer wallet and credits

### Technical Reference
- [Database Models](./api/database-models.md) - Mongoose schemas and relationships
- [Middleware Stack](./guides/middleware-stack.md) - Request lifecycle and middleware
- [Error Handling](./guides/error-handling.md) - Error patterns and ApiError usage
- [Background Jobs](./guides/background-jobs.md) - Cron schedulers and cleanup tasks
- [FTP Worker](./guides/ftp-worker.md) - Standalone FTP server architecture

## Quick Links

### Development Commands
```bash
# Development
npm run dev           # Start API server with hot-reload (port 5000)
npm run dev:ftp       # Start FTP worker with hot-reload

# Production
npm run build         # Compile TypeScript to dist/
npm start             # Run compiled API server
npm run start:ftp     # Run compiled FTP worker

# Testing
npm test              # Run all Jest tests
npm run test:watch    # Jest in watch mode

# Database
npm run seed:dev      # Seed development database
```

### Key Directories
```
src/
├── config/          # Environment config, database, passport, CORS
├── controllers/     # HTTP request handlers
├── middleware/      # Auth, RBAC, validation, error handling
├── models/          # Mongoose schemas
├── routes/          # API route definitions
├── services/        # Business logic layer
├── socket/          # Socket.IO namespaces and handlers
├── utils/           # Helper functions, logger, ApiError
├── validations/     # Joi validation schemas
├── schedulers/      # Cron jobs for sync and cleanup
├── jobs/            # Background job definitions
└── scripts/         # Migration and utility scripts
```

## Architecture Patterns

This codebase follows a **5-layer architecture**:

1. **Routes** - Define endpoints and attach middleware
2. **Middleware** - Validation, authentication, authorization
3. **Controllers** - HTTP request/response handling
4. **Services** - Business logic and database operations
5. **Models** - Mongoose schemas and data validation

## Key Technologies

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: MongoDB with Mongoose ODM
- **Real-time**: Socket.IO
- **Authentication**: JWT (dual-token), Google OAuth 2.0, WebAuthn
- **File Storage**: Cloudflare R2 (S3-compatible)
- **Cache/Queue**: Redis (ioredis)
- **Payments**: Stripe
- **Email**: Nodemailer
- **Logging**: Pino
- **Validation**: Joi
- **Testing**: Jest with ts-jest

## Multi-Tenant Architecture

The system is designed for multi-tenancy with organization-level isolation:

- Each user belongs to an organization (`organizationId`)
- Data is filtered by organization context
- Super admins can impersonate organizations via `x-impersonate-org-id` header
- Organization roles control permissions within an org

## Authentication Flow

1. User logs in with email/password or Google OAuth
2. Server generates access token (15 min) and refresh token (7 days)
3. Access token sent in `Authorization: Bearer <token>` header
4. Refresh token stored as httpOnly cookie
5. `auth()` middleware validates JWT and injects `req.user`, `req.orgId`, `req.orgRole`
6. RBAC middleware enforces role-based permissions

## Request Lifecycle

```
HTTP Request
  → Rate Limiter (protect against abuse)
  → Correlation ID (request tracking)
  → Metrics Middleware (golden signals)
  → HTTP Logger (structured logging)
  → Helmet (security headers)
  → Body Parsers (JSON, URL-encoded, XML)
  → CORS (origin validation)
  → Cookie Parser
  → Passport (OAuth strategies)
  → Route Handler
  → auth() middleware (JWT validation)
  → RBAC middleware (permission check)
  → Validation middleware (Joi schemas)
  → Controller (business logic delegation)
  → Service (database operations)
  → Response (ApiResponse format)
  → Error Handler (catch all errors)
```

## Contributing

When adding new features:

1. Create all 5 layers: Model → Validation → Service → Controller → Route
2. Follow existing patterns and naming conventions
3. Use `ApiError` for error handling
4. Wrap async controllers with `asyncHandler`
5. Add Joi validation schemas
6. Write unit tests
7. Update this documentation

## Support

For questions or issues, refer to the detailed feature documentation or contact the development team.
