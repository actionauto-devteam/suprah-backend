import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IAftermarketInquiry extends Document {
  productId: mongoose.Types.ObjectId;
  organizationId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId;

  productName: string;
  productPrice?: number;

  customerName: string;
  customerEmail: string;

  question: string;

  conversationId?: mongoose.Types.ObjectId;

  messageId?: mongoose.Types.ObjectId;

  status: 'open' | 'answered' | 'closed';
  createdAt: Date;
  updatedAt: Date;
}

const AftermarketInquirySchema = new Schema<IAftermarketInquiry>(
  {
    productId: {
      type: Schema.Types.ObjectId,
      ref: 'AftermarketProduct',
      required: true,
      index: true,
    },
    organizationId: {
      type: Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    customerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    productName:   { type: String, required: true },
    productPrice:  { type: Number, required: false },
    customerName:  { type: String, required: true },
    customerEmail: { type: String, required: true },
    question: {
      type: String,
      required: true,
      trim: true,
      minlength: 5,
      maxlength: 2000,
    },
    conversationId: { type: Schema.Types.ObjectId, ref: 'SupraSpaceConversation', default: null },
    messageId:      { type: Schema.Types.ObjectId, ref: 'SupraSpaceMessage', default: null },
    status: {
      type: String,
      enum: ['open', 'answered', 'closed'],
      default: 'open',
      index: true,
    },
  },
  { timestamps: true }
);

AftermarketInquirySchema.index({ organizationId: 1, status: 1, createdAt: -1 });

const AftermarketInquiry: Model<IAftermarketInquiry> =
  mongoose.models.AftermarketInquiry ||
  mongoose.model<IAftermarketInquiry>('AftermarketInquiry', AftermarketInquirySchema);

export default AftermarketInquiry;