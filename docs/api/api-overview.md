# API Overview

## Base URL

```
Development: http://localhost:5000/api
Production:  https://api.actionauto.com/api
```

## Authentication

All protected endpoints require JWT authentication via Bearer token:

```http
GET /api/vehicles
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Token Lifecycle

1. **Obtain Tokens**: Login via `/api/auth/login` or `/api/auth/verify-email`
2. **Access Token**: Send in `Authorization` header (expires in 15 min)
3. **Refresh Token**: Sent as httpOnly cookie (expires in 7 days)
4. **Refresh**: Use `/api/auth/refresh-tokens` to get new access token
5. **Logout**: Call `/api/auth/logout` to invalidate session

## Request/Response Format

### Request Headers

```http
Content-Type: application/json
Authorization: Bearer <access_token>
X-Correlation-ID: <optional_request_id>
x-impersonate-org-id: <org_id> (super admin only)
```

### Success Response (ApiResponse)

```json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": { ... },
  "statusCode": 200,
  "correlationId": "req-1714096800000-abc123"
}
```

### Error Response

```json
{
  "success": false,
  "message": "Error message",
  "statusCode": 400,
  "correlationId": "req-1714096800000-abc123",
  "errors": [
    {
      "field": "email",
      "message": "Email is required"
    }
  ]
}
```

## HTTP Status Codes

- **200 OK** - Request successful
- **201 Created** - Resource created
- **400 Bad Request** - Validation error
- **401 Unauthorized** - Authentication failed
- **403 Forbidden** - Insufficient permissions
- **404 Not Found** - Resource doesn't exist
- **409 Conflict** - Duplicate resource
- **429 Too Many Requests** - Rate limit exceeded
- **500 Internal Server Error** - Server error

## Pagination

List endpoints support pagination via query parameters:

```http
GET /api/vehicles?page=1&limit=20&sort=-createdAt
```

**Response**:
```json
{
  "success": true,
  "data": {
    "results": [ ... ],
    "pagination": {
      "total": 150,
      "page": 1,
      "limit": 20,
      "totalPages": 8,
      "hasNextPage": true,
      "hasPrevPage": false
    }
  }
}
```

**Parameters**:
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10, max: 100)
- `sort` - Sort field (prefix with `-` for descending)

## Filtering

Use query parameters for filtering:

```http
GET /api/vehicles?make=Toyota&year=2023&status=Ready for Sale
```

**Common Filters**:
- Exact match: `?make=Toyota`
- Range: `?minPrice=20000&maxPrice=30000`
- Date range: `?startDate=2024-01-01&endDate=2024-12-31`
- Status: `?status=active`

## Searching

Full-text search via `search` parameter:

```http
GET /api/vehicles?search=camry
```

## API Endpoints by Feature

### Authentication (`/api/auth`)
- `POST /register` - Register new user
- `POST /register-dealership` - Register dealership
- `POST /login` - Login with credentials
- `POST /verify-email` - Verify email with OTP
- `POST /resend-otp` - Resend verification code
- `POST /refresh-tokens` - Refresh access token
- `POST /logout` - Logout and invalidate session
- `POST /forgot-password` - Request password reset
- `POST /reset-password` - Reset password with OTP
- `GET /google` - Initiate Google OAuth
- `GET /google/callback` - Google OAuth callback
- `POST /complete-onboarding` - Complete user onboarding

### Users (`/api/users`)
- `GET /me` - Get current user profile
- `PATCH /me` - Update current user profile
- `POST /me/avatar` - Upload avatar
- `GET /:id` - Get user by ID
- `PATCH /:id` - Update user
- `DELETE /:id` - Delete user

### Organizations (`/api/organizations`)
- `POST /` - Create organization
- `GET /` - List organizations
- `GET /:id` - Get organization details
- `PATCH /:id` - Update organization
- `DELETE /:id` - Delete organization
- `POST /:id/members` - Add member
- `DELETE /:id/members/:userId` - Remove member

### Vehicles (`/api/vehicles`)
- `GET /` - List vehicles (with filters, search, pagination)
- `POST /` - Create vehicle
- `GET /:id` - Get vehicle details
- `PATCH /:id` - Update vehicle
- `DELETE /:id` - Soft delete vehicle
- `POST /:id/notes` - Add note to vehicle
- `PATCH /:id/status` - Update vehicle status

### Leads (`/api/leads`)
- `GET /` - List leads
- `POST /` - Create lead
- `POST /adf` - Create lead from ADF email
- `GET /:id` - Get lead details
- `PATCH /:id` - Update lead
- `DELETE /:id` - Delete lead
- `POST /:id/assign` - Assign lead to user
- `POST /:id/comments` - Add comment

### Shipments (`/api/shipments`)
- `GET /` - List shipments
- `POST /` - Create shipment
- `GET /:id` - Get shipment details
- `PATCH /:id` - Update shipment
- `POST /:id/assign-driver` - Assign driver
- `POST /:id/tracking` - Add tracking update
- `POST /:id/proof-of-delivery` - Upload POD

### Quotes (`/api/quotes`)
- `GET /` - List quotes
- `POST /` - Create quote
- `GET /:id` - Get quote details
- `PATCH /:id` - Update quote
- `POST /:id/send` - Send quote to customer
- `POST /:id/accept` - Accept quote

### Appointments (`/api/appointments`)
- `GET /` - List appointments
- `POST /` - Create appointment
- `GET /:id` - Get appointment details
- `PATCH /:id` - Update appointment
- `DELETE /:id` - Cancel appointment

### Notifications (`/api/notifications`)
- `GET /` - List user notifications
- `PATCH /:id/read` - Mark as read
- `PATCH /mark-all-read` - Mark all as read
- `DELETE /:id` - Delete notification

### Dashboard (`/api/dashboard`)
- `GET /stats` - Get dashboard statistics
- `GET /kpis` - Get KPIs
- `GET /recent-activity` - Get recent activity

### Feed (`/api/feed`)
- `GET /` - List feed posts
- `POST /` - Create post
- `GET /:id` - Get post details
- `DELETE /:id` - Delete post
- `POST /:id/react` - React to post
- `DELETE /:id/react` - Remove reaction
- `POST /:id/comments` - Add comment

### Messaging (`/api/supraspace`)
- `GET /conversations` - List conversations
- `POST /conversations` - Create conversation
- `GET /conversations/:id` - Get conversation
- `GET /conversations/:id/messages` - List messages
- `POST /conversations/:id/messages` - Send message
- `PATCH /messages/:id/read` - Mark message as read

### Driver Management
- `POST /api/driver-requests` - Submit driver request
- `GET /api/driver-requests/my-status` - Check request status
- `GET /api/admin/driver-requests` - List pending requests (admin)
- `POST /api/admin/driver-requests/:id/approve` - Approve driver
- `POST /api/admin/driver-requests/:id/reject` - Reject driver

### Payments (`/api/payments`)
- `POST /create-payment-intent` - Create Stripe payment
- `POST /webhook` - Stripe webhook handler
- `GET /transactions` - List transactions

## Rate Limiting

**Global Limit**: 100 requests per 15 minutes per IP

**Auth Endpoints**: 5 requests per 15 minutes
- `/api/auth/login`
- `/api/auth/register`

**OTP Endpoints**: 10 requests per 15 minutes
- `/api/auth/verify-email`
- `/api/auth/resend-otp`

**Rate Limit Headers**:
```http
RateLimit-Limit: 100
RateLimit-Remaining: 95
RateLimit-Reset: 1714097700
```

**429 Response**:
```json
{
  "success": false,
  "message": "Too many requests from this IP, please try again later.",
  "statusCode": 429
}
```

## CORS

**Allowed Origins**: Configured via `CORS_ORIGIN` env variable

**Allowed Methods**: GET, POST, PUT, DELETE, PATCH, OPTIONS

**Credentials**: Supported (for cookies)

**Allowed Headers**:
- Content-Type
- Authorization
- X-Requested-With
- Accept
- Origin
- x-impersonate-org-id

## File Uploads

File uploads use `multipart/form-data` encoding:

```http
POST /api/profile/avatar
Content-Type: multipart/form-data
Authorization: Bearer <token>

---
avatar: <file>
```

**Limits**:
- Avatar: 5MB max
- Proof of Delivery: 10MB max, up to 5 files
- Documents: 10MB max

**Supported Formats**:
- Images: JPEG, PNG, GIF
- Documents: PDF

## Webhooks

### Stripe Webhooks

**Endpoint**: `POST /api/payments/webhook`

**Signature Verification**: Required (Stripe-Signature header)

**Events Handled**:
- `payment_intent.succeeded`
- `payment_intent.payment_failed`

### ADF Email Integration

**Endpoint**: `POST /api/leads/adf`

**Content-Type**: `application/xml`

**Authentication**: API key or webhook signature

## WebSockets (Socket.IO)

**Connection**:
```javascript
const socket = io('https://api.actionauto.com', {
  auth: { token: accessToken }
});
```

**Namespaces**:
- `/` - Default (feed, notifications, monitoring)
- `/supraspace` - Team messaging

**Events**:
- `vehicle_updated` - Vehicle status changed
- `new_notification` - New notification
- `new_message` - New message in conversation
- `shipment_tracking` - Shipment location update

## Error Handling

All errors returned in consistent format:

```json
{
  "success": false,
  "message": "Human-readable error message",
  "statusCode": 400,
  "correlationId": "req-123-456",
  "errors": [ ... ] // Optional validation errors
}
```

**Correlation ID**: Include in support requests for faster debugging

## Versioning

Current version: **v1** (implicit, no version prefix)

Future versions will use URL prefix: `/api/v2/...`

## Best Practices

### Client-Side
1. **Store access token in memory** (not localStorage)
2. **Implement token refresh** before expiration
3. **Include correlation ID** for request tracking
4. **Handle rate limits** with exponential backoff
5. **Validate responses** before using data

### Security
1. **Never expose refresh tokens** to client JavaScript
2. **Use HTTPS** in production
3. **Validate all input** before submission
4. **Handle 401 errors** by redirecting to login
5. **Implement CSRF protection** for state-changing operations

### Performance
1. **Use pagination** for large datasets
2. **Cache static data** (makes, models)
3. **Debounce search queries**
4. **Use WebSockets** for real-time updates
5. **Lazy load images** and attachments

## SDK/Client Libraries

Currently, no official SDKs. Use standard HTTP client:

**JavaScript/TypeScript**:
```typescript
import axios from 'axios';

const api = axios.create({
  baseURL: 'https://api.actionauto.com/api',
  headers: {
    'Authorization': `Bearer ${accessToken}`
  }
});

const vehicles = await api.get('/vehicles');
```

**Python**:
```python
import requests

headers = {'Authorization': f'Bearer {access_token}'}
response = requests.get('https://api.actionauto.com/api/vehicles', headers=headers)
```

## GraphQL (Future)

GraphQL endpoint planned for v2:
```
POST /api/graphql
```

## Related Documentation

- [Authentication System](../features/authentication.md)
- [Rate Limiting](./rate-limiting.md)
- [Database Models](./database-models.md)
- [Socket.IO Integration](../features/socket-io.md)
