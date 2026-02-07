import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import conversationService from '../services/conversation.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';

const createConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;

  const conversation = await conversationService.createConversation(userId, orgId, req.body);

  res.status(201).json(
    new ApiResponse(201, conversation, 'Conversation created successfully')
  );
});

const getUserConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;

  const options = {
    type: req.query.type as string,
    includeArchived: req.query.includeArchived === 'true',
    limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
    skip: req.query.skip ? parseInt(req.query.skip as string) : undefined,
  };

  const result = await conversationService.getUserConversations(userId, orgId, options);

  res.json(
    new ApiResponse(200, result, 'Conversations retrieved successfully')
  );
});

const getConversationById = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { conversationId } = req.params;

  const conversation = await conversationService.getConversationById(
    conversationId,
    userId,
    orgId
  );

  res.json(
    new ApiResponse(200, conversation, 'Conversation retrieved successfully')
  );
});

const sendMessage = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { conversationId } = req.params;

  const conversation = await conversationService.sendMessage(
    conversationId,
    userId,
    orgId,
    req.body
  );

  // Emit socket event for real-time updates
  const io = (req as any).io;
  if (io) {
    io.to(`conversation:${conversationId}`).emit('new_message', {
      conversationId,
      message: conversation.messages[conversation.messages.length - 1],
    });
  }

  res.status(201).json(
    new ApiResponse(201, conversation, 'Message sent successfully')
  );
});

const addExternalEmail = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { conversationId } = req.params;
  const { email } = req.body;

  const conversation = await conversationService.addExternalEmail(
    conversationId,
    userId,
    orgId,
    email
  );

  res.json(
    new ApiResponse(200, conversation, 'External email added successfully')
  );
});

const markAsRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { conversationId } = req.params;

  await conversationService.markAsRead(conversationId, userId, orgId);

  res.json(
    new ApiResponse(200, null, 'Conversation marked as read')
  );
});

const archiveConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { conversationId } = req.params;

  const conversation = await conversationService.archiveConversation(
    conversationId,
    userId,
    orgId
  );

  res.json(
    new ApiResponse(200, conversation, 'Conversation archived successfully')
  );
});

const syncGmailInbox = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;

  const syncedCount = await conversationService.syncGmailInbox(userId, orgId);

  res.json(
    new ApiResponse(200, { syncedCount }, 'Gmail inbox synced successfully')
  );
});

const getConversationsForBooking = asyncHandler(async (req: Request, res: Response) => {
  const orgId = req.orgId as string;
  const { appointmentId } = req.params;

  const conversations = await conversationService.getConversationsForCustomerBooking(
    appointmentId,
    orgId
  );

  res.json(
    new ApiResponse(200, { conversations }, 'Customer conversations retrieved successfully')
  );
});

export default {
  createConversation,
  getUserConversations,
  getConversationById,
  sendMessage,
  addExternalEmail,
  markAsRead,
  archiveConversation,
  syncGmailInbox,
  getConversationsForBooking,
};