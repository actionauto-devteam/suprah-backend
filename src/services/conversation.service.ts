// services/conversation.service.ts

import Conversation, { IConversation } from '../models/Conversation.model';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';

class ConversationService {
    /**
     * Create a new conversation
     */
    async createConversation(userId: string, orgId: string, data: {
        type: 'direct' | 'group';
        participants: string[];
        name?: string;
    }): Promise<IConversation> {
        const { type, participants, name } = data;

        // Add the creator to participants if not already included
        const allParticipants = [...new Set([userId, ...participants])];

        // For direct messages, ensure only 2 participants
        if (type === 'direct' && allParticipants.length !== 2) {
            throw new ApiError(400, 'Direct conversations must have exactly 2 participants');
        }

        // Check if direct conversation already exists
        if (type === 'direct') {
            const existing = await Conversation.findOne({
                type: 'direct',
                organizationId: orgId,
                participants: { $all: allParticipants, $size: 2 }
            });

            if (existing) {
                // Return existing conversation instead of creating duplicate
                return existing.populate('participants', 'name email avatar');
            }
        }

        const conversation = await Conversation.create({
            type,
            organizationId: orgId,
            participants: allParticipants,
            name: type === 'group' ? name : undefined,
            createdBy: userId,
            messages: []
        });

        return conversation.populate('participants', 'name email avatar');
    }

    /**
     * Get user's conversations
     */
    async getUserConversations(userId: string, orgId: string, options: {
        hasAppointment?: boolean;
        includeArchived?: boolean;
    } = {}): Promise<IConversation[]> {
        const { hasAppointment, includeArchived = false } = options;

        const query: any = {
            participants: userId,
            organizationId: orgId
        };

        if (hasAppointment !== undefined) {
            query.hasAppointment = hasAppointment;
        }

        if (!includeArchived) {
            query.$or = [
                { isArchived: false },
                { archivedBy: { $ne: userId } }
            ];
        }

        const conversations = await Conversation.find(query)
            .populate('participants', 'name email avatar')
            .populate('appointmentId')
            .populate('lastMessageBy', 'name')
            .sort({ lastMessageAt: -1 });

        return conversations as any;
    }

    /**
     * Send a message in a conversation
     */
    async sendMessage(conversationId: string, orgId: string, userId: string, data: {
        content: string;
        type?: 'text' | 'file' | 'image' | 'appointment';
        metadata?: any;
    }): Promise<IConversation> {
        const conversation = await Conversation.findOne({ _id: conversationId, organizationId: orgId });

        if (!conversation) {
            throw new ApiError(404, 'Conversation not found');
        }

        // Check if user is a participant
        if (!conversation.participants.includes(new mongoose.Types.ObjectId(userId))) {
            throw new ApiError(403, 'You are not a participant in this conversation');
        }

        const message = {
            sender: new mongoose.Types.ObjectId(userId),
            content: data.content,
            type: data.type || 'text',
            metadata: data.metadata,
            readBy: [new mongoose.Types.ObjectId(userId)],
            createdAt: new Date()
        };

        conversation.messages.push(message as any);
        conversation.lastMessage = data.content;
        conversation.lastMessageAt = new Date();
        conversation.lastMessageBy = new mongoose.Types.ObjectId(userId);

        await conversation.save();

        return conversation.populate([
            { path: 'participants', select: 'name email avatar' },
            { path: 'messages.sender', select: 'name email avatar' }
        ]);
    }

    /**
     * Mark messages as read
     */
    async markAsRead(conversationId: string, orgId: string, userId: string): Promise<void> {
        const conversation = await Conversation.findOne({ _id: conversationId, organizationId: orgId });

        if (!conversation) {
            throw new ApiError(404, 'Conversation not found');
        }

        // Mark all messages as read by this user
        conversation.messages.forEach(message => {
            if (!message.readBy.includes(new mongoose.Types.ObjectId(userId))) {
                message.readBy.push(new mongoose.Types.ObjectId(userId));
            }
        });

        await conversation.save();
    }

    /**
     * Delete a conversation
     */
    async deleteConversation(conversationId: string, orgId: string, userId: string): Promise<void> {
        const conversation = await Conversation.findOne({ _id: conversationId, organizationId: orgId });

        if (!conversation) {
            throw new ApiError(404, 'Conversation not found');
        }

        // Check if user is a participant
        if (!conversation.participants.includes(new mongoose.Types.ObjectId(userId))) {
            throw new ApiError(403, 'You are not a participant in this conversation');
        }

        // Delete the conversation
        await Conversation.findOneAndDelete({ _id: conversationId, organizationId: orgId });
    }

    /**
     * Archive a conversation (alternative to delete - keeps data)
     */
    async archiveConversation(conversationId: string, orgId: string, userId: string): Promise<IConversation> {
        const conversation = await Conversation.findOne({ _id: conversationId, organizationId: orgId });

        if (!conversation) {
            throw new ApiError(404, 'Conversation not found');
        }

        // Add user to archivedBy array
        if (!conversation.archivedBy.includes(new mongoose.Types.ObjectId(userId))) {
            conversation.archivedBy.push(new mongoose.Types.ObjectId(userId));
        }

        // If all participants archived it, mark as archived
        if (conversation.archivedBy.length === conversation.participants.length) {
            conversation.isArchived = true;
        }

        await conversation.save();
        return conversation;
    }

    /**
     * Remove duplicate direct conversations (cleanup utility)
     */
    async removeDuplicateConversations(): Promise<number> {
        const directConversations = await Conversation.find({ type: 'direct' });

        const seen = new Map<string, string>();
        const toDelete: string[] = [];

        for (const conversation of directConversations) {
            // Create a unique key for the participant pair
            const participants = conversation.participants
                .map(p => p.toString())
                .sort()
                .join('-');

            if (seen.has(participants)) {
                // Duplicate found - mark for deletion (keep the older one)
                toDelete.push(conversation._id.toString());
            } else {
                seen.set(participants, conversation._id.toString());
            }
        }

        // Delete duplicates
        if (toDelete.length > 0) {
            await Conversation.deleteMany({ _id: { $in: toDelete } });
        }

        return toDelete.length;
    }
}

export default new ConversationService();