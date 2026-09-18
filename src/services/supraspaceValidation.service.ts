import mongoose from 'mongoose';
import CrmUser from '../models/CrmUser.model';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import { ApiError } from '../utils/ApiError';

export async function validateSupraSpaceMembers(value: unknown, organizationId: unknown) {
  if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string' || !mongoose.isValidObjectId(id))) {
    throw new ApiError(400, 'Invalid conversation members');
  }
  const ids = [...new Set(value as string[])];
  const count = await CrmUser.countDocuments({ _id: { $in: ids }, organizationId, isActive: true });
  if (count !== ids.length) throw new ApiError(403, 'Members must belong to your organization');
  return ids;
}

export async function validateSupraSpaceReply(replyTo: unknown, conversationId: string) {
  if (!replyTo) return;
  if (typeof replyTo !== 'string' || !mongoose.isValidObjectId(replyTo)) throw new ApiError(400, 'Invalid reply');
  const message = await SupraSpaceMessage.exists({ _id: replyTo, conversationId, isDeleted: false, scheduledStatus: { $ne: 'pending' } });
  if (!message) throw new ApiError(400, 'Reply must reference a message in this conversation');
}

export async function resolveSupraSpaceAttachments(value: unknown, userId: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 10) throw new ApiError(400, 'Invalid attachments');
  const references = value.map(attachment => {
    if (!attachment || typeof attachment !== 'object') return '';
    if (typeof attachment.fileKey === 'string') return attachment.fileKey;
    return typeof attachment.url === 'string' ? attachment.url : '';
  });
  if (references.some(reference => !reference || reference.startsWith('file:') || reference.startsWith('blob:'))) {
    throw new ApiError(400, 'Invalid attachment reference');
  }
  if (!references.length) return [];
  const conversations = await SupraSpaceConversation.find({ members: userId, isActive: true }).select('_id').lean();
  const messages = await SupraSpaceMessage.find({
    conversationId: { $in: conversations.map(item => item._id) },
    isDeleted: false,
    $or: [
      { 'attachments.fileKey': { $in: references } },
      { 'attachments.url': { $in: references } },
    ],
  }).select('attachments').lean();
  const attachments = messages.flatMap(message => message.attachments);
  return references.map(reference => {
    const attachment = attachments.find(item => item.fileKey === reference || item.url === reference);
    if (!attachment) throw new ApiError(403, 'Attachment is not accessible');
    return { ...attachment, url: attachment.fileKey || attachment.url };
  });
}
