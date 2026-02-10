import Conversation, { IConversation } from '../models/Conversation.model';
import Appointment from '../models/Appointment.model';
import gmailConversationService from './gmailConversation.service';
import { ApiError } from '../utils/ApiError';
import mongoose from 'mongoose';

interface CreateConversationData {
  type: 'direct' | 'group' | 'channel' | 'external';
  name?: string;
  participants: string[];
  externalEmails?: string[];
  subject?: string;
}

interface SendMessageData {
  content: string;
  type?: 'text' | 'appointment' | 'file' | 'email';
  metadata?: any;
}

const createConversation = async (
  userId: string,
  orgId: string,
  data: CreateConversationData
): Promise<IConversation> => {
  console.log('[conversationService] Creating conversation:', { userId, orgId, data });

  // Ensure creator is in participants
  const participants = [...new Set([userId, ...data.participants])];

  const externalEmails = (data.externalEmails || []).map(email => ({
    email: email.toLowerCase().trim(),
    addedAt: new Date(),
  }));

  const conversation = await Conversation.create({
    type: data.type,
    name: data.name,
    participants,
    externalEmails,
    organizationId: orgId, // This is now a string (Clerk org ID)
    createdBy: userId,
    metadata: {
      subject: data.subject,
    },
  });

  console.log('[conversationService] Conversation created:', conversation._id);

  return conversation.populate('participants', 'name email avatar');
};

const getUserConversations = async (
  userId: string,
  orgId: string,
  options: {
    type?: string;
    includeArchived?: boolean;
    limit?: number;
    skip?: number;
  } = {}
): Promise<{ conversations: IConversation[]; total: number }> => {
  console.log('[conversationService] Fetching conversations for user:', userId, 'org:', orgId);

  const filter: any = {
    organizationId: orgId, // Now compared as string
    $or: [
      { participants: userId },
      { 'externalEmails.email': { $exists: true } },
    ],
  };

  if (options.type) {
    filter.type = options.type;
  }

  if (!options.includeArchived) {
    filter.isArchived = { $ne: true };
  }

  try {
    const conversations = await Conversation.find(filter)
      .populate('participants', 'name email avatar')
      .populate('createdBy', 'name email avatar')
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(options.limit || 100)
      .skip(options.skip || 0);

    const total = await Conversation.countDocuments(filter);

    console.log('[conversationService] Found conversations:', conversations.length);

    return { conversations, total };
  } catch (error) {
    console.error('[conversationService] Error fetching conversations:', error);
    throw error;
  }
};

const getConversationById = async (
  conversationId: string,
  userId: string,
  orgId: string
): Promise<IConversation> => {
  console.log('[conversationService] Fetching conversation:', conversationId);

  const conversation = await Conversation.findOne({
    _id: conversationId,
    organizationId: orgId, // String comparison
  })
    .populate('participants', 'name email avatar')
    .populate('messages.sender', 'name email avatar')
    .populate('createdBy', 'name email avatar');

  if (!conversation) {
    throw new ApiError(404, 'Conversation not found');
  }

  // Check access
  const hasAccess =
    conversation.participants.some((p: any) => p._id.toString() === userId) ||
    conversation.createdBy.toString() === userId;

  if (!hasAccess) {
    throw new ApiError(403, 'Not authorized to view this conversation');
  }

  return conversation;
};

const sendMessage = async (
  conversationId: string,
  userId: string,
  orgId: string,
  data: SendMessageData
): Promise<IConversation> => {
  console.log('[conversationService] Sending message to conversation:', conversationId);

  const conversation = await getConversationById(conversationId, userId, orgId);

  const message: any = {
    _id: new mongoose.Types.ObjectId().toString(),
    sender: userId,
    content: data.content,
    type: data.type || 'text',
    metadata: data.metadata,
    isFromExternal: false,
    readBy: [userId],
    createdAt: new Date(),
  };

  conversation.messages.push(message);
  conversation.lastMessage = data.content;
  conversation.lastMessageAt = new Date();
  conversation.lastMessageBy = userId;

  await conversation.save();

  // If conversation has external emails, send via Gmail
  if (conversation.type === 'external' && conversation.externalEmails.length > 0) {
    try {
      for (const external of conversation.externalEmails) {
        const subject = conversation.metadata?.subject || 'Message from Action Auto';
        
        const result = await gmailConversationService.sendEmailToExternal(
          userId,
          external.email,
          subject,
          data.content,
          conversation.gmailThreadId
        );

        // Update Gmail thread ID if this is first email
        if (!conversation.gmailThreadId && result.threadId) {
          conversation.gmailThreadId = result.threadId;
          external.gmailThreadId = result.threadId;
          await conversation.save();
        }

        // Update message metadata with Gmail info
        message.metadata = {
          ...message.metadata,
          gmailMessageId: result.messageId,
          emailThreadId: result.threadId,
        };
        await conversation.save();
      }
    } catch (error) {
      console.error('[conversationService] Failed to send email to external recipients:', error);
      // Don't throw - message is still saved locally
    }
  }

  return conversation.populate('participants messages.sender', 'name email avatar');
};

const addExternalEmail = async (
  conversationId: string,
  userId: string,
  orgId: string,
  email: string
): Promise<IConversation> => {
  const conversation = await getConversationById(conversationId, userId, orgId);

  const normalizedEmail = email.toLowerCase().trim();

  // Check if email already exists
  const emailExists = conversation.externalEmails.some(
    (e: any) => e.email === normalizedEmail
  );

  if (emailExists) {
    throw new ApiError(400, 'Email already in conversation');
  }

  // Check if this email belongs to a customer booking
  const linkedBookings = await Appointment.find({
    organizationId: orgId, // String comparison
    'customerBooking.isCustomerBooking': true,
    'customerBooking.email': normalizedEmail,
  }).select('_id');

  // Add external email
  conversation.externalEmails.push({
    email: normalizedEmail,
    addedAt: new Date(),
  } as any);

  // Link customer bookings if found
  if (linkedBookings.length > 0) {
    const bookingIds = linkedBookings.map(b => b._id.toString());
    conversation.linkedCustomerBookings = [
      ...new Set([...conversation.linkedCustomerBookings.map(String), ...bookingIds]),
    ] as any;
  }

  await conversation.save();

  return conversation;
};

const markAsRead = async (
  conversationId: string,
  userId: string,
  orgId: string
): Promise<void> => {
  const conversation = await Conversation.findOne({
    _id: conversationId,
    organizationId: orgId, // String comparison
  });

  if (!conversation) {
    throw new ApiError(404, 'Conversation not found');
  }

  // Mark all messages as read by this user
  conversation.messages.forEach((message: any) => {
    if (!message.readBy.includes(userId)) {
      message.readBy.push(userId);
    }
  });

  await conversation.save();
};

const archiveConversation = async (
  conversationId: string,
  userId: string,
  orgId: string
): Promise<IConversation> => {
  const conversation = await getConversationById(conversationId, userId, orgId);

  if (conversation.createdBy.toString() !== userId) {
    throw new ApiError(403, 'Only the creator can archive this conversation');
  }

  conversation.isArchived = true;
  await conversation.save();

  return conversation;
};

const syncGmailInbox = async (
  userId: string,
  orgId: string
): Promise<number> => {
  console.log('[conversationService] Syncing Gmail inbox for user:', userId, 'org:', orgId);
  
  try {
    const syncedCount = await gmailConversationService.syncInboxToConversations(
      userId,
      orgId
    );
    console.log('[conversationService] Gmail sync completed. Synced:', syncedCount);
    return syncedCount;
  } catch (error) {
    console.error('[conversationService] Failed to sync Gmail inbox:', error);
    throw error;
  }
};

const getConversationsForCustomerBooking = async (
  appointmentId: string,
  orgId: string
): Promise<IConversation[]> => {
  console.log('[conversationService] Getting conversations for booking:', appointmentId);

  const conversations = await Conversation.find({
    organizationId: orgId, // String comparison
    linkedCustomerBookings: appointmentId,
  })
    .populate('participants', 'name email avatar')
    .populate('messages.sender', 'name email avatar')
    .sort({ lastMessageAt: -1 });

  return conversations;
};

export default {
  createConversation,
  getUserConversations,
  getConversationById,
  sendMessage,
  addExternalEmail,
  markAsRead,
  archiveConversation,
  syncGmailInbox,
  getConversationsForCustomerBooking,
};