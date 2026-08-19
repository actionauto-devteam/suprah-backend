import mongoose, { Document, Model, Schema } from "mongoose";

/**
 * Contact — org-shared phonebook for Suprah One Desk's SMS/Call panes.
 * Every CRM staff member in the same organization sees and saves to the
 * same list; different organizations never see each other's contacts.
 */
export interface IContact extends Document {
  organizationId: mongoose.Types.ObjectId | string;
  name: string;
  phoneNumber: string;
  createdBy?: {
    userId: mongoose.Types.ObjectId | string;
    name?: string;
  } | null;
  createdAt: Date;
  updatedAt: Date;
}

const ContactSchema = new Schema<IContact>(
  {
    organizationId: { type: Schema.Types.Mixed, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    phoneNumber: { type: String, required: true, trim: true },
    createdBy: {
      userId: { type: Schema.Types.Mixed },
      name: { type: String },
      _id: false,
    },
  },
  { timestamps: true },
);

// One saved number per org — prevents duplicate entries for the same contact.
ContactSchema.index({ organizationId: 1, phoneNumber: 1 }, { unique: true });
ContactSchema.index({ organizationId: 1, name: 1 });

const Contact: Model<IContact> =
  (mongoose.models.Contact as Model<IContact>) ||
  mongoose.model<IContact>("Contact", ContactSchema);

export default Contact;
