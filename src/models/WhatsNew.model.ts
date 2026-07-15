import mongoose, { Document, Schema, Model } from 'mongoose';

/* ────────────────────────────────────────────────────────────────────────────
 * What's New — global platform release notes.
 *
 * IMPORTANT: releases are intentionally GLOBAL. There is no organizationId on
 * WhatsNewRelease and no org filter anywhere in the controller — every
 * authenticated user on the platform, from every organization, sees the same
 * feed. Do not add an org scope here without changing the product intent.
 * ──────────────────────────────────────────────────────────────────────────── */

export type WhatsNewItemKind = 'feature' | 'improvement' | 'fix' | 'announcement';
export type WhatsNewMediaType = 'image' | 'video';

export interface IWhatsNewMedia {
  url: string;
  type: WhatsNewMediaType;
}

export interface IWhatsNewItem {
  title: string;
  description: string;
  kind: WhatsNewItemKind;
  media: IWhatsNewMedia[];
}

export interface IWhatsNewAuthor {
  userId: mongoose.Types.ObjectId;
  fullName: string;
  email: string;
  avatar?: string | null;
}

export interface IWhatsNewRelease extends Document {
  title: string;
  description: string;
  publishedAt: Date;
  author: IWhatsNewAuthor;
  items: IWhatsNewItem[];
  createdAt: Date;
  updatedAt: Date;
}

const MediaSchema = new Schema<IWhatsNewMedia>(
  {
    url: { type: String, required: true },
    type: { type: String, enum: ['image', 'video'], default: 'image' },
  },
  { _id: false },
);

const ItemSchema = new Schema<IWhatsNewItem>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    kind: {
      type: String,
      enum: ['feature', 'improvement', 'fix', 'announcement'],
      default: 'feature',
    },
    media: { type: [MediaSchema], default: [] },
  },
  { _id: false },
);

const WhatsNewReleaseSchema = new Schema<IWhatsNewRelease>(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    publishedAt: { type: Date, default: Date.now, index: true },
    author: {
      userId: { type: Schema.Types.ObjectId, required: true },
      fullName: { type: String, required: true },
      email: { type: String, required: true, lowercase: true },
      avatar: { type: String, default: null },
    },
    items: {
      type: [ItemSchema],
      validate: {
        validator: (v: IWhatsNewItem[]) => Array.isArray(v) && v.length > 0,
        message: 'A release must contain at least one update item',
      },
    },
  },
  { timestamps: true },
);

WhatsNewReleaseSchema.index({ publishedAt: -1 });

/* ── Per-user read tracking ─────────────────────────────────────────────────
 * One document per (user, release). The sidebar unread badge is simply
 * "releases with no read record for this user". Works for both real CrmUsers
 * and synthetic main-app admins because both carry a stable _id. */

export interface IWhatsNewRead extends Document {
  userId: mongoose.Types.ObjectId;
  releaseId: mongoose.Types.ObjectId;
  readAt: Date;
}

const WhatsNewReadSchema = new Schema<IWhatsNewRead>(
  {
    userId: { type: Schema.Types.ObjectId, required: true, index: true },
    releaseId: { type: Schema.Types.ObjectId, ref: 'WhatsNewRelease', required: true },
    readAt: { type: Date, default: Date.now },
  },
  { timestamps: false },
);

WhatsNewReadSchema.index({ userId: 1, releaseId: 1 }, { unique: true });

/* ── Posting-permission revocations ─────────────────────────────────────────
 * Default rule: every CRM admin may post. This collection only stores
 * EXCEPTIONS — an admin whose posting privilege was explicitly revoked.
 * Keyed by email (unique, lowercase) rather than CrmUser _id so the
 * revocation also binds the synthetic admin identity crmAuth builds for
 * main-app users, which shares the email but not the CrmUser _id. */

export interface IWhatsNewPermission extends Document {
  email: string;
  revoked: boolean;
  revokedBy?: {
    userId: mongoose.Types.ObjectId;
    fullName: string;
    email: string;
  };
  revokedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const WhatsNewPermissionSchema = new Schema<IWhatsNewPermission>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    revoked: { type: Boolean, default: false },
    revokedBy: {
      userId: { type: Schema.Types.ObjectId },
      fullName: { type: String },
      email: { type: String, lowercase: true },
    },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const WhatsNewRelease: Model<IWhatsNewRelease> = mongoose.model<IWhatsNewRelease>(
  'WhatsNewRelease',
  WhatsNewReleaseSchema,
);

export const WhatsNewRead: Model<IWhatsNewRead> = mongoose.model<IWhatsNewRead>(
  'WhatsNewRead',
  WhatsNewReadSchema,
);

export const WhatsNewPermission: Model<IWhatsNewPermission> = mongoose.model<IWhatsNewPermission>(
  'WhatsNewPermission',
  WhatsNewPermissionSchema,
);