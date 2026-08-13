import mongoose, { Schema, Document, Types } from "mongoose";

/* ----------------------------- shared types ----------------------------- */

export interface IActorRef {
  userId: Types.ObjectId | string;
  name?: string;
  email?: string;
}

const ActorRefSchema = new Schema<IActorRef>(
  {
    userId: { type: Schema.Types.Mixed, required: true },
    name: { type: String },
    email: { type: String },
  },
  { _id: false }
);

/* ------------------------------ Conversation ---------------------------- */

export interface IConversation extends Document {
  orgId: Types.ObjectId | string;
  customerId?: Types.ObjectId | null;
  leadId?: Types.ObjectId | null;
  customerPhone: string; // E.164, e.g. +18015551234
  customerName?: string;
  lastMessageAt?: Date;
  lastMessagePreview?: string;
  lastDirection?: "inbound" | "outbound";
  messageCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const ConversationSchema = new Schema<IConversation>(
  {
    orgId: { type: Schema.Types.Mixed, required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
    customerPhone: { type: String, required: true },
    customerName: { type: String },
    lastMessageAt: { type: Date, index: true },
    lastMessagePreview: { type: String },
    lastDirection: { type: String, enum: ["inbound", "outbound"] },
    messageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// One thread per org + phone. All employees see the same thread.
ConversationSchema.index({ orgId: 1, customerPhone: 1 }, { unique: true });
ConversationSchema.index({ orgId: 1, lastMessageAt: -1 });

/* -------------------------- CommunicationMessage ------------------------ */

export type MessageStatus =
  | "queued"     // accepted by our API, being handed to Telnyx
  | "sent"       // Telnyx accepted / sent to carrier
  | "delivered"  // carrier delivery receipt
  | "failed"     // send or delivery failed
  | "received";  // inbound message

export interface ICommunicationMessage extends Document {
  orgId: Types.ObjectId | string;
  conversationId: Types.ObjectId;
  customerId?: Types.ObjectId | null;
  leadId?: Types.ObjectId | null;
  direction: "inbound" | "outbound";
  body: string;
  from: string;
  to: string;
  status: MessageStatus;
  providerMessageId?: string;
  sentBy?: IActorRef | null; // null for inbound
  errorDetail?: string;
  sentAt?: Date;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CommunicationMessageSchema = new Schema<ICommunicationMessage>(
  {
    orgId: { type: Schema.Types.Mixed, required: true, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    body: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    status: {
      type: String,
      enum: ["queued", "sent", "delivered", "failed", "received"],
      default: "queued",
      index: true,
    },
    providerMessageId: { type: String, index: true },
    sentBy: { type: ActorRefSchema, default: null },
    errorDetail: { type: String },
    sentAt: { type: Date },
    deliveredAt: { type: Date },
  },
  { timestamps: true }
);

CommunicationMessageSchema.index({ conversationId: 1, createdAt: -1 });

/* --------------------------------- CallLog ------------------------------ */

export type CallStatus =
  | "ringing"     // inbound, waiting for an agent to claim
  | "answering"   // an agent claimed it; bridging in progress
  | "in-progress" // bridged / live
  | "completed"   // ended normally after being answered
  | "missed"      // inbound, nobody answered
  | "failed"      // provider error
  | "canceled";   // caller hung up before answer / outbound aborted

export interface ICallLog extends Document {
  orgId: Types.ObjectId | string;
  customerId?: Types.ObjectId | null;
  leadId?: Types.ObjectId | null;
  conversationId?: Types.ObjectId | null;
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: CallStatus;
  providerCallControlId?: string; // inbound leg (Call Control)
  providerCallSessionId?: string; // groups legs of one call
  agentLegCallControlId?: string; // leg dialed to the agent's browser
  clientCallId?: string;          // frontend-generated id for browser-originated calls
  answeredBy?: IActorRef | null;  // inbound: who claimed it
  placedBy?: IActorRef | null;    // outbound: who dialed
  startedAt?: Date;
  answeredAt?: Date;
  endedAt?: Date;
  durationSec?: number;
  hangupCause?: string;
  customerName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CallLogSchema = new Schema<ICallLog>(
  {
    orgId: { type: Schema.Types.Mixed, required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
    leadId: { type: Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", default: null },
    direction: { type: String, enum: ["inbound", "outbound"], required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    status: {
      type: String,
      enum: ["ringing", "answering", "in-progress", "completed", "missed", "failed", "canceled"],
      default: "ringing",
      index: true,
    },
    providerCallControlId: { type: String, index: true },
    providerCallSessionId: { type: String, index: true },
    agentLegCallControlId: { type: String },
    clientCallId: { type: String, index: true },
    answeredBy: { type: ActorRefSchema, default: null },
    placedBy: { type: ActorRefSchema, default: null },
    startedAt: { type: Date },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSec: { type: Number },
    hangupCause: { type: String },
    customerName: { type: String },
  },
  { timestamps: true }
);

CallLogSchema.index({ orgId: 1, createdAt: -1 });
CallLogSchema.index({ orgId: 1, customerId: 1, createdAt: -1 });

/* -------------------------- TelephonyCredential -------------------------- */
/** One Telnyx on-demand credential per user, so each browser registers with
 *  its own SIP identity while all calls present the shared company number. */

export interface ITelephonyCredential extends Document {
  userId: Types.ObjectId | string;
  credentialId: string; // Telnyx telephony_credential id
  sipUsername: string;  // used as transfer target: sip:<sipUsername>@sip.telnyx.com
  createdAt: Date;
  updatedAt: Date;
}

const TelephonyCredentialSchema = new Schema<ITelephonyCredential>(
  {
    userId: { type: Schema.Types.Mixed, required: true, unique: true, index: true },
    credentialId: { type: String, required: true },
    sipUsername: { type: String, required: true },
  },
  { timestamps: true }
);

/* -------------------------------- exports ------------------------------- */

export const Conversation =
  mongoose.models.Conversation ||
  mongoose.model<IConversation>("Conversation", ConversationSchema);

export const CommunicationMessage =
  mongoose.models.CommunicationMessage ||
  mongoose.model<ICommunicationMessage>("CommunicationMessage", CommunicationMessageSchema);

export const CallLog =
  mongoose.models.CallLog || mongoose.model<ICallLog>("CallLog", CallLogSchema);

export const TelephonyCredential =
  mongoose.models.TelephonyCredential ||
  mongoose.model<ITelephonyCredential>("TelephonyCredential", TelephonyCredentialSchema);
