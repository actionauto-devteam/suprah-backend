import 'dotenv/config';
import mongoose from 'mongoose';
import SupraSpaceConversation from '../models/SupraSpaceConversation.model';
import SupraSpaceMessage from '../models/SupraSpaceMessage.model';

const APPLY = process.argv.includes('--apply');
const NORMAL_NAME = 'Online Team Reports';
const REPORT_NAME = 'DayPulse Reports';
const DEFAULT_RESTORE_ID = '6a31d8e572847980fd9a8ce1';
const restoreId = process.env.ONLINE_TEAM_REPORTS_RESTORE_ID || DEFAULT_RESTORE_ID;

function isDayPulseReportContent(content?: string | null): boolean {
  const text = (content || '').trim();
  return (
    /^Department\s*-/i.test(text) &&
    /\nName\s*-/i.test(text) &&
    /\*\*Accomplishments\*\*/i.test(text) &&
    /\*\*Blockers\*\*/i.test(text) &&
    /\*\*In Progress\*\*/i.test(text)
  );
}

async function recomputeLastMessage(conversation: any) {
  const latest = await SupraSpaceMessage.findOne({
    conversationId: conversation._id,
    isDeleted: false,
  })
    .sort({ createdAt: -1 })
    .select('_id createdAt')
    .lean();

  conversation.lastMessage = (latest?._id || null) as any;
  conversation.lastMessageAt = latest?.createdAt || undefined;
}

async function run() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    console.error('MONGODB_URI (or MONGO_URI) is not set.');
    process.exit(1);
  }

  await mongoose.connect(uri);

  const normalConversation = await SupraSpaceConversation.findById(restoreId);
  if (!normalConversation) {
    console.error(`Restore conversation ${restoreId} was not found.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const messages = await SupraSpaceMessage.find({
    conversationId: normalConversation._id,
    isDeleted: false,
  })
    .select('_id content createdAt')
    .sort({ createdAt: 1 })
    .lean();

  const reportMessages = messages.filter((message) => isDayPulseReportContent(message.content));
  const normalMessages = messages.filter((message) => !isDayPulseReportContent(message.content));

  let reportConversation = await SupraSpaceConversation.findOne({
    _id: { $ne: normalConversation._id },
    type: 'group',
    name: { $regex: /^DayPulse Reports$/i },
    isActive: true,
  });

  if (!reportConversation) {
    reportConversation = new SupraSpaceConversation({
      type: 'group',
      name: REPORT_NAME,
      members: normalConversation.members,
      admins: normalConversation.admins?.length ? normalConversation.admins : [normalConversation.createdBy],
      createdBy: normalConversation.createdBy,
      isActive: true,
      deletedFor: [],
    });
  }

  console.log(`Normal channel to restore: ${normalConversation._id} "${normalConversation.name}" -> "${NORMAL_NAME}"`);
  console.log(`Report channel target: ${reportConversation._id || '(new)'} "${reportConversation.name || REPORT_NAME}"`);
  console.log(`Messages currently in normal channel: ${messages.length}`);
  console.log(`DayPulse report messages to move: ${reportMessages.length}`);
  console.log(`Normal chat messages to keep: ${normalMessages.length}`);
  reportMessages.slice(0, 10).forEach((message, index) => {
    const preview = String(message.content || '').replace(/\s+/g, ' ').slice(0, 140);
    console.log(`${index + 1}. ${message._id} | ${message.createdAt?.toISOString?.() || message.createdAt} | ${preview}`);
  });
  if (reportMessages.length > 10) console.log(`...and ${reportMessages.length - 10} more report message(s).`);

  if (!APPLY) {
    console.log('Dry run only. Re-run with --apply to restore the normal channel and move DayPulse messages.');
    await mongoose.disconnect();
    process.exit(0);
  }

  normalConversation.name = NORMAL_NAME;
  normalConversation.isActive = true;
  normalConversation.deletedAt = null;
  await normalConversation.save({ validateModifiedOnly: true });

  reportConversation.name = REPORT_NAME;
  reportConversation.members = normalConversation.members;
  reportConversation.admins = normalConversation.admins?.length ? normalConversation.admins : [normalConversation.createdBy];
  reportConversation.createdBy = reportConversation.createdBy || normalConversation.createdBy;
  reportConversation.isActive = true;
  reportConversation.deletedAt = null;
  reportConversation.deletedFor = [];
  await reportConversation.save({ validateModifiedOnly: true });

  if (reportMessages.length) {
    await SupraSpaceMessage.updateMany(
      { _id: { $in: reportMessages.map((message) => message._id) } },
      { $set: { conversationId: reportConversation._id } },
    );
  }

  await recomputeLastMessage(normalConversation);
  await normalConversation.save({ validateModifiedOnly: true });

  await recomputeLastMessage(reportConversation);
  await reportConversation.save({ validateModifiedOnly: true });

  console.log(`Moved ${reportMessages.length} DayPulse report message(s) to ${REPORT_NAME}.`);
  console.log(`Restored ${NORMAL_NAME} as active normal chat.`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
