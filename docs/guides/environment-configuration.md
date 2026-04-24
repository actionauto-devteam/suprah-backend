# Environment Configuration

## Overview

All environment variables are validated at server startup using Joi schemas in `src/config/index.ts`. Invalid or missing required variables will prevent the server from starting.

## Configuration Files

- `.env` - Main configuration file (gitignored)
- `.env.example` - Template with all available variables
- `.env.local` - Optional local overrides (takes precedence)

**Load Order**: `.env.local` → `.env` → Default values

## Required Variables

These must be set in production:

```bash
# Node Environment
NODE_ENV=production

# Server
PORT=5000
FRONTEND_URL=https://app.actionauto.com
BACKEND_URL=https://api.actionauto.com

# Database
MONGODB_URI=mongodb://user:pass@host:27017/actionauto?replicaSet=rs0

# JWT Secrets (MUST be strong random strings)
JWT_ACCESS_SECRET=<generate-with-openssl-rand-base64-32>
JWT_REFRESH_SECRET=<generate-with-openssl-rand-base64-32>

# Cloudflare R2
R2_ACCESS_KEY_ID=your_r2_access_key
R2_SECRET_ACCESS_KEY=your_r2_secret_key
R2_ENDPOINT=https://account_id.r2.cloudflarestorage.com

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
```

## Complete Reference

### Server Configuration

```bash
# Environment mode
NODE_ENV=development  # Options: development, production, test
# Default: none (required)

# Server port
PORT=5000
# Default: 3000

# Frontend URL for CORS and redirects
FRONTEND_URL=http://localhost:3000
# Default: none (required)

# Backend URL for OAuth callbacks
BACKEND_URL=http://localhost:5000
# Default: none (required)

# CORS allowed origins (comma-separated)
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
# Default: http://localhost:3000
```

**Validation** (`src/config/index.ts:11-13`):
```typescript
NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
PORT: Joi.number().default(3000),
FRONTEND_URL: Joi.string().required().description('Frontend URL'),
```

---

### Database Configuration

```bash
# MongoDB connection string
MONGODB_URI=mongodb://localhost:27017/action-auto-backend
# Format: mongodb://[user:pass@]host:port/database[?options]
# Required

# MongoDB test database (for Jest tests)
MONGODB_URI_TEST=mongodb://localhost:27017/action-auto-test
# Optional: Falls back to MONGODB_URI if not set
```

**Connection Options** (`src/config/index.ts:91-96`):
```typescript
mongoose: {
  url: envVars.NODE_ENV === 'test' && envVars.MONGODB_URI_TEST
    ? envVars.MONGODB_URI_TEST
    : envVars.MONGODB_URI,
  options: {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
}
```

**Connection** (`src/config/db.ts`):
```typescript
await mongoose.connect(config.mongoose.url);
```

---

### Authentication Configuration

```bash
# JWT Access Token Secret
JWT_ACCESS_SECRET=your_access_secret_here_min_32_chars
# Required in production
# Default: '' (development only)

# JWT Access Token Expiration
JWT_ACCESS_EXPIRATION=15m
# Format: https://github.com/vercel/ms
# Examples: 15m, 1h, 7d
# Default: 15m

# JWT Refresh Token Secret
JWT_REFRESH_SECRET=your_refresh_secret_here_min_32_chars
# Required in production
# Default: '' (development only)

# JWT Refresh Token Expiration
JWT_REFRESH_EXPIRATION=7d
# Default: 7d

# Bcrypt Salt Rounds
BCRYPT_SALT_ROUNDS=10
# Default: none (required)
# Higher = more secure but slower
# Recommended: 10-12

# CRM JWT Secret (for CRM-specific features)
CRM_JWT_SECRET=your_crm_jwt_secret
# Optional
# Default: ''
```

**Token Generation** (`src/services/token.service.ts:10-18`):
```typescript
generateAccessToken(user: IUser): string {
  return jwt.sign(
    { sub: user._id.toString(), orgId: user.organizationId?.toString(), role: user.role },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessExpiration }
  );
}
```

**Generate Strong Secrets**:
```bash
# On Linux/Mac
openssl rand -base64 32

# On Windows PowerShell
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Minimum 0 -Maximum 256 }))
```

---

### Google OAuth Configuration

```bash
# Google Client ID
GOOGLE_CLIENT_ID=123456789-abcdefg.apps.googleusercontent.com
# Optional
# Default: ''

# Google Client Secret
GOOGLE_CLIENT_SECRET=your_google_client_secret
# Optional
# Default: ''

# Google OAuth Redirect URI
GOOGLE_REDIRECT_URI=http://localhost:5000/api/auth/google/callback
# Optional
# Default: ''
```

**Setup Instructions**:
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create project → Enable Google+ API
3. Create OAuth 2.0 credentials
4. Add authorized redirect URI: `{BACKEND_URL}/api/auth/google/callback`
5. Copy Client ID and Client Secret to `.env`

**Passport Configuration** (`src/config/passport.ts`):
```typescript
passport.use(new GoogleStrategy({
  clientID: config.google.clientId,
  clientSecret: config.google.clientSecret,
  callbackURL: `${config.backendUrl}/api/auth/google/callback`
}, async (accessToken, refreshToken, profile, done) => {
  // Find or create user
}));
```

---

### Cloudflare R2 Configuration

```bash
# R2 Access Key ID
R2_ACCESS_KEY_ID=your_r2_access_key_id
# Required in production
# Default: ''

# R2 Secret Access Key
R2_SECRET_ACCESS_KEY=your_r2_secret_access_key
# Required in production
# Default: ''

# R2 Endpoint URL
R2_ENDPOINT=https://abc123.r2.cloudflarestorage.com
# Required in production
# Default: ''
# Format: https://[account_id].r2.cloudflarestorage.com

# R2 Public Bucket Name
R2_BUCKET_PUBLIC=actionauto-public
# Default: actionauto-public

# R2 Private Bucket Name
R2_BUCKET_PRIVATE=actionauto-private
# Default: actionauto-private

# R2 FTP Bucket Name
R2_BUCKET_FTP=actionauto-ftp
# Default: actionauto-ftp

# R2 Public URL (CDN domain)
R2_PUBLIC_URL=https://cdn.actionauto.com
# Optional
# Default: ''
# Used to construct public file URLs
```

**S3 Client Setup** (`src/services/storage.service.ts:35-44`):
```typescript
this.s3Client = new S3Client({
  region: 'auto',
  endpoint: config.r2.endpoint,
  credentials: {
    accessKeyId: config.r2.accessKeyId,
    secretAccessKey: config.r2.secretAccessKey,
  },
});
```

**Bucket Usage**:
- `actionauto-public` - User avatars, feed images, public vehicle photos
- `actionauto-private` - Driver documents, proof of delivery (signed URLs)
- `actionauto-ftp` - DealersCloud inventory uploads

---

### Stripe Configuration

```bash
# Stripe Secret Key
STRIPE_SECRET_KEY=sk_test_... (dev) or sk_live_... (prod)
# Required

# Stripe Publishable Key
STRIPE_PUBLISHABLE_KEY=pk_test_... (dev) or pk_live_... (prod)
# Required

# Stripe Webhook Secret
STRIPE_WEBHOOK_SECRET=whsec_...
# Optional
# Default: ''
# Required for webhook signature verification
```

**Get Webhook Secret**:
1. Go to Stripe Dashboard → Developers → Webhooks
2. Add endpoint: `{BACKEND_URL}/api/payments/webhook`
3. Select events: `payment_intent.succeeded`, `payment_intent.payment_failed`
4. Copy signing secret to `STRIPE_WEBHOOK_SECRET`

**Client Initialization** (`src/services/payment.service.ts`):
```typescript
import Stripe from 'stripe';
const stripe = new Stripe(config.stripe.secretKey);
```

---

### Redis Configuration

```bash
# Enable/Disable Redis
REDIS_ENABLED=true
# Default: true

# Redis Host
REDIS_HOST=127.0.0.1
# Default: 127.0.0.1

# Redis Port
REDIS_PORT=6379
# Default: 6379

# Redis Password
REDIS_PASSWORD=your_redis_password
# Optional
# Default: '' (no auth)
```

**Connection** (`src/services/cache.service.ts`):
```typescript
const redis = new Redis({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password || undefined,
});
```

**Use Cases**:
- Rate limiting (express-rate-limit store)
- User authentication cache
- Organization status cache
- Query result caching
- Session storage (future)

---

### Email Configuration

```bash
# SMTP Host
SMTP_HOST=smtp.gmail.com
# Optional
# Default: ''

# SMTP Port
SMTP_PORT=587
# Optional
# Default: ''

# SMTP Secure (use TLS)
SMTP_SECURE=false
# Optional
# Default: ''

# SMTP Username
SMTP_USER=your_email@gmail.com
# Optional
# Default: ''

# SMTP Password
SMTP_PASS=your_app_password
# Optional
# Default: ''
```

**Nodemailer Setup** (`src/services/email.service.ts`):
```typescript
const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.secure,
  auth: {
    user: config.email.user,
    pass: config.email.pass,
  },
});
```

**Gmail Setup**:
1. Enable 2-factor authentication
2. Generate App Password: Google Account → Security → App Passwords
3. Use app password in `SMTP_PASS`

**SendGrid Alternative**:
```bash
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your_sendgrid_api_key
```

---

### FTP Worker Configuration

```bash
# FTP Server Port
FTP_SERVER_PORT=2121
# Optional (not in main config validation)
# Used by ftp-worker.ts

# FTP Passive Port Range
FTP_PASV_MAX=21010
# Default: 21010

# FTP Username
FTP_SERVER_USER=dealerscloud
# Default: dealerscloud

# FTP Password
FTP_SERVER_PASSWORD=your_secure_password
# Default: changeme123

# Force TLS/SSL
FTP_FORCE_TLS=true
# Default: false

# TLS Certificate Path
FTP_TLS_CERT_PATH=/path/to/cert.pem
# Optional
# Default: ''

# TLS Key Path
FTP_TLS_KEY_PATH=/path/to/key.pem
# Optional
# Default: ''
```

**Generate Self-Signed Cert** (development):
```bash
openssl req -nodes -new -x509 -keyout key.pem -out cert.pem -days 365
```

**FTP Server Config** (`src/config/ftp-server.config.ts`):
```typescript
{
  url: process.env.FTP_PASSIVE_URL || '127.0.0.1',
  pasv_url: process.env.FTP_PASSIVE_URL || '127.0.0.1',
  pasv_min: parseInt(process.env.FTP_PASV_MIN || '21000'),
  pasv_max: parseInt(process.env.FTP_PASV_MAX || '21010'),
  tls: process.env.FTP_FORCE_TLS === 'true' ? {
    key: fs.readFileSync(process.env.FTP_TLS_KEY_PATH!),
    cert: fs.readFileSync(process.env.FTP_TLS_CERT_PATH!)
  } : false
}
```

---

### DealersCloud FTP Configuration

```bash
# DealersCloud FTP Host
DEALERSCLOUD_FTP_HOST=ftp.dealerscloud.com
# Default: ''

# DealersCloud FTP Username
DEALERSCLOUD_FTP_USER=your_username
# Default: ''

# DealersCloud FTP Password
DEALERSCLOUD_FTP_PASSWORD=your_password
# Default: ''

# DealersCloud FTP File Name
DEALERSCLOUD_FTP_FILE=DealerCloud.txt
# Default: DealerCloud.txt
```

**Used By**: `src/services/ftp.service.ts` for pulling inventory

---

### Sync Scheduler Configuration

```bash
# Cron Schedule Expression
SYNC_SCHEDULE=0 0 * * *
# Default: 0 0 * * * (daily at midnight)
# Format: minute hour day month weekday
# Examples:
#   0 0 * * *      - Daily at midnight
#   0 */6 * * *    - Every 6 hours
#   0 0 * * 0      - Weekly on Sunday
#   0 3 */2 * *    - Every 2 days at 3 AM
```

**Scheduler** (`src/schedulers/sync.scheduler.ts`):
```typescript
cron.schedule(config.sync.schedule, async () => {
  await syncService.syncFromDealersCloud();
});
```

## Configuration Validation

All variables validated at startup (`src/config/index.ts:9-78`):

```typescript
const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(3000),
    FRONTEND_URL: Joi.string().required().description('Frontend URL'),
    // ... all other variables
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}
```

**Behavior**:
- Server crashes if validation fails
- Default values applied where specified
- Conditional requirements based on `NODE_ENV`

## Environment-Specific Defaults

### Development
- Relaxed JWT secret requirements
- CORS allows all origins
- Socket.IO allows connections without tokens
- Local file storage fallback enabled

### Production
- Strict JWT secret requirements (32+ chars)
- CORS restricted to specified origins
- Socket.IO requires valid JWT
- R2 cloud storage required
- HTTPS required for cookies (`secure: true`)

### Test
- Separate MongoDB database (`MONGODB_URI_TEST`)
- In-memory caching
- Mocked external services

## Accessing Configuration

**DO NOT** use `process.env` directly in code.

**USE** the validated config object:

```typescript
import config from './config';

console.log(config.env);           // 'development'
console.log(config.port);          // 5000
console.log(config.mongoose.url);  // MongoDB URI
console.log(config.jwt.accessSecret);
console.log(config.r2.buckets.public);
```

**Benefits**:
- Type safety
- Validation guarantees
- Centralized defaults
- Easy testing (mock config)

## Docker Environment Variables

### docker-compose.yml

```yaml
version: '3.8'
services:
  api:
    build: .
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - PORT=5000
    ports:
      - "5000:5000"

  ftp-worker:
    build:
      context: .
      dockerfile: Dockerfile.ftp
    env_file:
      - .env
    ports:
      - "2121:2121"
      - "21000-21010:21000-21010"
```

### Dockerfile

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .
RUN npm run build

ENV NODE_ENV=production

CMD ["npm", "start"]
```

## Secrets Management

### Development
Store in `.env` file (gitignored)

### Production Options

**1. Environment Variables** (simplest)
```bash
export JWT_ACCESS_SECRET="..."
export JWT_REFRESH_SECRET="..."
npm start
```

**2. Docker Secrets**
```yaml
secrets:
  jwt_access_secret:
    external: true
  jwt_refresh_secret:
    external: true

services:
  api:
    secrets:
      - jwt_access_secret
      - jwt_refresh_secret
```

**3. AWS Secrets Manager**
```typescript
import { SecretsManager } from '@aws-sdk/client-secrets-manager';

const secrets = await secretsManager.getSecretValue({ SecretId: 'actionauto/prod' });
process.env.JWT_ACCESS_SECRET = JSON.parse(secrets.SecretString).JWT_ACCESS_SECRET;
```

**4. HashiCorp Vault**
```typescript
const vault = require('node-vault')();
const secrets = await vault.read('secret/data/actionauto');
process.env.JWT_ACCESS_SECRET = secrets.data.JWT_ACCESS_SECRET;
```

## Troubleshooting

### Server Won't Start

**Error**: `Config validation error: "JWT_ACCESS_SECRET" is required`

**Solution**: Add required variable to `.env`:
```bash
JWT_ACCESS_SECRET=your_secret_here
```

---

**Error**: `MongooseServerSelectionError: connect ECONNREFUSED 127.0.0.1:27017`

**Solution**:
1. Ensure MongoDB is running: `mongod`
2. Verify `MONGODB_URI` in `.env`

---

**Error**: `R2 upload failed: InvalidAccessKeyId`

**Solution**: Verify R2 credentials:
```bash
# Test with AWS CLI
aws s3 ls s3://actionauto-public \
  --endpoint-url $R2_ENDPOINT \
  --profile r2
```

### CORS Errors

**Error**: `Origin http://localhost:3001 not allowed by CORS`

**Solution**: Add origin to `CORS_ORIGIN`:
```bash
CORS_ORIGIN=http://localhost:3000,http://localhost:3001
```

### Email Not Sending

**Error**: `Invalid login: 535-5.7.8 Username and Password not accepted`

**Solution**: For Gmail, use App Password:
1. Enable 2FA
2. Generate App Password
3. Use app password in `SMTP_PASS`

## Best Practices

1. **Never commit `.env`** - Add to `.gitignore`
2. **Use `.env.example`** - Document all variables
3. **Rotate secrets regularly** - Especially JWT secrets
4. **Different secrets per environment** - dev != staging != prod
5. **Principle of least privilege** - Only grant necessary permissions
6. **Monitor config changes** - Audit log changes in production
7. **Validate early** - Fail fast at startup, not at runtime
8. **Document defaults** - Make defaults explicit
9. **Use strong secrets** - Minimum 32 chars, random
10. **Encrypt secrets at rest** - Use secrets manager in production

## Related Documentation

- [Architecture Overview](../architecture-overview.md)
- [Getting Started](./getting-started.md)
- [FTP Worker](./ftp-worker.md)
- [Cloudflare R2 Storage](../features/cloudflare-r2.md)
- [Email Service](../features/email-service.md)
