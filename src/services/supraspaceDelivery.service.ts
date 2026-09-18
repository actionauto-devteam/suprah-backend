import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import { ApiError } from '../utils/ApiError';

export function validateClientMessageId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new ApiError(400, 'Invalid message identifier');
  return value;
}

export async function createSupraSpaceMessageOnce(data: Record<string, unknown>, clientMessageId?: string) {
  const replay = async () => {
    const message = clientMessageId ? await SupraSpaceMessage.findById(clientMessageId) : null;
    if (!message) return null;
    if (message.isDeleted || String(message.sender) !== String(data.sender) || String(message.conversationId) !== String(data.conversationId)
      || message.content !== data.content || String(message.replyTo || '') !== String(data.replyTo || '')
      || message.type !== data.type) {
      throw new ApiError(409, 'This message identifier is already in use');
    }
    return { message, created: false };
  };
  const existing = await replay();
  if (existing) return existing;
  try {
    const message = await SupraSpaceMessage.create({ ...data, ...(clientMessageId ? { _id: clientMessageId } : {}) });
    return { message, created: true };
  } catch (error) {
    if (clientMessageId && (error as { code?: number }).code === 11000) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw error;
  }
}
