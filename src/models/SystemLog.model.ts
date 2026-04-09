import mongoose, { Schema, Document } from 'mongoose';

/**
 * SystemLog Interface
 * Structured represention of a Pino log entry for database indexing.
 */
export interface ISystemLog extends Document {
  timestamp: Date;
  level: string;
  message: string;
  req?: {
    id: string;
    method: string;
    url: string;
    remoteAddress: string;
    userId?: string;
    organizationId?: string;
  };
  res?: {
    statusCode: number;
  };
  err?: Record<string, any>;
  context?: string;
  env: string;
  createdAt: Date;
}

const SystemLogSchema = new Schema<ISystemLog>({
  timestamp: { type: Date, required: true, index: true },
  level: { type: String, required: true, index: true },
  message: { type: String, required: true },
  req: {
    id: { type: String, index: true },
    method: String,
    url: { type: String, index: true },
    remoteAddress: String,
    userId: { type: String, index: true },
    organizationId: { type: String, index: true },
  },
  res: {
    statusCode: { type: Number, index: true },
  },
  err: Object,
  context: String,
  env: String,
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 30 * 24 * 60 * 60 // 30-day TTL
  }
}, {
  timestamps: false, // We use the Pino timestamp
  versionKey: false
});

// Compound index for time-based filtering with level
SystemLogSchema.index({ timestamp: -1, level: 1 });

// Global Unified Search Index (Multi-field text search)
SystemLogSchema.index({ 
  message: 'text', 
  'req.url': 'text', 
  'req.id': 'text', 
  'req.userId': 'text',
  context: 'text' 
}, {
  name: 'GlobalSearchIndex',
  weights: {
    message: 10,
    'req.id': 5,
    'req.url': 3,
    'req.userId': 2,
    context: 1
  }
});

// Ensure indexes are created
export const SystemLog = mongoose.models.SystemLog || mongoose.model<ISystemLog>('SystemLog', SystemLogSchema);
