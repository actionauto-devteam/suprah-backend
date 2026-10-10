import mongoose, { Schema, Document } from 'mongoose';
import { LEAD_STATUS_VALUES } from '../constants/leadStatus';
import { contactIdentity } from '../utils/contactIdentity';
import { CUSTOMER_IDENTITY_INDEXES, IDENTITY_SCHEMA_OPTIONS } from '../constants/customerIdentityIndexes';
import { IActorRef, ActorRefSchema } from './communication.model';
import { AiHumanAttention, aiHumanAttentionFields } from './aiHumanAttention';

export interface ILead extends Document {
  organizationId: mongoose.Types.ObjectId;
  customerId?: mongoose.Types.ObjectId;
  normalizedEmail?: string | null;
  normalizedPhone?: string | null;
  identityEmailExcluded?: boolean;
  customerLink?: {
    status: 'pending' | 'linked' | 'unresolved' | 'ambiguous' | 'conflict' | 'retry';
    reason?: string;
    candidateIds?: mongoose.Types.ObjectId[];
    checkedAt?: Date;
    nextRetryAt?: Date | null;
  };
  createdBy: mongoose.Types.ObjectId;

  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  senderEmail?: string;
  senderName?: string;
  sourceProvider?: string;

  subject?: string;
  body?: string;

  /** Clean, human-readable content (ADF parsed or cleaned email body) */
  parsedContent?: string;

  threadId?: string;
  messageId?: string;
  ingestionFingerprint?: string;
  isRead?: boolean;
  isPending?: boolean;
  aiFirstReplyTriggeredAt?: Date;
  aiPausedAt?: Date | null;
  aiPausedBy?: IActorRef | null;
  aiGeneratingAt?: Date | null;
  aiAutoPausedUntil?: Date | null;
  aiResponseVersion?: number;
  aiLastDispatchVersion?: number;
  aiAttentionPendingIds?: string[];
  aiHumanAttention?: AiHumanAttention;
  labels?: string[];

  channel: 'email' | 'sms' | 'adf' | 'phone' | 'web' | 'webchat';

  assignedTo?: mongoose.Types.ObjectId;
  assignedAt?: Date;
  assignmentHistory?: Array<{
    from?: mongoose.Types.ObjectId;
    to?: mongoose.Types.ObjectId;
    changedAt: Date;
    changedBy?: mongoose.Types.ObjectId;
  }>;

  source: string;

  /** Constrained at the DB layer to LEAD_STATUS_VALUES (constants/leadStatus.ts). */
  status: string;

  vehicle: {
    year: string;
    make: string;
    model: string;
    vin?: string;
    stock?: string;
    trim?: string;
    condition?: string;
    odometer?: string;
    price?: string;
  };

  vehicleId?: mongoose.Types.ObjectId;
  location?: string;

  appointment?: {
    date: Date;
    time: string;
    notes?: string;
    location?: string;
  };

  comments: string;
  address?: string;
  tags?: string[];
  opportunityValue?: number | null;
  aiSummary?: string;
  aiSummaryGeneratedAt?: Date;
  sourceSubmittedAt?: Date;

  followUp?: {
    lastCustomerActivityAt?: Date;
    lastRepResponseAt?: Date;
    lastReminderSentAt?: Date;
    reminderCount?: number;
    nurtureCount?: number;
    lastNurtureAt?: Date;
    nurtureStatus?: 'processing' | 'sent' | 'failed' | 'skipped' | 'pending_reconciliation';
    nurtureAttemptCount?: number;
    nurtureLastAttemptAt?: Date;
    nurtureNextRetryAt?: Date;
    nurtureFailureReason?: string;
    nurturePendingProviderMessageId?: string;
    lastAutomatedOutreachAt?: Date;
    aiFollowUpCount?: number;
    aiFollowUpStatus?: 'processing' | 'sent' | 'failed' | 'skipped' | 'pending_reconciliation';
    aiFollowUpAttemptCount?: number;
    aiFollowUpLastAttemptAt?: Date;
    aiFollowUpNextRetryAt?: Date;
    aiFollowUpFailureReason?: string;
    aiFollowUpPendingProviderMessageId?: string;
    lastReengagementAt?: Date;
    reengagementCount?: number;

    reminderHistory?: Array<{
      sentAt: Date;
      userId?: mongoose.Types.ObjectId;
      thresholdMinutes: number;
      notificationId?: mongoose.Types.ObjectId;
      note?: string;
    }>;
  };

  centralIngestion?: boolean;

  statusHistory?: Array<{
    from: string;
    to: string;
    changedAt: Date;
    changedBy?: mongoose.Types.ObjectId;
    reason?: string;
  }>;

  /** Internal notes added by CRM users */
  notes?: Array<{
    text: string;
    createdAt: Date;
    createdBy?: mongoose.Types.ObjectId;
    authorType?: 'user' | 'ai';
    authorName?: string;
    mentionedUserIds?: mongoose.Types.ObjectId[];
    mentionedGroupIds?: mongoose.Types.ObjectId[];
    milestone?: boolean;
    sourceTaskId?: mongoose.Types.ObjectId;
  }>;

  createdAt: Date;
  updatedAt: Date;
}

const LeadSchema: Schema<ILead> = new Schema<ILead>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    normalizedEmail: { type: String },
    normalizedPhone: { type: String },
    identityEmailExcluded: { type: Boolean, default: false },
    customerLink: {
      status: { type: String, enum: ['pending', 'linked', 'unresolved', 'ambiguous', 'conflict', 'retry'] },
      reason: String,
      candidateIds: [{ type: Schema.Types.ObjectId, ref: 'Customer' }],
      checkedAt: Date,
      nextRetryAt: Date,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    firstName: {
      type: String,
      default: 'Unknown',
    },

    lastName: {
      type: String,
      default: '',
    },

    email: {
      type: String,
    },

    phone: {
      type: String,
    },

    senderEmail: {
      type: String,
    },

    senderName: {
      type: String,
    },

    sourceProvider: {
      type: String,
      trim: true,
    },

    subject: {
      type: String,
    },

    body: {
      type: String,
    },

    parsedContent: {
      type: String,
    },

    threadId: {
      type: String,
    },

    messageId: {
      type: String,
      sparse: true,
    },

    ingestionFingerprint: {
      type: String,
      immutable: true,
      select: false,
    },

    isRead: {
      type: Boolean,
      default: false,
    },

    isPending: {
      type: Boolean,
      default: false,
    },

    aiFirstReplyTriggeredAt: {
      type: Date,
      default: null,
    },

    aiPausedAt: { type: Date, default: null },
    aiPausedBy: { type: ActorRefSchema, default: null },
    aiGeneratingAt: { type: Date, default: null },
    ...aiHumanAttentionFields,
    aiAutoPausedUntil: { type: Date },

    labels: [
      {
        type: String,
      },
    ],

    channel: {
      type: String,
      enum: ['email', 'sms', 'adf', 'phone', 'web', 'webchat'],
      default: 'email',
      index: true,
    },

    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    assignmentHistory: [
      {
        from: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },

        to: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },

        changedAt: {
          type: Date,
          default: Date.now,
        },

        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      },
    ],

    source: {
      type: String,
      default: 'Email',
    },

    status: {
      type: String,
      enum: LEAD_STATUS_VALUES,
      default: 'New',
    },

    vehicle: {
      year: String,
      make: String,
      model: String,
      vin: String,
      stock: String,
      trim: String,
      condition: String,
      odometer: String,
      price: String,
    },

    vehicleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Vehicle',
      default: null,
    },

    location: {
      type: String,
      trim: true,
    },

    appointment: {
      date: Date,
      time: String,
      notes: String,
      location: String,
    },

    comments: {
      type: String,
    },

    address: {
      type: String,
      default: '',
    },

    tags: [
      {
        type: String,
        trim: true,
      },
    ],

    opportunityValue: {
      type: Number,
      min: 0,
      default: null,
    },

    aiSummary: { type: String, trim: true },
    aiSummaryGeneratedAt: { type: Date },
    sourceSubmittedAt: { type: Date },

    followUp: {
      lastCustomerActivityAt: {
        type: Date,
        default: Date.now,
        index: true,
      },

      lastRepResponseAt: {
        type: Date,
        default: null,
      },

      lastReminderSentAt: {
        type: Date,
        default: null,
        index: true,
      },

      reminderCount: {
        type: Number,
        default: 0,
      },

      nurtureCount: {
        type: Number,
        default: 0,
      },

      lastNurtureAt: {
        type: Date,
        default: null,
      },

      nurtureStatus: {
        type: String,
        enum: ['processing', 'sent', 'failed', 'skipped', 'pending_reconciliation'],
      },

      nurturePendingProviderMessageId: {
        type: String,
      },

      nurtureAttemptCount: {
        type: Number,
        default: 0,
      },

      nurtureLastAttemptAt: {
        type: Date,
        default: null,
      },

      nurtureNextRetryAt: {
        type: Date,
        default: null,
      },

      nurtureFailureReason: {
        type: String,
        maxlength: 500,
      },

      lastAutomatedOutreachAt: {
        type: Date,
        default: null,
      },

      aiFollowUpCount: {
        type: Number,
        default: 0,
      },

      aiFollowUpStatus: {
        type: String,
        enum: ['processing', 'sent', 'failed', 'skipped', 'pending_reconciliation'],
      },

      aiFollowUpAttemptCount: {
        type: Number,
        default: 0,
      },

      aiFollowUpLastAttemptAt: {
        type: Date,
        default: null,
      },

      aiFollowUpNextRetryAt: {
        type: Date,
        default: null,
      },

      aiFollowUpFailureReason: {
        type: String,
        maxlength: 500,
      },

      aiFollowUpPendingProviderMessageId: {
        type: String,
      },

      lastReengagementAt: {
        type: Date,
        default: null,
      },

      reengagementCount: {
        type: Number,
        default: 0,
      },

      reminderHistory: [
        {
          sentAt: {
            type: Date,
            default: Date.now,
          },

          userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
          },

          thresholdMinutes: {
            type: Number,
          },

          notificationId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Notification',
          },

          note: {
            type: String,
          },
        },
      ],
    },

    centralIngestion: {
      type: Boolean,
      default: false,
    },

    statusHistory: [
      {
        from: {
          type: String,
        },

        to: {
          type: String,
        },

        changedAt: {
          type: Date,
          default: Date.now,
        },

        changedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },

        reason: {
          type: String,
        },
      },
    ],

    notes: [
      {
        text: {
          type: String,
          required: true,
          trim: true,
          maxlength: 5000,
        },

        createdAt: {
          type: Date,
          default: Date.now,
        },

        createdBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },

        authorType: {
          type: String,
          enum: ['user', 'ai'],
        },

        authorName: {
          type: String,
        },

        mentionedUserIds: [
          {
            type: mongoose.Schema.Types.ObjectId,
          },
        ],

        mentionedGroupIds: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'CrmLeadGroup',
          },
        ],

        milestone: {
          type: Boolean,
        },

        sourceTaskId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'AiAgentTask',
        },
      },
    ],
  },
  {
    timestamps: true,
    ...IDENTITY_SCHEMA_OPTIONS,
  },
);

// Index for efficient per-organization queries used for pagination
LeadSchema.index({
  organizationId: 1,
  createdAt: -1,
});

LeadSchema.index(
  { organizationId: 1, ingestionFingerprint: 1 },
  {
    unique: true,
    partialFilterExpression: { ingestionFingerprint: { $type: 'string' } },
    name: 'lead_org_ingestion_fingerprint_unique',
  },
);

LeadSchema.index(
  { organizationId: 1, messageId: 1 },
  {
    unique: true,
    partialFilterExpression: { messageId: { $type: 'string' } },
    name: 'lead_org_messageid_unique',
  },
);

// Index for efficient per-user queries
LeadSchema.index({
  createdBy: 1,
  createdAt: -1,
});

// Index for channel-based filtering
LeadSchema.index({
  createdBy: 1,
  channel: 1,
  createdAt: -1,
});

// Index for unanswered inquiry reminder scans
LeadSchema.index({
  organizationId: 1,
  status: 1,
  'followUp.lastCustomerActivityAt': 1,
});

LeadSchema.index({
  organizationId: 1,
  assignedTo: 1,
  createdAt: -1,
});

LeadSchema.index({
  organizationId: 1,
  location: 1,
});

for (const { collection, key, name } of CUSTOMER_IDENTITY_INDEXES) {
  if (collection === 'leads') LeadSchema.index(key, { name });
}

LeadSchema.pre('validate', function () {
  this.$locals.syncCustomerIdentity = this.isNew || this.isModified('email') || this.isModified('phone') || this.isModified('identityEmailExcluded');
  if (this.$locals.syncCustomerIdentity) {
    const identity = contactIdentity({ email: this.identityEmailExcluded ? undefined : this.email, phone: this.phone });
    this.normalizedEmail = identity.normalizedEmail;
    this.normalizedPhone = identity.normalizedPhone;
    this.customerLink = { status: 'pending', nextRetryAt: new Date() };
  }
});

async function synchronizeLeadDocument(document: any) {
  if (!document?._id || !document.organizationId) return;
  const { syncLeadCustomerSafely } = await import('../services/customerIdentity.service');
  await syncLeadCustomerSafely(String(document.organizationId), String(document._id));
  const current: any = await mongoose.model('Lead').findOne({ _id: document._id, organizationId: document.organizationId })
    .select('customerId customerLink normalizedEmail normalizedPhone').lean().catch(() => null);
  if (current) Object.assign(document, { customerId: current.customerId, customerLink: current.customerLink, normalizedEmail: current.normalizedEmail, normalizedPhone: current.normalizedPhone });
}

LeadSchema.post('save', async function (document) {
  if (document.$locals.syncCustomerIdentity) await synchronizeLeadDocument(document);
});

LeadSchema.pre('findOneAndUpdate', function () {
  const update = this.getUpdate() as any;
  const contactFields = ['email', 'phone', 'identityEmailExcluded'];
  const shouldSync = Boolean(this.getOptions().upsert) || contactFields.some(field =>
    Object.prototype.hasOwnProperty.call(update?.$set || update || {}, field)
    || Object.prototype.hasOwnProperty.call(update?.$unset || {}, field));
  (this as any).syncCustomerIdentity = shouldSync;
  if (shouldSync && update && !Array.isArray(update)) {
    update.$set = { ...(update.$set || {}), 'customerLink.status': 'pending', 'customerLink.nextRetryAt': new Date() };
    this.setUpdate(update);
  }
});

LeadSchema.post('findOneAndUpdate', async function (result) {
  if (!(this as any).syncCustomerIdentity) return;
  const document = result?.value || result;
  if (document?._id) await synchronizeLeadDocument(document);
  else {
    const current = await this.model.findOne(this.getFilter()).select('_id organizationId').lean();
    if (current) await synchronizeLeadDocument(current);
  }
});

export default mongoose.model<ILead>(
  'Lead',
  LeadSchema,
);
