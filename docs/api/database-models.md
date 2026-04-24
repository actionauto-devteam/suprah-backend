# Database Models

## Overview

The ActionAuto platform uses MongoDB with Mongoose ODM for data modeling. The database follows a multi-tenant architecture where most collections are scoped by `organizationId`.

## Schema Design Principles

1. **Multi-Tenancy**: Most models include `organizationId` field for data isolation
2. **Soft Deletes**: Use `isDeleted` flag instead of hard deletes
3. **Timestamps**: All models have `createdAt` and `updatedAt` (via `timestamps: true`)
4. **References**: Use ObjectId references for relationships
5. **Indexes**: Strategic indexes on query fields (organizationId, status, dates)
6. **Validation**: Mongoose validators for data integrity

## Core Models

### User

**File**: `src/models/User.model.ts`

**Purpose**: System users with authentication and profile data

**Schema**:
```typescript
{
  // Identity
  name: String (required)
  email: String (required, unique, lowercase)
  password: String (hashed, select: false)
  googleId: String (for OAuth users)
  avatar: String (URL)

  // Authentication
  emailVerified: Boolean (default: false)
  otpCode: String
  otpExpiresAt: Date
  passwordResetToken: String
  passwordResetExpires: Date
  lastPasswordChange: Date

  // Roles & Status
  role: "customer" | "employee" | "admin" | "super_admin" | "driver"
  isActive: Boolean (default: true)
  isApproved: Boolean (default: true, false for pending drivers)
  onboardingCompleted: Boolean (default: false)

  // Organization
  organizationId: ObjectId (ref: Organization)
  organizationRole: "owner" | "admin" | "member" | "viewer"

  // Profile
  personalInfo: {
    bio: String
    phone: String
    phoneCountryCode: String
    location: String
    timezone: String
    language: String
    dateOfBirth: Date
    gender: String
    jobTitle: String
    department: String
    linkedIn: String
    website: String
    socialLinks: Array<{label: String, url: String}>
  }

  // Status
  onlineStatus: "online" | "idle" | "away" | "busy" | "offline" | "do_not_disturb"
  customStatus: String
  lastActive: Date
  theme: "light" | "dark"

  // Wallet (for referrals/rewards)
  referralCode: String
  walletBalance: Number (default: 0)
  totalEarned: Number (default: 0)

  // Notification Preferences
  notificationPreferences: {
    quoteCreated: Boolean
    shipmentCreated: Boolean
    appointmentCreated: Boolean
    driverRequests: Boolean
    // ... more preferences
  }

  // Subscription (future)
  subscription: {
    plan: "free" | "starter" | "professional" | "enterprise"
    status: "active" | "inactive" | "trial" | "cancelled"
    startDate: Date
    endDate: Date
    features: Array<String>
  }

  // Stripe
  stripeConnectAccountId: String

  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
```typescript
{ email: 1 } (unique)
{ organizationId: 1 }
{ role: 1 }
{ googleId: 1 } (sparse)
```

**Methods**:
```typescript
user.isPasswordMatch(password: string): Promise<boolean>
```

**Statics**:
```typescript
User.isEmailTaken(email: string, excludeUserId?: string): Promise<boolean>
```

**Pre-save Hook**:
```typescript
// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(config.bcryptSaltRounds);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});
```

**Global Roles**:
- `super_admin` - Full system access, can impersonate any org
- `admin` - Elevated privileges, typically org owner
- `employee` - Org member with standard access
- `customer` - External customer
- `driver` - Logistics driver (requires approval)

**Organization Roles**:
- `owner` - Organization creator (full control)
- `admin` - Can manage org and members
- `member` - Standard org access
- `viewer` - Read-only access

---

### Organization

**File**: `src/models/Organization.model.ts`

**Purpose**: Multi-tenant entities (dealerships, companies)

**Schema**:
```typescript
{
  name: String (required)
  slug: String (required, unique)
  ownerId: ObjectId (ref: User)
  members: Array<ObjectId> (ref: User)
  logoUrl: String
  metadata: Mixed (flexible data)
  status: "active" | "suspended" | "archived" (default: "active")

  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
```typescript
{ slug: 1 } (unique)
{ ownerId: 1 }
{ status: 1 }
```

**Relationships**:
- One-to-many with Users (members)
- One-to-one with User (owner)
- One-to-many with Vehicles, Leads, Shipments, etc.

---

### Vehicle

**File**: `src/models/Vehicle.model.ts`

**Purpose**: Vehicle inventory for dealerships

**Schema**:
```typescript
{
  // Basic Information
  vin: String (required, unique)
  year: Number (required)
  make: String (required)
  modelName: String (required)
  trim: String
  exteriorColor: String
  interiorColor: String
  stockNumber: String (indexed)
  vehicleType: String
  bodyStyle: String

  // Pricing
  price: Number
  msrp: Number
  cost: Number

  // Details
  mileage: Number
  transmission: String
  engine: String
  fuelType: String
  driveTrain: String
  doors: Number
  cylinders: Number
  options: String (comma-separated features)
  comments: String
  images: Array<String> (URLs)
  vdpUrl: String (vehicle detail page URL)

  // Dealer Info
  dealerId: String
  dealerName: String
  dealerAddress: String
  dealerCity: String
  dealerState: String
  dealerZip: String
  dealerEmail: String

  // Status & Workflow
  certified: Boolean
  isNewVehicle: Boolean
  status: "In Recon" | "Ready for Sale" | "Sold" | "In Transit"
  currentStep: "Inspection" | "Mechanical" | "Body / Paint" | "Detail" | "Photography" | "Ready"
  manualStatusLock: Boolean

  // Dates
  reconStartDate: Date
  stepEnteredAt: Date
  daysOnLot: Number
  dateAdded: Date
  dateSold: Date

  // Assignment
  assignedTo: ObjectId (ref: User)

  // Notes
  notes: Array<{
    text: String
    author: ObjectId (ref: User)
    date: Date
  }>

  // Multi-tenancy
  organizationId: String (required)
  isDeleted: Boolean (default: false)

  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
```typescript
{ vin: 1 } (unique)
{ organizationId: 1, isDeleted: 1 }
{ make: 1, modelName: 1 }
{ year: 1 }
{ status: 1 }
{ stockNumber: 1 } (sparse)
```

**Search Support**:
- Full-text search on make, model, VIN
- Filter by year range, price range, mileage
- Sort by price, year, dateAdded

---

### Session

**File**: `src/models/Session.model.ts`

**Purpose**: Store refresh tokens for JWT authentication

**Schema**:
```typescript
{
  userId: ObjectId (ref: User, required)
  refreshTokenHash: String (required, SHA-256 hash)
  expiresAt: Date (required)
  createdAt: Date
}
```

**Indexes**:
```typescript
{ userId: 1 }
{ refreshTokenHash: 1 } (for fast lookup)
{ expiresAt: 1 } (TTL index, auto-deletes expired sessions)
```

**Security**:
- Refresh token never stored in plain text
- Hashed using SHA-256 before storage
- Automatically deleted when expired (MongoDB TTL)

---

### Lead

**File**: `src/models/lead.model.ts`

**Purpose**: Sales leads and customer inquiries

**Schema**:
```typescript
{
  // Contact Info
  firstName: String
  lastName: String
  email: String
  phone: String

  // Lead Source
  source: "website" | "phone" | "email" | "adf" | "walk-in" | "referral"
  adfData: Mixed (parsed ADF XML)

  // Vehicle Interest
  vehicleId: ObjectId (ref: Vehicle)
  vehicleOfInterest: {
    make: String
    model: String
    year: Number
    vin: String
  }

  // Status
  status: "new" | "contacted" | "qualified" | "appointment" | "sold" | "lost"
  priority: "low" | "medium" | "high"

  // Assignment
  assignedTo: ObjectId (ref: User)
  assignedAt: Date

  // Notes
  notes: String
  comments: Array<{
    text: String
    author: ObjectId (ref: User)
    createdAt: Date
  }>

  // Timestamps
  lastContactedAt: Date
  appointmentDate: Date

  // Multi-tenancy
  organizationId: ObjectId (ref: Organization)

  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
```typescript
{ organizationId: 1, status: 1 }
{ email: 1, organizationId: 1 }
{ assignedTo: 1 }
```

---

### Shipment

**File**: `src/models/Shipment.model.ts`

**Purpose**: Vehicle transport orders

**Schema**:
```typescript
{
  // Reference
  shipmentNumber: String (unique, auto-generated)

  // Origin
  pickupLocation: {
    address: String
    city: String
    state: String
    zip: String
    lat: Number
    lng: Number
  }
  pickupDate: Date
  pickupContactName: String
  pickupContactPhone: String

  // Destination
  deliveryLocation: {
    address: String
    city: String
    state: String
    zip: String
    lat: Number
    lng: Number
  }
  deliveryDate: Date
  deliveryContactName: String
  deliveryContactPhone: String

  // Vehicle
  vehicleId: ObjectId (ref: Vehicle)
  vehicleDetails: {
    make: String
    model: String
    year: Number
    vin: String
  }

  // Pricing
  quoteId: ObjectId (ref: Quote)
  price: Number
  deposit: Number
  balance: Number

  // Driver
  driverId: ObjectId (ref: DriverProfile)
  driverAssignedAt: Date

  // Status
  status: "pending" | "assigned" | "in_transit" | "delivered" | "cancelled"
  trackingUpdates: Array<{
    status: String
    location: {lat: Number, lng: Number}
    timestamp: Date
    note: String
  }>

  // Proof of Delivery
  proofOfDelivery: {
    signature: String (URL)
    photos: Array<String> (URLs)
    completedAt: Date
  }

  // Multi-tenancy
  organizationId: ObjectId (ref: Organization)

  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
```typescript
{ shipmentNumber: 1 } (unique)
{ organizationId: 1, status: 1 }
{ driverId: 1, status: 1 }
```

---

### Quote

**File**: `src/models/Quote.model.ts`

**Purpose**: Transport pricing quotes

**Schema**:
```typescript
{
  quoteNumber: String (unique, auto-generated)

  customerId: ObjectId (ref: User)
  customerEmail: String
  customerPhone: String

  origin: {
    city: String
    state: String
    zip: String
  }

  destination: {
    city: String
    state: String
    zip: String
  }

  vehicle: {
    year: Number
    make: String
    model: String
    vin: String
    type: String
  }

  transportType: "open" | "enclosed"
  price: Number
  deposit: Number
  distance: Number (miles)

  status: "pending" | "sent" | "accepted" | "rejected" | "expired"
  expiresAt: Date

  notes: String

  organizationId: ObjectId (ref: Organization)

  createdAt: Date
  updatedAt: Date
}
```

---

### DriverProfile

**File**: `src/models/DriverProfile.model.ts`

**Purpose**: Driver information and documents

**Schema**:
```typescript
{
  userId: ObjectId (ref: User, required, unique)

  // Personal
  licenseNumber: String
  licenseExpiry: Date
  licenseState: String

  // Vehicle
  truckDetails: {
    make: String
    model: String
    year: Number
    licensePlate: String
    capacity: Number
  }

  // Insurance
  insuranceProvider: String
  insurancePolicyNumber: String
  insuranceExpiry: Date

  // Documents (stored in R2 private bucket)
  documents: {
    licensePhoto: String (key)
    insurance: String (key)
    vehicleRegistration: String (key)
  }

  // Status
  isAvailable: Boolean (default: true)
  verificationStatus: "pending" | "verified" | "rejected"

  // Ratings
  rating: Number (0-5)
  totalDeliveries: Number (default: 0)
  onTimeDeliveryRate: Number (0-100)

  organizationId: ObjectId (ref: Organization)

  createdAt: Date
  updatedAt: Date
}
```

---

### Appointment

**File**: `src/models/Appointment.model.ts`

**Purpose**: Service appointments for customers

**Schema**:
```typescript
{
  customerId: ObjectId (ref: User)
  vehicleId: ObjectId (ref: OwnedVehicle)

  appointmentType: "service" | "repair" | "inspection" | "test_drive"

  scheduledAt: Date (required)
  duration: Number (minutes)

  location: {
    name: String
    address: String
    city: String
    state: String
    zip: String
  }

  status: "scheduled" | "confirmed" | "in_progress" | "completed" | "cancelled"

  assignedTo: ObjectId (ref: User, mechanic/salesperson)

  notes: String
  serviceDetails: String

  // Google Calendar Integration
  googleCalendarEventId: String

  organizationId: ObjectId (ref: Organization)

  createdAt: Date
  updatedAt: Date
}
```

---

### Notification

**File**: `src/models/Notification.model.ts`

**Purpose**: User notifications (in-app alerts)

**Schema**:
```typescript
{
  userId: ObjectId (ref: User, required)
  organizationId: String

  type: "info" | "success" | "warning" | "error" | "quote" | "shipment" | "driver_request" | "appointment"

  title: String (required)
  message: String (required)

  metadata: Mixed (context data, e.g., quoteId, shipmentId)

  isRead: Boolean (default: false)
  readAt: Date

  link: String (optional URL for click action)

  expiresAt: Date (auto-delete after expiry)

  createdAt: Date
  updatedAt: Date
}
```

**Indexes**:
```typescript
{ userId: 1, isRead: 1, createdAt: -1 }
{ expiresAt: 1 } (TTL index)
```

---

## Supporting Models

### CrmUser

**File**: `src/models/CrmUser.model.ts`

**Purpose**: CRM-specific user data (separate from main User model)

---

### Customer

**File**: `src/models/Customer.model.ts`

**Purpose**: Customer-specific data (addresses, payment methods)

---

### OwnedVehicle

**File**: `src/models/OwnedVehicle.model.ts`

**Purpose**: Vehicles owned by customers (for service tracking)

---

### ServiceRecord

**File**: `src/models/ServiceRecord.model.ts`

**Purpose**: Service history for customer vehicles

---

### Feed

**File**: `src/models/Feed.model.ts`

**Purpose**: Social feed posts for team collaboration

**Schema**:
```typescript
{
  authorId: ObjectId (ref: User)
  organizationId: ObjectId (ref: Organization)

  content: String (required)
  attachments: Array<{
    type: "image" | "video" | "file"
    url: String
    filename: String
  }>

  visibility: "public" | "organization" | "private"

  reactionCount: Number (default: 0)
  commentCount: Number (default: 0)

  createdAt: Date
  updatedAt: Date
}
```

---

### FeedReaction

**File**: `src/models/FeedReaction.model.ts`

**Purpose**: Reactions to feed posts

**Schema**:
```typescript
{
  feedId: ObjectId (ref: Feed)
  userId: ObjectId (ref: User)
  emoji: String ("👍", "❤️", "🎉", etc.)

  createdAt: Date
}
```

**Indexes**:
```typescript
{ feedId: 1, userId: 1 } (unique, one reaction per user per post)
```

---

### FeedComment

**File**: `src/models/FeedComment.model.ts`

**Purpose**: Comments on feed posts

**Schema**:
```typescript
{
  feedId: ObjectId (ref: Feed)
  authorId: ObjectId (ref: User)
  content: String (required)

  parentCommentId: ObjectId (ref: FeedComment, for threaded replies)

  createdAt: Date
  updatedAt: Date
}
```

---

### SupraSpaceConversation

**File**: `src/models/SupraSpaceConversation.model.ts`

**Purpose**: Team messaging conversations

**Schema**:
```typescript
{
  name: String
  type: "direct" | "group" | "channel"

  participants: Array<ObjectId> (ref: User)
  organizationId: ObjectId (ref: Organization)

  lastMessageAt: Date
  lastMessagePreview: String

  createdBy: ObjectId (ref: User)

  createdAt: Date
  updatedAt: Date
}
```

---

### SupraSpaceMessage

**File**: `src/models/SupraSpaceMessage.model.ts`

**Purpose**: Individual messages in conversations

**Schema**:
```typescript
{
  conversationId: ObjectId (ref: SupraSpaceConversation)
  senderId: ObjectId (ref: User)

  content: String
  attachments: Array<{url: String, filename: String}>

  readBy: Array<{
    userId: ObjectId
    readAt: Date
  }>

  createdAt: Date
  updatedAt: Date
}
```

---

### ActivityLog

**File**: `src/models/ActivityLog.model.ts`

**Purpose**: Audit trail of user actions

**Schema**:
```typescript
{
  userId: ObjectId (ref: User)
  organizationId: ObjectId (ref: Organization)

  type: "login" | "logout" | "create" | "update" | "delete" | "view"
  resource: String (e.g., "vehicle", "lead", "shipment")
  resourceId: String

  title: String
  description: String

  ipAddress: String
  userAgent: String

  metadata: Mixed

  createdAt: Date
}
```

**Indexes**:
```typescript
{ userId: 1, createdAt: -1 }
{ organizationId: 1, createdAt: -1 }
```

---

## Model Relationships

```
Organization (1)
  ├── Users (N)
  ├── Vehicles (N)
  ├── Leads (N)
  ├── Shipments (N)
  ├── Quotes (N)
  └── Feed Posts (N)

User (1)
  ├── Organization (1)
  ├── Sessions (N)
  ├── Notifications (N)
  ├── Assigned Leads (N)
  ├── Activity Logs (N)
  ├── DriverProfile (1)
  └── Feed Posts (N)

Vehicle (1)
  ├── Organization (1)
  ├── Leads (N)
  └── Shipment (1)

Shipment (1)
  ├── Vehicle (1)
  ├── Driver (1)
  ├── Quote (1)
  └── Organization (1)

Feed Post (1)
  ├── Author (User) (1)
  ├── Reactions (N)
  └── Comments (N)
```

## Common Patterns

### Soft Delete

```typescript
// Schema
isDeleted: { type: Boolean, default: false }

// Query
Vehicle.find({ organizationId, isDeleted: false });

// Delete
await vehicle.updateOne({ isDeleted: true });
```

### Organization Scoping

```typescript
// All queries filtered by org
const vehicles = await Vehicle.find({ organizationId: req.orgId });

// Prevent cross-org access
const vehicle = await Vehicle.findOne({
  _id: vehicleId,
  organizationId: req.orgId
});
```

### Timestamps

```typescript
// Enable automatic timestamps
{
  timestamps: true  // Adds createdAt, updatedAt
}

// Access in code
console.log(vehicle.createdAt);  // Date
console.log(vehicle.updatedAt);  // Date
```

### Virtual Fields

```typescript
// Define virtual
vehicleSchema.virtual('fullName').get(function() {
  return `${this.year} ${this.make} ${this.modelName}`;
});

// Use
console.log(vehicle.fullName);  // "2023 Toyota Camry"
```

### Pre/Post Hooks

```typescript
// Pre-save hook
vehicleSchema.pre('save', async function(next) {
  if (this.isModified('status') && this.status === 'Sold') {
    this.dateSold = new Date();
  }
  next();
});

// Post-save hook
vehicleSchema.post('save', async function(doc) {
  // Emit Socket.IO event
  io.to(`org:${doc.organizationId}`).emit('vehicle_updated', doc);
});
```

## Indexes Strategy

### Compound Indexes

```typescript
// For org-scoped queries
{ organizationId: 1, status: 1 }

// For search
{ organizationId: 1, make: 1, modelName: 1 }
```

### Sparse Indexes

```typescript
// Only index documents with field
{ googleId: 1 } (sparse: true)
```

### TTL Indexes

```typescript
// Auto-delete expired documents
{ expiresAt: 1 } (expireAfterSeconds: 0)
```

### Text Indexes

```typescript
// Full-text search
{ make: 'text', modelName: 'text', vin: 'text' }
```

## Query Performance Tips

1. **Always filter by organizationId first**
2. **Use lean() for read-only queries** (faster, no Mongoose overhead)
3. **Select only needed fields** (.select('name email'))
4. **Limit result sets** (.limit(100))
5. **Use indexes for sorting** (.sort({ createdAt: -1 }))
6. **Avoid N+1 queries** (use .populate())

## Testing Models

```typescript
import User from '../models/User.model';
import { connectDB, closeDB } from '../test-utils/db';

describe('User Model', () => {
  beforeAll(async () => await connectDB());
  afterAll(async () => await closeDB());

  it('should hash password before saving', async () => {
    const user = await User.create({
      name: 'Test',
      email: 'test@example.com',
      password: 'password123'
    });

    expect(user.password).not.toBe('password123');
    expect(await user.isPasswordMatch('password123')).toBe(true);
  });
});
```

## Related Documentation

- [Architecture Overview](../architecture-overview.md)
- [Authentication System](../features/authentication.md)
- [Multi-Tenant Architecture](../features/organization-management.md)
- [Vehicle Inventory](../features/vehicle-inventory.md)
