import mongoose, { Document, Schema, Model } from 'mongoose';

export interface IAftermarketOrderItem {
  productId: mongoose.Types.ObjectId;
  name: string;        // snapshot at purchase time
  price: number;       // snapshot at purchase time
  quantity: number;
}

export interface IAftermarketOrder extends Document {
  organizationId: mongoose.Types.ObjectId;
  customerId: mongoose.Types.ObjectId; // User (customer) who placed it
  items: IAftermarketOrderItem[];
  subtotal: number;
  total: number;
  status: 'pending' | 'paid' | 'fulfilled' | 'cancelled';
  paymentMethod?: string; // filled in once payment is wired
  paymentRef?: string;    // gateway reference
  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IAftermarketOrderItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'AftermarketProduct', required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const AftermarketOrderSchema = new Schema<IAftermarketOrder>(
  {
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
    items: { type: [OrderItemSchema], required: true },
    subtotal: { type: Number, required: true, min: 0 },
    total: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['pending', 'paid', 'fulfilled', 'cancelled'],
      default: 'pending',
      index: true,
    },
    paymentMethod: { type: String },
    paymentRef: { type: String },
  },
  { timestamps: true }
);

const AftermarketOrder: Model<IAftermarketOrder> =
  mongoose.models.AftermarketOrder ||
  mongoose.model<IAftermarketOrder>('AftermarketOrder', AftermarketOrderSchema);

export default AftermarketOrder;