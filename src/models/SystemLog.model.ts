import mongoose, { Schema, Document } from 'mongoose';
// v1.4.0

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
  // Structured extras for client-reported diagnostics (e.g. the tray-app's
  // idle-detection / screenshot-capture reports) — kept separate from `err`
  // since these aren't errors, and separate from `req` since they don't come
  // from an HTTP request object.
  event?: string;
  meta?: Record<string, any>;
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
  event: { type: String, index: true },
  meta: Object,
  env: String,
  createdAt: { 
    type: Date, 
    default: Date.now, 
    expires: 30 * 24 * 60 * 60
  }
}, {
  timestamps: false,
  versionKey: false
});

SystemLogSchema.index({ timestamp: -1, level: 1 });

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

export const SystemLog = mongoose.models.SystemLog || mongoose.model<ISystemLog>('SystemLog', SystemLogSchema);
