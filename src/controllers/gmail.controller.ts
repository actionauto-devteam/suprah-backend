import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import gmailService from '../services/gmail.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';

/**
 * Check Gmail connection status
 */
const getConnectionStatus = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  
  const isConnected = await gmailService.isGmailConnected(userId);
  
  res.json(
    new ApiResponse(200, { connected: isConnected }, 'Gmail connection status fetched')
  );
});

/**
 * Send email via Gmail
 */
const sendEmail = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const { to, subject, body, conversationId } = req.body;

  if (!to || !subject || !body) {
    return res.status(400).json(
      new ApiResponse(400, null, 'To, subject, and body are required')
    );
  }

  const result = await gmailService.sendEmail(userId, to, subject, body, conversationId);

  res.json(
    new ApiResponse(200, result, 'Email sent successfully')
  );
});

/**
 * Fetch emails from Gmail
 */
const fetchEmails = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const { query, maxResults } = req.query;

  const emails = await gmailService.fetchEmails(
    userId,
    query as string,
    maxResults ? parseInt(maxResults as string) : 50
  );

  res.json(
    new ApiResponse(200, { emails, count: emails.length }, 'Emails fetched successfully')
  );
});

/**
 * Sync Gmail conversations
 */
const syncConversations = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;

  const result = await gmailService.syncGmailConversations(userId, orgId);

  res.json(
    new ApiResponse(200, result, 'Gmail conversations synced successfully')
  );
});

/**
 * Create conversation with external email
 */
const createExternalConversation = asyncHandler(async (req: Request, res: Response) => {
  const userId = (req.user as IUser)._id.toString();
  const orgId = req.orgId as string;
  const { email, name } = req.body;

  if (!email) {
    return res.status(400).json(
      new ApiResponse(400, null, 'Email is required')
    );
  }

  const conversation = await gmailService.createExternalConversation(
    userId,
    orgId,
    email,
    name
  );

  res.status(201).json(
    new ApiResponse(201, conversation, 'External conversation created successfully')
  );
});

/**
 * Link conversation to customer booking
 */
const linkToCustomerBooking = asyncHandler(async (req: Request, res: Response) => {
  const { conversationId } = req.params;
  const orgId = req.orgId as string;
  const { email } = req.body;

  if (!email) {
    return res.status(400).json(
      new ApiResponse(400, null, 'Email is required')
    );
  }

  await gmailService.linkConversationToCustomerBooking(conversationId, email, orgId);

  res.json(
    new ApiResponse(200, null, 'Conversation linked to customer booking')
  );
});

export default {
  getConnectionStatus,
  sendEmail,
  fetchEmails,
  syncConversations,
  createExternalConversation,
  linkToCustomerBooking
};