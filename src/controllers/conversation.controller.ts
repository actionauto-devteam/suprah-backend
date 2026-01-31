// controllers/conversation.controller.ts

import { Request, Response } from 'express';
import { asyncHandler } from '../utils/asyncHandler';
import conversationService from '../services/conversation.service';
import { ApiResponse } from '../utils/ApiResponse';
import { IUser } from '../models/User.model';

const createConversation = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const conversation = await conversationService.createConversation(userId, req.body);
    
    res.status(201).json(
        new ApiResponse(201, conversation, 'Conversation created successfully')
    );
});

const getConversations = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { hasAppointment, includeArchived } = req.query;
    
    const options: any = {};
    if (hasAppointment !== undefined) options.hasAppointment = hasAppointment === 'true';
    if (includeArchived !== undefined) options.includeArchived = includeArchived === 'true';
    
    const conversations = await conversationService.getUserConversations(userId, options);
    
    res.json(
        new ApiResponse(200, conversations, 'Conversations fetched successfully')
    );
});

const sendMessage = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    const conversation = await conversationService.sendMessage(id, userId, req.body);
    
    res.json(
        new ApiResponse(200, conversation, 'Message sent successfully')
    );
});

const markAsRead = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    await conversationService.markAsRead(id, userId);
    
    res.json(
        new ApiResponse(200, null, 'Messages marked as read')
    );
});

const deleteConversation = asyncHandler(async (req: Request, res: Response) => {
    const userId = (req.user as IUser)._id.toString();
    const { id } = req.params;
    
    await conversationService.deleteConversation(id, userId);
    
    res.json(
        new ApiResponse(200, null, 'Conversation deleted successfully')
    );
});

export default {
    createConversation,
    getConversations,
    sendMessage,
    markAsRead,
    deleteConversation
};