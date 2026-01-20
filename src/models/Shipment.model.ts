import mongoose, { Document, Schema } from 'mongoose';

export interface IShipment extends Document {
    quoteId: mongoose.Types.ObjectId;
    
    // Status
    status: 'Available for Pickup' | 'Cancelled' | 'Delivered' | 'Dispatched' | 'In-Route';
    
    // Route Information
    origin: string;
    destination: string;
    
    // Dates
    requestedPickupDate: Date;
    scheduledPickup?: Date;
    pickedUp?: Date;
    scheduledDelivery?: Date;
    delivered?: Date;
    
    // Tracking
    trackingNumber?: string;
    carrierInfo?: {
        name: string;
        contact: string;
    };
    
    // Notes
    notes?: Array<{
        text: string;
        author: mongoose.Types.ObjectId;
        date: Date;
    }>;
    
    createdAt: Date;
    updatedAt: Date;
}

const ShipmentSchema: Schema<IShipment> = new Schema(
    {
        quoteId: { 
            type: Schema.Types.ObjectId, 
            ref: 'Quote', 
            required: true 
        },
        
        status: {
            type: String,
            enum: ['Available for Pickup', 'Cancelled', 'Delivered', 'Dispatched', 'In-Route'],
            default: 'Available for Pickup'
        },
        
        origin: { type: String, required: true, trim: true },
        destination: { type: String, required: true, trim: true },
        
        requestedPickupDate: { type: Date, required: true, default: Date.now },
        scheduledPickup: { type: Date },
        pickedUp: { type: Date },
        scheduledDelivery: { type: Date },
        delivered: { type: Date },
        
        trackingNumber: { type: String, trim: true },
        carrierInfo: {
            name: { type: String, trim: true },
            contact: { type: String, trim: true }
        },
        
        notes: [{
            text: { type: String, required: true },
            author: { type: Schema.Types.ObjectId, ref: 'User' },
            date: { type: Date, default: Date.now }
        }]
    },
    {
        timestamps: true
    }
);

const Shipment = mongoose.model<IShipment>('Shipment', ShipmentSchema);

export default Shipment;