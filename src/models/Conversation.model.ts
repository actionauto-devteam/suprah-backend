import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage {
    sender: mongoose.Types.ObjectId;
    content: string;
    type: 'text' | 'file' | 'image' | 'appointment';
    metadata?: any;
    readBy: mongoose.Types.ObjectId[];
    createdAt: Date;
}

export interface IConversation extends Document {
    type: 'direct' | 'group';
    name?: string; // For group chats
    participants: mongoose.Types.ObjectId[];
    messages: IMessage[];
    
    // Appointment tracking
    hasAppointment: boolean;
    appointmentId?: mongoose.Types.ObjectId;
    
    // Metadata
    lastMessage?: string;
    lastMessageAt?: Date;
    lastMessageBy?: mongoose.Types.ObjectId;
    
    // Group chat specific
    createdBy?: mongoose.Types.ObjectId;
    avatar?: string;
    
    // Archiving
    isArchived: boolean;
    archivedBy: mongoose.Types.ObjectId[];
    
    createdAt: Date;
    updatedAt: Date;
}

const MessageSchema: Schema = new Schema(
    {
        sender: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        content: {
            type: String,
            required: true,
            trim: true
        },
        type: {
            type: String,
            enum: ['text', 'file', 'image', 'appointment'],
            default: 'text'
        },
        metadata: {
            type: Schema.Types.Mixed
        },
        readBy: [{
            type: Schema.Types.ObjectId,
            ref: 'User'
        }],
        createdAt: {
            type: Date,
            default: Date.now
        }
    }
);

const ConversationSchema: Schema<IConversation> = new Schema(
    {
        type: {
            type: String,
            enum: ['direct', 'group'],
            required: true,
            default: 'direct'
        },
        name: {
            type: String,
            trim: true
        },
        participants: [{
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true
        }],
        messages: [MessageSchema],
        
        hasAppointment: {
            type: Boolean,
            default: false,
            index: true
        },
        appointmentId: {
            type: Schema.Types.ObjectId,
            ref: 'Appointment'
        },
        
        lastMessage: {
            type: String,
            trim: true
        },
        lastMessageAt: {
            type: Date,
            index: true
        },
        lastMessageBy: {
            type: Schema.Types.ObjectId,
            ref: 'User'
        },
        
        createdBy: {
            type: Schema.Types.ObjectId,
            ref: 'User'
        },
        avatar: {
            type: String,
            trim: true
        },
        
        isArchived: {
            type: Boolean,
            default: false
        },
        archivedBy: [{
            type: Schema.Types.ObjectId,
            ref: 'User'
        }]
    },
    {
        timestamps: true
    }
);

// Indexes for efficient queries
ConversationSchema.index({ participants: 1, lastMessageAt: -1 });
ConversationSchema.index({ hasAppointment: 1, participants: 1 });
ConversationSchema.index({ type: 1, participants: 1 });

const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);

export default Conversation;