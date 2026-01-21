# Copilot Instructions for ActionAutoBackend

## Project Overview
- **Type:** Node.js + TypeScript REST API
- **Frameworks:** Express, Mongoose (MongoDB), Passport (JWT)
- **Structure:** Modular, feature-based: `models/`, `routes/`, `controllers/`, `services/`, `middleware/`, `config/`
- **Purpose:** Secure, scalable authentication and vehicle data sync system

## Key Architectural Patterns
- **Authentication:**
  - JWT-based, with short-lived access tokens and long-lived refresh tokens (see `DOCUMENTATION.md`)
  - Refresh tokens are stored in MongoDB and sent as httpOnly cookies
  - Token rotation and invalidation on logout/refresh
- **Middleware:**
  - `auth` (JWT validation), `role` (RBAC), `validate` (Joi schemas), `errorHandler` (standardized error responses)
- **Config:**
  - All environment/config values validated via Joi in `src/config/index.ts`
  - Use `.env` for secrets and connection strings
- **Sync Scheduler:**
  - Background sync jobs via `node-cron` (see `src/schedulers/sync.scheduler.ts`)

## Developer Workflows
- **Run in dev:** `npm run dev` (uses `nodemon` + `ts-node`)
- **Build:** `npm run build` (outputs to `dist/`)
- **Start (prod):** `npm start` (runs compiled JS)
- **Test:** `npm test` (Jest, test files in `tests/`)
- **API Examples:** See `EXAMPLES.md` and `USAGE_GUIDE.md` for curl and JS usage patterns

## Project-Specific Conventions
- **Error Handling:** All errors are wrapped and sent via `ApiError`/`ApiResponse` and the global error middleware
- **Validation:** All incoming data is validated with Joi schemas before reaching controllers
- **Tokens:** Never store refresh tokens in localStorage; always use httpOnly cookies
- **CORS:** Allowed origins are set in `.env` (`CORS_ORIGIN`), dynamic logic in `src/server.ts`
- **Sensitive Data:** Never log secrets or stack traces to the client; see error middleware

## Integration Points
- **MongoDB:** Connection via `src/config/db.ts`, URI in `.env`
- **FTP:** External sync via `src/services/ftp.service.ts`, credentials in `.env`
- **Scheduler:** Sync jobs configured in `.env` (`SYNC_SCHEDULE`)

## File/Directory References
- `src/models/` — Mongoose schemas (User, Token, Vehicle, etc.)
- `src/controllers/` — Route logic (auth, dashboard, sync, vehicle)
- `src/services/` — Business logic (auth, sync, ftp, user, token)
- `src/routes/` — Route definitions, grouped by feature
- `src/middleware/` — Auth, validation, error, and role-based access
- `src/config/` — Environment, DB, and passport config
- `src/schedulers/` — Background sync jobs
- `tests/` — Jest test files (integration/unit)

## Examples
- See `EXAMPLES.md` for curl requests and expected responses
- See `USAGE_GUIDE.md` for frontend JS usage patterns

---
**For AI agents:**
- Always validate input and handle errors as per project conventions
- Reference `DOCUMENTATION.md` for authentication flow and security rationale
- Use the modular structure for new features (add model, service, controller, route, validation, and tests)
- Follow the established patterns for token handling, error responses, and validation
