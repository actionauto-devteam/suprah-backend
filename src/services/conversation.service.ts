import Conversation from '../models/Conversation.model';
import User from '../models/User.model';
import notificationService from './notification.service';
import { ApiError } from '../utils/ApiError';

interface CreateConversationData {
    type: 'direct' | 'group';
    participants: string[];
    name?: string;
    avatar?: string;
}

interface SendMessageData {
    content: string;
    type?: 'text' | 'file' | 'image' | 'appointment';
    metadata?: any;
}

/**
 * Create or get existing conversation
 */
const createConversation = async (userId: string, data: CreateConversationData) => {
    // Ensure creator is in participants
    const participants = [...new Set([userId, ...data.participants])];
    
    if (data.type === 'direct' && participants.length !== 2) {
        throw new ApiError(400, 'Direct conversations must have exactly 2 participants');
    }
    
    if (data.type === 'group' && participants.length < 2) {
        throw new ApiError(400, 'Group conversations must have at least 2 participants');
    }
    
    // For direct messages, check if conversation already exists
    if (data.type === 'direct') {
        const existing = await Conversation.findOne({
            type: 'direct',
            participants: { $all: participants, $size: 2 }
        });
        
        if (existing) {
            return existing.populate('participants', 'name email avatar');
        }
    }
    
    // Create new conversation
    const conversation = await Conversation.create({
        type: data.type,
        participants,
        name: data.name,
        avatar: data.avatar,
        createdBy: userId,
        messages: []
    });
    
    return conversation.populate('participants', 'name email avatar');
};

/**
 * Get user's conversations
 */
const getUserConversations = async (userId: string, options: {
    hasAppointment?: boolean;
    includeArchived?: boolean;
} = {}) => {
    const filter: any = {
        participants: userId
    };
    
    if (options.hasAppointment !== undefined) {
        filter.hasAppointment = options.hasAppointment;
    }
    
    if (!options.includeArchived) {
        filter.archivedBy = { $ne: userId };
    }
    
    const conversations = await Conversation.find(filter)
        .populate('participants', 'name email avatar')
        .populate('lastMessageBy', 'name')
        .populate('appointmentId', 'title startTime endTime status')
        .sort({ lastMessageAt: -1 });
    
    return conversations;
};

/**
 * Send message
 */
const sendMessage = async (
    conversationId: string,
    userId: string,
    data: SendMessageData
) => {
    const conversation = await Conversation.findById(conversationId);
    
    if (!conversation) {
        throw new ApiError(404, 'Conversation not found');
    }
    
    // Check if user is participant
    if (!conversation.participants.some(p => p.toString() === userId)) {
        throw new ApiError(403, 'You are not a participant in this conversation');
    }
    
    // Add message
    const message = {
        sender: userId,
        content: data.content,
        type: data.type || 'text',
        metadata: data.metadata,
        readBy: [userId],
        createdAt: new Date()
    };
    
    conversation.messages.push(message as any);
    conversation.lastMessage = data.content.substring(0, 100);
    conversation.lastMessageAt = new Date();
    conversation.lastMessageBy = userId as any;
    
    await conversation.save();
    
    // Notify other participants
    const otherParticipants = conversation.participants
        .map(p => p.toString())
        .filter(p => p !== userId);
    
    const sender = await User.findById(userId).select('name');
    const senderName = sender?.name || 'Someone';
    
    await Promise.all(
        otherParticipants.map(participantId =>
            notificationService.createNotification({
                userId: participantId,
                type: 'message_received',
                title: conversation.type === 'group' 
                    ? `New message in ${conversation.name}` 
                    : `New message from ${senderName}`,
                message: data.content.substring(0, 100),
                metadata: {
                    conversationId: conversation._id,
                    messageId: message,
                    sender: userId
                }
            })
        )
    );
    
    return conversation.populate('participants', 'name email avatar');
};

/**
 * Mark messages as read
 */
const markAsRead = async (conversationId: string, userId: string) => {
    const conversation = await Conversation.findById(conversationId);
    
    if (!conversation) {
        throw new ApiError(404, 'Conversation not found');
    }
    
    // Update all messages
    conversation.messages.forEach(msg => {
        if (!msg.readBy.includes(userId as any)) {
            msg.readBy.push(userId as any);
        }
    });
    
    await conversation.save();
    return conversation;
};

/**
 * Remove duplicate conversations (automated cleanup)
 */
const removeDuplicateConversations = async () => {
    // Find duplicate direct conversations
    const conversations = await Conversation.find({ type: 'direct' });
    const participantMap = new Map<string, string[]>();
    
    for (const conv of conversations) {
        const key = conv.participants
            .map(p => p.toString())
            .sort()
            .join('-');
        
        if (!participantMap.has(key)) {
            participantMap.set(key, []);
        }
        participantMap.get(key)!.push(conv._id.toString());
    }
    
    let removedCount = 0;
    
    for (const [_, convIds] of participantMap) {
        if (convIds.length > 1) {
            // Keep the one with most recent activity, delete others
            const toKeep = await Conversation.findOne({
                _id: { $in: convIds }
            }).sort({ lastMessageAt: -1 });
            
            const toRemove = convIds.filter(id => id !== toKeep?._id.toString());
            await Conversation.deleteMany({ _id: { $in: toRemove } });
            removedCount += toRemove.length;
        }
    }
    
    return removedCount;
};

export default {
    createConversation,
    getUserConversations,
    sendMessage,
    markAsRead,
    removeDuplicateConversations
};