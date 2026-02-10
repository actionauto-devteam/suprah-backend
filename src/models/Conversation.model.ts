import mongoose, { Schema, Document } from 'mongoose';

export interface IMessage {
  _id: string;
  sender: mongoose.Types.ObjectId | string;
  senderEmail?: string; // For external emails
  senderName?: string; // For external emails
  content: string;
  type: 'text' | 'appointment' | 'file' | 'email';
  metadata?: {
    appointmentId?: string;
    fileUrl?: string;
    fileName?: string;
    emailSubject?: string;
    emailThreadId?: string;
    gmailMessageId?: string;
  };
  isFromExternal: boolean; // True if message is from external email
  readBy: mongoose.Types.ObjectId[];
  createdAt: Date;
  updatedAt?: Date;
}

export interface IConversation extends Document {
  type: 'direct' | 'group' | 'channel' | 'external';
  name?: string;
  participants: mongoose.Types.ObjectId[];
  externalEmails: Array<{
    email: string;
    name?: string;
    addedAt: Date;
    gmailThreadId?: string;
    lastEmailAt?: Date;
  }>;
  messages: IMessage[];
  lastMessage?: string;
  lastMessageAt?: Date;
  lastMessageBy?: mongoose.Types.ObjectId | string;
  hasAppointment?: boolean;
  appointmentId?: mongoose.Types.ObjectId;
  organizationId: string; // ← CHANGED: Now accepts Clerk org ID strings
  createdBy: mongoose.Types.ObjectId;
  isArchived: boolean;
  linkedCustomerBookings: mongoose.Types.ObjectId[]; // Link to customer bookings
  gmailThreadId?: string; // Gmail thread for external conversations
  metadata?: {
    subject?: string;
    tags?: string[];
    priority?: 'low' | 'normal' | 'high';
  };
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema({
  sender: {
    type: Schema.Types.ObjectId,
    ref: 'User',
  },
  senderEmail: String,
  senderName: String,
  content: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['text', 'appointment', 'file', 'email'],
    default: 'text',
  },
  metadata: {
    appointmentId: { type: Schema.Types.ObjectId, ref: 'Appointment' },
    fileUrl: String,
    fileName: String,
    emailSubject: String,
    emailThreadId: String,
    gmailMessageId: String,
  },
  isFromExternal: {
    type: Boolean,
    default: false,
  },
  readBy: [{
    type: Schema.Types.ObjectId,
    ref: 'User',
  }],
}, {
  timestamps: true,
});

const ConversationSchema = new Schema({
  type: {
    type: String,
    enum: ['direct', 'group', 'channel', 'external'],
    required: true,
  },
  name: String,
  participants: [{
    type: Schema.Types.ObjectId,
    ref: 'User',
  }],
  externalEmails: [{
    email: {
      type: String,
      lowercase: true,
      trim: true,
    },
    name: String,
    addedAt: {
      type: Date,
      default: Date.now,
    },
    gmailThreadId: String,
    lastEmailAt: Date,
  }],
  messages: [MessageSchema],
  lastMessage: String,
  lastMessageAt: Date,
  lastMessageBy: Schema.Types.Mixed, // Can be ObjectId or email string
  hasAppointment: {
    type: Boolean,
    default: false,
  },
  appointmentId: {
    type: Schema.Types.ObjectId,
    ref: 'Appointment',
  },
  // ============================================================
  // FIX: Changed from ObjectId to String to accept Clerk org IDs
  // ============================================================
  organizationId: {
    type: String, // ← CHANGED from Schema.Types.ObjectId
    required: true,
    index: true, // Keep index for performance
  },
  createdBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  isArchived: {
    type: Boolean,
    default: false,
  },
  linkedCustomerBookings: [{
    type: Schema.Types.ObjectId,
    ref: 'Appointment',
  }],
  gmailThreadId: String,
  metadata: {
    subject: String,
    tags: [String],
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
  },
}, {
  timestamps: true,
});

// Indexes for performance
ConversationSchema.index({ organizationId: 1, createdAt: -1 });
ConversationSchema.index({ participants: 1 });
ConversationSchema.index({ 'externalEmails.email': 1 });
ConversationSchema.index({ gmailThreadId: 1 });
ConversationSchema.index({ linkedCustomerBookings: 1 });

// Virtual for unread count
ConversationSchema.virtual('unreadCount').get(function(this: IConversation) {
  // This would be calculated based on user context
  return 0;
});

export default mongoose.model<IConversation>('Conversation', ConversationSchema);