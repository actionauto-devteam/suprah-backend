import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IShopPreferences {
  vehicleTypes: string[];
  budgetMin?: number | null;
  budgetMax?: number | null;
  brands: string[];
  fuelTypes: string[];
  passengers?: number | null;
  usage: string[];
}

export interface IShopMessage {
  role: 'user' | 'assistant';
  content: string;
  recommendations?: any[]; // snapshot of Recommendation[] shown at the time
  createdAt: Date;
}

export interface IShopAssistantChat extends Document {
  sessionId: string;
  userId?: string | null; // optional customer id if authenticated (kept loose — not a hard ref)
  preferences: IShopPreferences;
  messages: Types.DocumentArray<IShopMessage>;
  messageCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const PreferencesSchema = new Schema<IShopPreferences>(
  {
    vehicleTypes: { type: [String], default: [] },
    budgetMin: { type: Number, default: null },
    budgetMax: { type: Number, default: null },
    brands: { type: [String], default: [] },
    fuelTypes: { type: [String], default: [] },
    passengers: { type: Number, default: null },
    usage: { type: [String], default: [] },
  },
  { _id: false }
);

const ShopMessageSchema = new Schema<IShopMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, required: true, maxlength: 8000 },
    recommendations: { type: Schema.Types.Mixed, default: undefined },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const ShopAssistantChatSchema = new Schema<IShopAssistantChat>(
  {
    sessionId: { type: String, required: true, index: true, unique: true },
    userId: { type: String, default: null, index: true },
    preferences: { type: PreferencesSchema, default: () => ({}) },
    messages: { type: [ShopMessageSchema], default: [] },
    messageCount: { type: Number, default: 0 },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

ShopAssistantChatSchema.index({ lastActivityAt: -1 });

ShopAssistantChatSchema.pre('save', function (next) {
  this.messageCount = this.messages.length;
  this.lastActivityAt = new Date();
  next();
});

const ShopAssistantChat = mongoose.model<IShopAssistantChat>(
  'ShopAssistantChat',
  ShopAssistantChatSchema
);

export default ShopAssistantChat;