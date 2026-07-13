import mongoose, { Schema, Document } from "mongoose";


export interface IShopPreferences {
  vehicleTypes: string[];
  brands: string[];
  fuelTypes: string[];
  usage: string[];
  features: string[];
  budgetMin?: number | null;
  budgetMax?: number | null;
  passengers?: number | null;
  yearMin?: number | null;
  maxMileage?: number | null;
}

export interface IShopAiMessage {
  role: "user" | "assistant";
  content: string;
  recommendations?: any[];
  createdAt: Date;
}

export interface ICustomerShopAiSession extends Document {
  sessionKey: string;
  customerUserId?: mongoose.Types.ObjectId | null;
  preferences: IShopPreferences;
  messages: IShopAiMessage[];
  messageCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const defaultPreferences = (): IShopPreferences => ({
  vehicleTypes: [],
  brands: [],
  fuelTypes: [],
  usage: [],
  features: [],
  budgetMin: null,
  budgetMax: null,
  passengers: null,
  yearMin: null,
  maxMileage: null,
});

const PreferencesSchema = new Schema<IShopPreferences>(
  {
    vehicleTypes: { type: [String], default: [] },
    brands: { type: [String], default: [] },
    fuelTypes: { type: [String], default: [] },
    usage: { type: [String], default: [] },
    features: { type: [String], default: [] },
    budgetMin: { type: Number, default: null },
    budgetMax: { type: Number, default: null },
    passengers: { type: Number, default: null },
    yearMin: { type: Number, default: null },
    maxMileage: { type: Number, default: null },
  },
  { _id: false }
);

const MessageSchema = new Schema<IShopAiMessage>(
  {
    role: { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, default: "" },
    recommendations: { type: Schema.Types.Mixed, default: undefined },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const CustomerShopAiSessionSchema = new Schema<ICustomerShopAiSession>(
  {
    sessionKey: { type: String, required: true, unique: true, index: true },
    customerUserId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    preferences: { type: PreferencesSchema, default: defaultPreferences },
    messages: { type: [MessageSchema], default: [] },
    messageCount: { type: Number, default: 0 },
    lastActivityAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export const CUSTOMER_SHOP_AI_DEFAULT_PREFERENCES = defaultPreferences;

export default mongoose.models.CustomerShopAiSession ||
  mongoose.model<ICustomerShopAiSession>(
    "CustomerShopAiSession",
    CustomerShopAiSessionSchema
  );