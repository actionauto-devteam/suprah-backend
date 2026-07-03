import cron from 'node-cron';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';
import { getIO } from '../socket/supraspace.socket';
import logger from '../utils/logger';

async function emitScheduledMessage(messageId: string) {
  const message = await SupraSpaceMessage.findById(messageId)
    .populate('sender', 'fullName username avatar')
    .populate({ path: 'replyTo', populate: { path: 'sender', select: 'fullName username avatar' } });
  if (!message) return;

  const conversation = await SupraSpaceConversation.findById(message.conversationId);
  if (!conversation) return;

  conversation.lastMessage = message._id as any;
  conversation.lastMessageAt = message.sentAt || new Date();
  conversation.deletedFor = [];
  await conversation.save();

  const payload = { conversationId: conversation._id.toString(), message: message.toObject() };
  try {
    const io = getIO();
    (conversation.members || []).forEach((member: any) => {
      io.to(`user:${member.toString ? member.toString() : member}`).emit('message:new', payload);
    });
    io.to(`conv:${conversation._id.toString()}`).emit('message:new', payload);
  } catch (error) {
    logger.warn({ error }, '[SupraSpaceSchedule] Socket emit failed');
  }
}

export async function releaseDueSupraSpaceMessages(): Promise<void> {
  const due = await SupraSpaceMessage.find({
    scheduledStatus: 'pending',
    scheduledAt: { $lte: new Date() },
    isDeleted: false,
  })
    .select('_id')
    .sort({ scheduledAt: 1 })
    .limit(50)
    .lean();

  for (const item of due) {
    const now = new Date();
    const claimed = await SupraSpaceMessage.findOneAndUpdate(
      { _id: item._id, scheduledStatus: 'pending' },
      { $set: { scheduledStatus: 'sent', sentAt: now, createdAt: now } },
      { new: true },
    ).select('_id');

    if (claimed?._id) await emitScheduledMessage(claimed._id.toString());
  }
}

export function initSupraSpaceScheduledMessageScheduler(): void {
  cron.schedule('* * * * *', async () => {
    try {
      await releaseDueSupraSpaceMessages();
    } catch (error) {
      logger.error({ error }, '[SupraSpaceSchedule] Release failed');
    }
  });
  logger.info('[SupraSpaceSchedule] Scheduler initialized');
}
